#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t stopping = 0;

static void stop_handler(int signal_number) {
    (void)signal_number;
    stopping = 1;
}

static const char *basename_of(const char *path) {
    const char *slash = strrchr(path, '/');
    return slash == NULL ? path : slash + 1;
}

int main(int argc, char **argv) {
    (void)argc;
    const char *trace_path = getenv("DEVHUB_HERDR_TRACE_FILE");
    const char *pid_dir = getenv("DEVHUB_HERDR_PID_DIR");
    const char *kind = basename_of(argv[0]);
    char pid_path[4096];
    char line[4096];
    FILE *trace;
    FILE *pid;

    if ((strcmp(kind, "codex") != 0 && strcmp(kind, "claude") != 0)
        || trace_path == NULL || pid_dir == NULL) {
        return 2;
    }
    (void)snprintf(pid_path, sizeof(pid_path), "%s/%s.%ld.pid", pid_dir, kind,
                   (long)getpid());
    pid = fopen(pid_path, "w");
    if (pid == NULL) return 3;
    (void)fprintf(pid, "%ld\n", (long)getpid());
    (void)fclose(pid);
    trace = fopen(trace_path, "a");
    if (trace == NULL) {
        (void)unlink(pid_path);
        return 4;
    }
    (void)fprintf(trace, "kind=%s PATH=%s\n", kind,
                  getenv("PATH") == NULL ? "" : getenv("PATH"));
    (void)fflush(trace);
    (void)fclose(trace);
    (void)signal(SIGTERM, stop_handler);
    (void)signal(SIGINT, stop_handler);
    (void)signal(SIGHUP, stop_handler);
    setvbuf(stdout, NULL, _IOLBF, 0);
    (void)printf("DEVHUB_HERDR_%s_READY\n",
                 strcmp(kind, "codex") == 0 ? "CODEX" : "CLAUDE");
    while (!stopping && fgets(line, sizeof(line), stdin) != NULL) {
        (void)printf("DEVHUB_HERDR_%s_INPUT:%s",
                     strcmp(kind, "codex") == 0 ? "CODEX" : "CLAUDE", line);
        if (strchr(line, '\n') == NULL) (void)fputc('\n', stdout);
    }
    (void)unlink(pid_path);
    return 0;
}
