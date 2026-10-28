#!/usr/bin/env bash
# CI, locally: every check `.github/workflows/ci.yml` runs, on this machine,
# Linux included — so a change is iterated on here and CI is only the final
# check after pushing. `pnpm test:local` runs it.
#
#   scripts/test-local.sh                    provision (once, cached), then every stage
#   scripts/test-local.sh vitest pty         just those stages (provisioning is skipped
#                                            unless named)
#   scripts/test-local.sh --no-provision     every stage, assuming a provisioned tree
#   scripts/test-local.sh provision          provision only
#   --stop                                   stop at the first failing stage
#
# Stages, and the CI job each one stands for:
#   provision   system packages (Linux: Xvfb, Electron's libraries, tmux), the
#               unprivileged test user (under root), `pnpm install`,
#               scripts/provision-vscode.sh --for dev (the submodule at its
#               pinned commit, patches and overlay, VS Code's npm ci, vscode/out,
#               Electron, the built-in extensions) and the desktop build. Stamped
#               and idempotent: a second run is seconds. Not the app bundle:
#               packaging (scripts/build-app.sh) is macOS-only.
#   fmt         pnpm run fmt                                       checks
#   lint        pnpm run lint                                      checks
#   extensions  bridge:check, remote:check, copilot:check          checks
#   typecheck   pnpm run typecheck (the desktop's main included)   test-desktop
#   vitest      @devhub/desktop vitest                             test-desktop
#   pty         @devhub/desktop test:pty (node-pty under Electron) test-desktop
#   scripts     pnpm run test:scripts (+ darwin_bundle_test on macOS) checks, test-desktop
#   overlay     patches/vscode-overlay's tests: its extensions' node --test
#               suites, and its src/ tests in VS Code's own Electron test
#               runner (devhubVim, modal input, …). Not in CI.
#   app         the app smoke test (scripts/smoke_packaged_app.py). On macOS
#               against dist/DevHub.app when one is built, else — and always on
#               Linux — against a source run (dev.sh) under xvfb-run.  test-app
#
# Under root, the test stages run as the unprivileged user `devhub-test`
# (created by `provision`): tests that make a directory unwritable and expect a
# write to fail cannot fail for root, so CI's macOS runner (not root) and this
# machine would disagree. Only the scratch directories those tests write are
# handed to that user. DEVHUB_TEST_USER=root keeps everything as root.
#
# Free disk is reported at the end with what provisioning keeps.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
OS="$(uname -s)"
ALL_STAGES=(provision fmt lint extensions typecheck vitest pty scripts overlay app)

STOP=0
NO_PROVISION=0
STAGES=()
for arg in "$@"; do
	case "$arg" in
		--stop) STOP=1 ;;
		--no-provision) NO_PROVISION=1 ;;
		-h | --help) sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
		-*) echo "unknown option $arg" >&2; exit 2 ;;
		*)
			case " ${ALL_STAGES[*]} " in
				*" $arg "*) STAGES+=("$arg") ;;
				*) echo "unknown stage $arg (stages: ${ALL_STAGES[*]})" >&2; exit 2 ;;
			esac
			;;
	esac
done
if [ ${#STAGES[@]} -eq 0 ]; then
	STAGES=("${ALL_STAGES[@]}")
	[ "$NO_PROVISION" = 1 ] && STAGES=("${STAGES[@]:1}")
fi

LOG_DIR="$REPO_ROOT/.spike/test-local"
mkdir -p "$LOG_DIR"
export CI="${CI:-true}"

# --- who runs the tests -----------------------------------------------------
TEST_USER="${DEVHUB_TEST_USER:-devhub-test}"
if [ "$(id -u)" != 0 ] || [ "$TEST_USER" = root ]; then
	TEST_USER=""
fi
TEST_HOME=""

# The directories the test stages write inside the checkout. Everything else
# they write is under their own HOME or the system temp directory.
TEST_WRITABLE=(
	.spike
	apps/desktop/.test-scratch
	apps/desktop/node_modules/.vite
	apps/desktop/node_modules/.vite-temp
	apps/desktop/out/test-terminal
	vscode/.build/crashes
)

prepare_test_user() {
	[ -n "$TEST_USER" ] || return 0
	id "$TEST_USER" >/dev/null 2>&1 || {
		echo "no user $TEST_USER: run 'scripts/test-local.sh provision' (or DEVHUB_TEST_USER=root)" >&2
		return 1
	}
	local dir
	for dir in "${TEST_WRITABLE[@]}"; do
		mkdir -p "$dir"
		chown -R "$TEST_USER:" "$dir"
	done
	if [ -z "$TEST_HOME" ]; then
		TEST_HOME="$(mktemp -d /tmp/devhub-test-home-XXXXXX)"
		chown "$TEST_USER:" "$TEST_HOME"
		# The checkout is root's; git refuses another user's repository unless told.
		printf '[safe]\n\tdirectory = *\n' >"$TEST_HOME/.gitconfig"
		chown "$TEST_USER:" "$TEST_HOME/.gitconfig"
		trap 'rm -rf "$TEST_HOME"' EXIT
		# A CA bundle the environment names (an HTTPS proxy's, say) may be
		# readable by root alone; the test user gets its own copy.
		local var
		for var in NODE_EXTRA_CA_CERTS SSL_CERT_FILE REQUESTS_CA_BUNDLE CURL_CA_BUNDLE; do
			if [ -n "${!var:-}" ] && [ -f "${!var}" ]; then
				cp "${!var}" "$TEST_HOME/$var.crt"
				chmod 644 "$TEST_HOME/$var.crt"
				export "$var=$TEST_HOME/$var.crt"
			fi
		done
	fi
}

# The tmux the terminal tests run on Linux; see provision_tmux.
TMUX_VERSION="$(cd scripts && python3 -c 'from build_tmux import TMUX; print(TMUX.version)')"
TEST_TMUX="$REPO_ROOT/tmux-build/release/$TMUX_VERSION/bin/tmux"

# What every test stage runs with: DevHub's tmux where it was provisioned, and
# a UTF-8 locale (tmux renders what it cannot encode as `_`; CI's runners have
# one, a container's POSIX default is not one).
if [ -x "$TEST_TMUX" ]; then export DEVHUB_TEST_TMUX="$TEST_TMUX"; fi
if [ "$OS" = Linux ]; then
	case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
		*UTF-8* | *utf8* | *UTF8* | *utf-8*) ;;
		*) export LANG=C.UTF-8 LC_ALL=C.UTF-8 ;;
	esac
fi

# Electron refuses to start as Node with a Node-only flag in NODE_OPTIONS
# (`--use-openssl-ca`, which some proxied environments set); the CA bundle
# itself still reaches Node through NODE_EXTRA_CA_CERTS.
if [ -n "${NODE_OPTIONS:-}" ]; then
	NODE_OPTIONS="$(printf '%s' "$NODE_OPTIONS" | sed 's/--use-openssl-ca//g; s/^ *//; s/ *$//')"
	[ -n "$NODE_OPTIONS" ] && export NODE_OPTIONS || unset NODE_OPTIONS
fi

# Run a command as a subreaper on Linux: orphaned grandchildren are reparented
# to it and reaped at once, as launchd and a real init do. A container's PID 1
# need not reap at all, and the tests that kill a process tree and then ask
# whether a descendant is gone (`kill(pid, 0)`) would see its zombie.
REAPER='
import ctypes, os, signal, sys
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
child = os.fork()
if child == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, lambda n, _f: os.kill(child, n))
status = 1
while True:
    try:
        pid, raw = os.wait()
    except ChildProcessError:
        break
    if pid == child:
        status = os.waitstatus_to_exitcode(raw)
        status = 128 - status if status < 0 else status
        break  # what is still running (a leaked server) goes back to PID 1
sys.exit(status)
'
reaped() {
	if [ "$OS" = Linux ]; then
		python3 -c "$REAPER" "$@"
	else
		"$@"
	fi
}

# Run a command as the test user (or as is, when there is none), reaped. Its
# SHELL is bash, as on CI's runners: root's zsh, started in a fresh HOME with
# no startup files, opens its new-user setup in the tmux panes the tests type into.
as_test_user() {
	if [ -z "$TEST_USER" ]; then
		reaped "$@"
		return
	fi
	reaped setpriv --reuid="$TEST_USER" --regid="$TEST_USER" --init-groups \
		env HOME="$TEST_HOME" USER="$TEST_USER" LOGNAME="$TEST_USER" SHELL=/bin/bash \
		XDG_CONFIG_HOME="$TEST_HOME/.config" XDG_CACHE_HOME="$TEST_HOME/.cache" "$@"
}

# --- stage bookkeeping ------------------------------------------------------
RESULTS=()
FAILED=0
STARTED_ALL=$SECONDS

# The pass/fail/skip counts a stage's log states, in the formats its runners print.
counts() {
	local log="$1"
	python3 - "$log" <<-'EOF'
		import re, sys
		text = open(sys.argv[1], errors="replace").read()
		text = re.sub(r"\x1b\[[0-9;]*m", "", text)
		parts = []
		def total(pattern):
		    return sum(int(m) for m in re.findall(pattern, text, re.M))
		# vitest: "Tests  1234 passed | 3 skipped (1237)"
		for line in re.findall(r"^\s*Tests\s+(.*\(\d+\))\s*$", text, re.M):
		    parts.append("vitest " + line.strip())
		# python unittest: "Ran 302 tests" + "OK (skipped=3)" / "FAILED (failures=1)"
		ran = re.findall(r"^Ran (\d+) tests?", text, re.M)
		if ran:
		    skipped = total(r"skipped=(\d+)")
		    failures = total(r"(?:failures|errors)=(\d+)")
		    parts.append(f"unittest {sum(map(int, ran))} ran, {failures} failed, {skipped} skipped")
		# node --test: "# pass 12" / "# fail 0" / "# skipped 0"
		if re.search(r"^(?:#|ℹ) pass \d+", text, re.M):
		    passed, failed, skipped = (total(r"^(?:#|ℹ) %s (\d+)" % k) for k in ("pass", "fail", "skipped"))
		    parts.append(f"node:test {passed} passed, {failed} failed, {skipped} skipped")
		# mocha: "  123 passing" / "  2 failing" / "  4 pending"
		if re.search(r"^\s+\d+ passing", text, re.M):
		    passed, failed, pending = (total(r"^\s+(\d+) %s" % k) for k in ("passing", "failing", "pending"))
		    parts.append(f"mocha {passed} passed, {failed} failed, {pending} pending")
		print("; ".join(parts))
	EOF
}

run_stage() {
	local name="$1"
	shift
	local log="$LOG_DIR/$name.log" started=$SECONDS status
	printf '\n\033[1m==> %s\033[0m  (log: %s)\n' "$name" "${log#"$REPO_ROOT"/}"
	"$@" 2>&1 | tee "$log"
	status=${PIPESTATUS[0]}
	local took=$((SECONDS - started)) summary
	summary="$(counts "$log")"
	if [ "$status" = 0 ]; then
		RESULTS+=("$(printf '%-10s  ok    %4ds  %s' "$name" "$took" "$summary")")
	else
		RESULTS+=("$(printf '%-10s  FAIL  %4ds  %s (exit %s)' "$name" "$took" "$summary" "$status")")
		FAILED=1
		if [ "$STOP" = 1 ]; then
			summarize
			exit 1
		fi
	fi
}

# --- provision --------------------------------------------------------------
# Electron's runtime libraries, Xvfb, and what the tests start (tmux, ssh,
# lsof, git). Debian/Ubuntu package names; only installed when missing.
LINUX_PACKAGES=(
	xvfb xauth tmux openssh-client lsof git curl ca-certificates build-essential python3
	libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libxkbfile1 libsecret-1-0
	libdrm2 libxdamage1 libxrandr2 libxcomposite1 libatk-bridge2.0-0t64 libcups2t64 libkrb5-3
)

provision_system() {
	[ "$OS" = Linux ] || return 0
	command -v dpkg-query >/dev/null || { echo "not Debian/Ubuntu: install Xvfb, xauth, tmux and Electron's libraries yourself"; return 0; }
	local missing=() package resolved
	for package in "${LINUX_PACKAGES[@]}"; do
		resolved="$package"
		# Ubuntu 24.04 renamed a few libraries for 64-bit time; older releases have the old names.
		if ! apt-cache show "$resolved" >/dev/null 2>&1; then resolved="${package%t64}"; fi
		dpkg-query -W -f='${Status}' "$resolved" 2>/dev/null | grep -q "ok installed" || missing+=("$resolved")
	done
	if [ ${#missing[@]} -eq 0 ]; then
		echo "system packages: all present"
	elif [ "$(id -u)" = 0 ]; then
		echo "system packages: installing ${missing[*]}"
		DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}" \
			|| { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"; }
	else
		echo "system packages missing (install them as root): ${missing[*]}" >&2
		return 1
	fi
}

provision_test_user() {
	[ "$(id -u)" = 0 ] && [ "${DEVHUB_TEST_USER:-devhub-test}" != root ] || return 0
	local user="${DEVHUB_TEST_USER:-devhub-test}"
	if id "$user" >/dev/null 2>&1; then
		echo "test user: $user exists"
	else
		useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$user"
		echo "test user: created $user"
	fi
}

# The tmux the terminal tests run. They take the machine's own (the macOS
# runner's is Homebrew's, which is current); Ubuntu 24.04's 3.4 escapes the
# control characters DevHub frames tmux's listings with, so on Linux the tests
# get the tmux DevHub itself publishes and installs on Linux hosts
# (scripts/build_tmux.py, release tmux-<version>), through DEVHUB_TEST_TMUX.

provision_tmux() {
	[ "$OS" = Linux ] || return 0
	if [ -x "$TEST_TMUX" ]; then
		echo "tmux for the tests: $("$TEST_TMUX" -V) at ${TEST_TMUX#"$REPO_ROOT"/}"
		return 0
	fi
	local arch tarball url
	case "$(uname -m)" in x86_64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) echo "no published tmux for $(uname -m)" >&2; return 1 ;; esac
	tarball="$(cd scripts && python3 -c "from build_tmux import tarball_name; print(tarball_name('linux', '$arch', '$TMUX_VERSION'))")"
	url="https://github.com/statiolake/devhub/releases/download/tmux-$TMUX_VERSION/$tarball"
	mkdir -p "$(dirname "$(dirname "$TEST_TMUX")")"
	curl -fsSL "$url" | tar -xz --strip-components 1 -C "$(dirname "$(dirname "$TEST_TMUX")")"
	echo "tmux for the tests: $("$TEST_TMUX" -V), from $url"
}

provision() {
	set -e
	provision_system
	provision_test_user
	provision_tmux
	# node-gyp's Electron headers, where electronjs.org is unreachable; see the
	# script. `ensure` makes node-gyp keep headers it already has instead of
	# downloading them again (and deleting them when that fails).
	scripts/electron-headers-fallback.sh
	export npm_config_ensure=true
	pnpm install --frozen-lockfile
	if [ -z "${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null; then
		GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
		export GITHUB_TOKEN
	fi
	scripts/provision-vscode.sh --for dev
	pnpm --filter @devhub/desktop build
	set +e
}

# --- the stages -------------------------------------------------------------
stage_extensions() {
	pnpm run bridge:check && pnpm run remote:check && pnpm run copilot:check
}

stage_vitest() {
	prepare_test_user || return 1
	(cd apps/desktop && pnpm run build:terminal) || return 1
	(cd apps/desktop && as_test_user node_modules/.bin/vitest run)
}

stage_pty() {
	prepare_test_user || return 1
	(cd apps/desktop && as_test_user test/terminal/run-under-electron.sh)
}

stage_scripts() {
	prepare_test_user || return 1
	as_test_user python3 -m unittest discover -s scripts -p '*_test.py' || return 1
	if [ "$OS" = Darwin ]; then
		(cd scripts && python3 -m unittest darwin_bundle_test)
	else
		echo "darwin_bundle_test: macOS-only (it reads the Electron app bundle); CI's macOS job runs it"
	fi
}

# The overlay's VS Code unit tests: its extensions' node --test suites, and
# every *.test.ts under patches/vscode-overlay/src, run from vscode/out by VS
# Code's Electron test runner (vscode/scripts/test.sh), under Xvfb on Linux.
# One runner per file, the way they are run while developing them: a file
# that loads a workbench contribution registers its keybindings for the whole
# process, and another file's census of the default keybindings would see them.
stage_overlay() {
	local status=0 f files=() extra=() runner=(vscode/scripts/test.sh)
	node --test vscode/extensions/devhub-*/test/*.test.js || status=1
	while IFS= read -r f; do files+=("${f#patches/vscode-overlay/}"); done \
		< <(find patches/vscode-overlay/src -name '*.test.ts' | LC_ALL=C sort)
	if [ "$OS" = Linux ]; then
		runner=(xvfb-run -a -s "-screen 0 1280x1024x24" vscode/scripts/test.sh)
		# Chromium refuses to run as root with its sandbox on.
		[ "$(id -u)" = 0 ] && extra+=(--no-sandbox)
	fi
	for f in "${files[@]}"; do
		echo "--- $f"
		VSCODE_SKIP_PRELAUNCH=1 "${runner[@]}" --run "$f" "${extra[@]}" || { status=1; echo "FAILED: $f"; }
	done
	return $status
}

stage_app() {
	if [ "$OS" = Darwin ] && [ -d dist/DevHub.app ]; then
		scripts/smoke_packaged_app.py dist/DevHub.app
		return
	fi
	local build="$LOG_DIR/app-build.log"
	pnpm --filter @devhub/desktop build >"$build" 2>&1 || { tail -40 "$build"; return 1; }
	if [ "$OS" = Linux ]; then
		local args=()
		# Chromium refuses to run as root with its sandbox on.
		[ "$(id -u)" = 0 ] && args+=(--electron-arg=--no-sandbox)
		xvfb-run -a -s "-screen 0 1280x1024x24" scripts/smoke_packaged_app.py --source "${args[@]}"
	else
		scripts/smoke_packaged_app.py --source
	fi
}

summarize() {
	local total=$((SECONDS - STARTED_ALL)) line
	printf '\n\033[1m==> summary\033[0m  (%dm%02ds; logs in %s)\n' $((total / 60)) $((total % 60)) "${LOG_DIR#"$REPO_ROOT"/}"
	for line in "${RESULTS[@]}"; do echo "  $line"; done
	echo "  disk: $(df -h "$REPO_ROOT" | awk 'NR==2 {print $4 " free of " $2}'); provisioned:"
	du -sh vscode/node_modules vscode/out vscode/.build vscode-toolchain 2>/dev/null | sed 's/^/    /'
	echo "  nested VS Code installs (build/, extensions/*, remote/, test/*): $(
		find vscode -mindepth 2 -maxdepth 4 -name node_modules -type d -not -path 'vscode/node_modules/*' -prune -print0 2>/dev/null \
			| du -csh --files0-from=- 2>/dev/null | tail -1 | cut -f1)"
}

for stage in "${STAGES[@]}"; do
	case "$stage" in
		provision) run_stage provision provision ;;
		fmt) run_stage fmt pnpm run fmt ;;
		lint) run_stage lint pnpm run lint ;;
		extensions) run_stage extensions stage_extensions ;;
		typecheck) run_stage typecheck pnpm run typecheck ;;
		vitest) run_stage vitest stage_vitest ;;
		pty) run_stage pty stage_pty ;;
		scripts) run_stage scripts stage_scripts ;;
		overlay) run_stage overlay stage_overlay ;;
		app) run_stage app stage_app ;;
	esac
done
summarize
exit $FAILED
