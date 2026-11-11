/*
 * devhub-exec-clean: run a program with nothing open but its stdin, stdout
 * and stderr.
 *
 *   devhub-exec-clean [--die-with <pid>] <path> <argv0> [args...]
 *
 * Every descriptor above 2 is marked close-on-exec, then <path> is executed
 * with argv[0] = <argv0>. The program it runs is the same process (same pid,
 * same process group), so whoever started this waits for, signals and reads
 * the program exactly as if it had started it directly.
 *
 * Why it exists: Node's `spawn` (libuv) on Linux forks and execs without
 * closing what the parent had open, so a descriptor of the parent's that is
 * not close-on-exec is inherited by every child, and by every child of those.
 * Electron's processes have such descriptors — main's `--remote-debugging-port`
 * listening socket, Chromium's shared-memory and snapshot files, a utility
 * process's own channel — and DevHub's tmux server, started by a short-lived
 * `tmux` command, lives for days holding them: the next DevHub could not bind
 * the debugging port while it lived (docs/process-model.md, finding 9).
 * node-pty already does this for the PTYs it opens; this is the same for
 * everything started through `child_process` (`main/terminal/cleanSpawn.ts`).
 *
 * If the exec fails, the reason is said on stderr and the exit status is 127
 * (not found) or 126 (anything else), as a shell would. Callers only route
 * through this once they have found the program, so that is a race, not the
 * way a missing program is reported.
 *
 * `--die-with <pid>`: the program ends (SIGKILL) when the process <pid>,
 * which must be the one that started this, ends — however it ends, SIGKILL
 * included. A tmux control client (`tmux -C`) on pipes is meant to end when
 * its stdin closes, but tmux reads that stdin only once the client's attach
 * is done, and a client that had output queued for a reader that is gone is
 * never let go by the server (`server_client_check_exit` waits for
 * `control_all_done`, which a dead stdout never gives): it stayed attached,
 * with its size, after the pty host that owned it was gone. Its owner's end
 * is now the kernel's to say, not tmux's:
 *
 * - Linux: prctl(PR_SET_PDEATHSIG, SIGKILL), which survives the exec. It is
 *   said when the thread that started this ends; Node starts children from
 *   its main thread, which lives as long as the process.
 * - macOS (and the BSDs): no such signal, so a watchdog: a child of the
 *   program, with nothing open, that waits on kqueue for <pid> or the program
 *   to exit and SIGKILLs the program in the first case.
 *
 * If <pid> is already gone (it is no longer this process's parent), the
 * program is not started: the exit status is 125.
 *
 * Plain POSIX plus Linux's close_range and prctl, and kqueue elsewhere.
 */

#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
#if defined(__linux__)
#include <sys/prctl.h>
#include <sys/syscall.h>
#elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
#include <sys/event.h>
#define HAVE_KQUEUE 1
#endif

#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif

static void mark_cloexec_from(int lowest) {
#if defined(__linux__) && defined(SYS_close_range)
	if (syscall(SYS_close_range, (unsigned)lowest, ~0U, CLOSE_RANGE_CLOEXEC) == 0) {
		return;
	}
#endif
	/* Older kernels: every descriptor the process has, as the kernel lists
	 * them. The directory's own descriptor is marked as well, which is
	 * harmless: it is closed before the exec. */
#if defined(__linux__)
	const char *listing = "/proc/self/fd";
#else
	const char *listing = "/dev/fd";
#endif
	DIR *dir = opendir(listing);
	if (dir != NULL) {
		struct dirent *entry;
		while ((entry = readdir(dir)) != NULL) {
			char *end = NULL;
			long fd = strtol(entry->d_name, &end, 10);
			if (end == entry->d_name || *end != '\0' || fd < lowest) continue;
			int flags = fcntl((int)fd, F_GETFD);
			if (flags >= 0) fcntl((int)fd, F_SETFD, flags | FD_CLOEXEC);
		}
		closedir(dir);
		return;
	}
	/* No listing at all: every number up to the limit. */
	long max = sysconf(_SC_OPEN_MAX);
	if (max < 0 || max > 65536) max = 65536;
	for (int fd = lowest; fd < max; fd++) {
		int flags = fcntl(fd, F_GETFD);
		if (flags >= 0) fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
	}
}

#if defined(HAVE_KQUEUE)
/* The watchdog: a child of the program-to-be (`program`), holding nothing of
 * it, that kills it when `owner` exits and goes when it does. */
static void watch(pid_t owner, pid_t program) {
	long max = sysconf(_SC_OPEN_MAX);
	if (max < 0 || max > 65536) max = 65536;
	for (int fd = 0; fd < max; fd++) close(fd);
	int null = open("/dev/null", O_RDWR);
	if (null >= 0) {
		dup2(null, 0);
		dup2(null, 1);
		dup2(null, 2);
		if (null > 2) close(null);
	}
	signal(SIGINT, SIG_IGN);
	signal(SIGHUP, SIG_IGN);
	int kq = kqueue();
	if (kq < 0) _exit(1);
	struct kevent change;
	EV_SET(&change, (uintptr_t)program, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
	if (kevent(kq, &change, 1, NULL, 0, NULL) < 0) _exit(0);
	/* After the program's watch, so a program that has gone meanwhile is seen
	 * as gone, never one whose pid was taken again. */
	if (getppid() != program) _exit(0);
	EV_SET(&change, (uintptr_t)owner, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
	if (kevent(kq, &change, 1, NULL, 0, NULL) < 0) {
		/* ESRCH: the owner is already gone. */
		kill(program, SIGKILL);
		_exit(0);
	}
	for (;;) {
		struct kevent event;
		int n = kevent(kq, NULL, 0, &event, 1, NULL);
		if (n < 0 && errno == EINTR) continue;
		if (n < 0) _exit(1);
		if (n == 0) continue;
		if ((pid_t)event.ident == owner) kill(program, SIGKILL);
		_exit(0);
	}
}
#endif

/* Tie this process (and the program it becomes) to `owner`'s life. */
static int die_with(pid_t owner) {
#if defined(__linux__)
	if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) return -1;
	/* Set after the fork: an owner that ended before it is not signalled for. */
	if (getppid() != owner) return 1;
	return 0;
#elif defined(HAVE_KQUEUE)
	if (getppid() != owner) return 1;
	pid_t program = getpid();
	pid_t watchdog = fork();
	if (watchdog < 0) return -1;
	if (watchdog == 0) watch(owner, program);
	return 0;
#else
	(void)owner;
	return -1;
#endif
}

static void usage(void) {
	fputs("usage: devhub-exec-clean [--die-with <pid>] <path> <argv0> [args...]\n", stderr);
}

int main(int argc, char **argv) {
	int first = 1;
	if (argc > 1 && strcmp(argv[1], "--die-with") == 0) {
		if (argc < 3) {
			usage();
			return 2;
		}
		char *end = NULL;
		long owner = strtol(argv[2], &end, 10);
		if (end == argv[2] || *end != '\0' || owner <= 1) {
			usage();
			return 2;
		}
		int tied = die_with((pid_t)owner);
		if (tied > 0) return 125;
		if (tied < 0)
			fprintf(stderr, "devhub-exec-clean: cannot tie to %ld: %s\n", owner, strerror(errno));
		first = 3;
	}
	if (argc - first < 2) {
		usage();
		return 2;
	}
	mark_cloexec_from(STDERR_FILENO + 1);
	char *path = argv[first];
	execv(path, &argv[first + 1]);
	int error = errno;
	fprintf(stderr, "devhub-exec-clean: %s: %s\n", path, strerror(error));
	return error == ENOENT ? 127 : 126;
}
