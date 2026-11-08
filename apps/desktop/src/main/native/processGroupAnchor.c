/*
 * devhub-pgrp-anchor: keep DevHub's process group from ever being orphaned.
 *
 * DevHub freezes hidden workbenches with SIGSTOP, and every process it stops
 * — the renderer, the extension hosts, their language servers — is in the
 * process group of DevHub's main process. POSIX has a rule about that group:
 * when it becomes *orphaned* (no member has a parent in another process group
 * of the same session) while one of its members is stopped, the kernel sends
 * every member SIGHUP and then SIGCONT. DevHub's main process is launched as
 * a session and group leader, so its group is orphaned from the start, and
 * the kernel re-checks it whenever a process that could have qualified it
 * exits — a tool that moved itself into a group of its own and left a child
 * behind is enough. Electron answers SIGHUP by quitting, so DevHub closed
 * itself, exit status 0, a few seconds after the first workbench was frozen.
 * See `apps/desktop/src/main/shell/processGroupAnchor.ts`.
 *
 * The group is "not orphaned" as long as one of its members has a parent in
 * another group of the same session. This program makes that member and
 * holds it:
 *
 *   - it is started by DevHub's main process, so it starts in DevHub's group;
 *   - it forks the *keeper*, which stays in DevHub's group;
 *   - it then moves itself into a new process group of its own (same
 *     session), so the keeper is a member of DevHub's group whose parent is
 *     in another group of the session — which is what the kernel counts.
 *
 * Both then wait. The anchor reads its stdin, a pipe DevHub's main holds the
 * other end of, and exits when it reads end-of-file: when DevHub has gone.
 * The keeper reads a pipe whose only writer is the anchor, so it ends only
 * after the anchor has. Neither does anything else, and neither is a
 * workbench's, so neither is ever frozen.
 *
 * Plain POSIX, so the same file builds on Linux, where DevHub's tests run.
 */

#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif

/*
 * Close everything but stdin, stdout and stderr.
 *
 * This process lives as long as DevHub and is started straight from main,
 * whose descriptors that are not close-on-exec it would otherwise hold for
 * all that time — main's `--remote-debugging-port` listening socket among
 * them, which kept the next DevHub from binding the port while an anchor of
 * the last one lived (docs/process-model.md, finding 9).
 */
static void close_inherited(void) {
#if defined(__linux__) && defined(SYS_close_range)
	if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) return;
#endif
#if defined(__linux__)
	const char *listing = "/proc/self/fd";
#else
	const char *listing = "/dev/fd";
#endif
	DIR *dir = opendir(listing);
	if (dir == NULL) return;
	int own = dirfd(dir);
	int open_fds[1024];
	int count = 0;
	struct dirent *entry;
	while ((entry = readdir(dir)) != NULL && count < 1024) {
		char *end = NULL;
		long fd = strtol(entry->d_name, &end, 10);
		if (end == entry->d_name || *end != '\0' || fd < 3 || fd == own) continue;
		open_fds[count++] = (int)fd;
	}
	closedir(dir);
	for (int i = 0; i < count; i++) close(open_fds[i]);
}

/* Until end-of-file (or an error other than an interrupted read). */
static void wait_for_eof(int fd) {
	char buffer[64];
	for (;;) {
		ssize_t n = read(fd, buffer, sizeof buffer);
		if (n > 0) continue;
		if (n < 0 && errno == EINTR) continue;
		return;
	}
}

int main(void) {
	close_inherited();
	/* The kernel's SIGHUP is the thing this exists to prevent; if it comes
	 * anyway (the group was orphaned before this started), it is not a
	 * reason for the anchor to let go. */
	signal(SIGHUP, SIG_IGN);

	int to_keeper[2];
	if (pipe(to_keeper) != 0) {
		perror("devhub-pgrp-anchor: pipe");
		return 1;
	}
	pid_t keeper = fork();
	if (keeper < 0) {
		perror("devhub-pgrp-anchor: fork");
		return 1;
	}
	if (keeper == 0) {
		close(to_keeper[1]);
		close(STDIN_FILENO);
		wait_for_eof(to_keeper[0]);
		return 0;
	}
	close(to_keeper[0]);
	if (setpgid(0, 0) != 0) {
		perror("devhub-pgrp-anchor: setpgid");
		return 1;
	}
	/* The line DevHub waits for: the keeper is in place. */
	printf("anchored %d %d\n", (int)getpid(), (int)keeper);
	fflush(stdout);
	wait_for_eof(STDIN_FILENO);
	return 0;
}
