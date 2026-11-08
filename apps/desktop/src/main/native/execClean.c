/*
 * devhub-exec-clean: run a program with nothing open but its stdin, stdout
 * and stderr.
 *
 *   devhub-exec-clean <path> <argv0> [args...]
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
 * Plain POSIX plus Linux's close_range where it exists.
 */

#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
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

int main(int argc, char **argv) {
	if (argc < 3) {
		fputs("usage: devhub-exec-clean <path> <argv0> [args...]\n", stderr);
		return 2;
	}
	mark_cloexec_from(STDERR_FILENO + 1);
	char *path = argv[1];
	execv(path, &argv[2]);
	int error = errno;
	fprintf(stderr, "devhub-exec-clean: %s: %s\n", path, strerror(error));
	return error == ENOENT ? 127 : 126;
}
