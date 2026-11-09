/**
 * The `devhub` command as a static Go binary (`cli/`, docs/devhub-cli.md),
 * built from source into `out/cli/<os>-<arch>/devhub` for every platform
 * DevHub runs a `devhub` on: this Mac (darwin-arm64) and the Linux hosts it
 * reaches over SSH (linux-x64, linux-arm64). cgo is off, so each is one file
 * that cross-compiles from any machine and runs on glibc and musl alike.
 *
 * Nothing is downloaded and nothing is published: the packaged app carries
 * these in `Resources/app/out`, and a host is given the one for its platform
 * from there. `SHA256SUMS` beside them is what a delivery checks the bytes
 * against.
 *
 * Go is a build dependency, like the C compiler for `out/native`; unlike the
 * native helpers there is no build without it, because there is no DevHub
 * without its command. `go.mod` states the version (`GOTOOLCHAIN` fetches it
 * if the installed Go is older).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = fileURLToPath(new URL("../../../cli", import.meta.url));
const out = `${root}/out/cli`;

/** `<os>-<arch>` as DevHub names a platform, and Go's names for it. */
const TARGETS = [
  ["darwin-arm64", "darwin", "arm64"],
  ["linux-x64", "linux", "amd64"],
  ["linux-arm64", "linux", "arm64"],
];

rmSync(out, { recursive: true, force: true });
const sums = [];
for (const [platform, goos, goarch] of TARGETS) {
  const binary = `${out}/${platform}/devhub`;
  mkdirSync(`${out}/${platform}`, { recursive: true });
  try {
    execFileSync(
      "go",
      ["build", "-trimpath", "-ldflags=-s -w", "-o", binary, "."],
      {
        cwd: source,
        stdio: "inherit",
        env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
      },
    );
  } catch (error) {
    throw new Error(
      error.code === "ENOENT"
        ? "building the devhub command needs Go (https://go.dev/dl/); cli/go.mod states the version"
        : `go build of the devhub command for ${platform} failed`,
    );
  }
  const digest = createHash("sha256")
    .update(readFileSync(binary))
    .digest("hex");
  sums.push(`${digest}  ${platform}/devhub`);
}
writeFileSync(`${out}/SHA256SUMS`, `${sums.join("\n")}\n`);
