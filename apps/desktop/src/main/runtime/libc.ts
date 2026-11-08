/**
 * Which C library a Linux machine runs on, asked over `sh`.
 *
 * The Node DevHub puts on a host for its own programs (the `devhub` command,
 * the terminal launcher's asking program) is nodejs.org's Linux build, which
 * is glibc's; a musl machine (Alpine) is refused by name before anything is
 * sent (`RemoteShellRuntime.terminalLauncher`).
 */

export const LIBC_PROBE = [
	`if [ -f /etc/alpine-release ]; then echo musl; exit 0; fi`,
	`if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then echo glibc; exit 0; fi`,
	`for f in /lib/ld-musl-*.so.1; do [ -e "$f" ] && { echo musl; exit 0; }; done`,
	`for f in /lib64/ld-linux-*.so.* /lib/ld-linux-*.so.* /lib/*/ld-linux-*.so.*; do [ -e "$f" ] && { echo glibc; exit 0; }; done`,
	`echo unknown`,
].join("\n");

export type Libc = "glibc" | "musl" | "unknown";

export function parseLibc(stdout: string): Libc {
	const answer = stdout.trim().split("\n").pop()?.trim();
	return answer === "glibc" || answer === "musl" ? answer : "unknown";
}
