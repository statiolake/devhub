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

/**
 * The oldest glibc Neovim's official Linux release runs on: its `nvim` needs
 * `GLIBC_2.34` (`objdump -T`, 0.12.6 on both architectures).
 */
export const NEOVIM_MINIMUM_GLIBC: readonly [number, number] = [2, 34];

/** `getconf GNU_LIBC_VERSION` (`glibc 2.39`), or nothing where it cannot say. */
export const GLIBC_VERSION_PROBE =
	"getconf GNU_LIBC_VERSION 2>/dev/null; exit 0";

/** `[major, minor]` from `GLIBC_VERSION_PROBE`'s answer; `undefined` for none. */
export function parseGlibcVersion(
	stdout: string,
): readonly [number, number] | undefined {
	const found = /glibc\s+(\d+)\.(\d+)/i.exec(stdout);
	return found === null ? undefined : [Number(found[1]), Number(found[2])];
}

/** Whether `version` is at least `minimum`. */
function atLeast(
	version: readonly [number, number],
	minimum: readonly [number, number],
): boolean {
	return (
		version[0] > minimum[0] ||
		(version[0] === minimum[0] && version[1] >= minimum[1])
	);
}

export interface NeovimHostFacts {
	readonly machine: string;
	/** `uname -s`, `Linux`. */
	readonly platform: string;
	/** `architectureName`'s: `x64`, `arm64`. */
	readonly architecture: string;
	readonly libc: Libc;
	/** `parseGlibcVersion`'s; `undefined` where the machine cannot say. */
	readonly glibc: readonly [number, number] | undefined;
	/** The Neovim release DevHub delivers. */
	readonly version: string;
}

/**
 * Why DevHub's Neovim cannot be delivered to a machine, or `undefined` when
 * it can: what `product.json` pins for a host is Neovim's own Linux builds
 * for x86_64 and arm64, which need glibc `NEOVIM_MINIMUM_GLIBC`. A glibc that
 * cannot say its version is tried: the install asks what came out to run.
 */
export function neovimHostRefusal(facts: NeovimHostFacts): string | undefined {
	const { machine, version } = facts;
	if (
		facts.platform !== "Linux" ||
		(facts.architecture !== "x64" && facts.architecture !== "arm64")
	) {
		return `${machine} is ${facts.platform} ${facts.architecture}, and DevHub delivers its Neovim to Linux hosts on x86_64 and arm64 only`;
	}
	const needs = `Neovim ${version} DevHub installs there is Neovim's own Linux build, which needs glibc ${NEOVIM_MINIMUM_GLIBC.join(".")} or later`;
	if (facts.libc === "musl") {
		return `${machine} runs on musl (Alpine), and the ${needs}`;
	}
	if (
		facts.glibc !== undefined &&
		!atLeast(facts.glibc, NEOVIM_MINIMUM_GLIBC)
	) {
		return `${machine} has glibc ${facts.glibc.join(".")}, and the ${needs}`;
	}
	return undefined;
}
