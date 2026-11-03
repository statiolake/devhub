/*
 * devhub-footprint: every process's physical footprint, once.
 *
 * The Task Manager's memory column on macOS (see
 * `apps/desktop/src/main/shell/taskManagerReading.ts`). The resident set `ps`
 * reports misleads exactly when memory is short: a process whose pages were
 * compressed or swapped out has a small resident set and a large cost, and
 * pages shared by Electron's helpers are counted once per helper. The
 * footprint is what Activity Monitor's "Memory" column shows — what the
 * process costs this Mac, compressed and swapped pages included — and the
 * kernel keeps it per process (`proc_pid_rusage`, `ri_phys_footprint`).
 *
 * Beside it, the resident set (`ri_resident_size`): what of the process is in
 * RAM now. The part of the footprint the compressor holds is per process
 * only through the task's port (`TASK_VM_INFO`), which another process gets
 * only with an entitlement; the Task Manager shows "In RAM" as the resident
 * set, no more than the footprint, and says so (`docs/task-manager.md`).
 *
 * One line per process this user may read, `<pid> <footprint> <resident>`
 * in bytes, then exit:
 * one fork per Task Manager refresh, a few hundred system calls. A process
 * that cannot be read (another user's, or one that ended meanwhile) is left
 * out; the reading falls back to its resident set.
 */

#include <inttypes.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(void) {
	int estimate = proc_listallpids(NULL, 0);
	if (estimate <= 0) {
		perror("devhub-footprint: proc_listallpids");
		return 1;
	}
	/* Room for the processes that start between the two calls. */
	int capacity = estimate + 256;
	pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
	if (pids == NULL) {
		perror("devhub-footprint: calloc");
		return 1;
	}
	int count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
	if (count <= 0) {
		perror("devhub-footprint: proc_listallpids");
		free(pids);
		return 1;
	}
	if (count > capacity) count = capacity;
	for (int index = 0; index < count; index += 1) {
		pid_t pid = pids[index];
		if (pid <= 0) continue;
		struct rusage_info_v0 info;
		if (proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&info) != 0) {
			continue;
		}
		printf("%d %" PRIu64 " %" PRIu64 "\n", (int)pid, info.ri_phys_footprint,
		       info.ri_resident_size);
	}
	free(pids);
	return fflush(stdout) == 0 ? 0 : 1;
}
