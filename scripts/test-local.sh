#!/usr/bin/env bash
# CI, locally: every check `.github/workflows/ci.yml` runs, on this machine,
# Linux included — so a change is iterated on here and CI is only the final
# check after pushing. `pnpm test:local` runs it.
#
#   scripts/test-local.sh                    provision (seconds once done), then every stage
#   scripts/test-local.sh vitest pty         just those stages (provisioning is skipped
#                                            unless named)
#   scripts/test-local.sh --no-provision     every stage, assuming a provisioned tree
#   scripts/test-local.sh provision          provision only
#   --stop                                   stop at the first failing stage
#
# Stages, and the CI job each one stands for:
#   provision   system packages (Linux: Xvfb, Electron's libraries), the
#               unprivileged test user (under root), `pnpm install`, npm's
#               Electron (scripts/electron-path.sh) and the desktop build,
#               which fetches the Neovim and the tmux DevHub bundles into
#               out/nvim and out/tmux (on a Mac it builds that tmux, once)
#               and needs Go, for the devhub command in cli/.
#               Idempotent: a second run is seconds. Not the app bundle:
#               packaging (scripts/build-app.sh) is macOS-only.
#   fmt         pnpm run fmt                                       checks
#   lint        pnpm run lint                                      checks
#   typecheck   pnpm run typecheck (the desktop's main included)   checks
#   vitest      @devhub/desktop vitest                             test-desktop
#   pty         @devhub/desktop test:pty (node-pty under Electron) test-desktop
#               Both run their real-Neovim and real-tmux tests on the
#               bundled Neovim and tmux (out/nvim and out/tmux, `build:nvim`
#               and `build:tmux`), never the machine's own.
#   scripts     pnpm run test:scripts                              checks
#   cli         pnpm run test:cli (gofmt, go vet, go test in cli/) checks
#   app         the app smoke test (scripts/smoke_packaged_app.py). On macOS
#               against dist/DevHub.app when one is built; on Linux against
#               the packaged layout (package-nightly.py --layout-only) under
#               xvfb-run, which also loads its node-pty and its wasm.  test-app
#
# Under root, the test stages run as the unprivileged user `devhub-test`
# (created by `provision`): tests that make a directory unwritable and expect a
# write to fail cannot fail for root, so CI's macOS runner (not root) and this
# machine would disagree. Only the scratch directories those tests write are
# handed to that user. DEVHUB_TEST_USER=root keeps everything as root.
#
# Free disk is reported at the end with what the install keeps.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
OS="$(uname -s)"
ALL_STAGES=(provision fmt lint typecheck vitest pty scripts cli app)

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

# What every test stage runs with: a UTF-8 locale (tmux renders what it
# cannot encode as `_`; CI's runners have one, a container's POSIX default is
# not one).
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
# Electron's runtime libraries, Xvfb, and what the tests start (ssh, lsof,
# git). Not tmux: the tests and the app run DevHub's own (out/tmux).
# Debian/Ubuntu package names; only installed when missing.
LINUX_PACKAGES=(
	xvfb xauth openssh-client lsof git curl ca-certificates build-essential python3
	libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libxkbfile1 libsecret-1-0
	libdrm2 libxdamage1 libxrandr2 libxcomposite1 libatk-bridge2.0-0t64 libcups2t64 libkrb5-3
)

provision_system() {
	[ "$OS" = Linux ] || return 0
	command -v dpkg-query >/dev/null || { echo "not Debian/Ubuntu: install Xvfb, xauth and Electron's libraries yourself"; return 0; }
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

provision() {
	set -e
	provision_system
	provision_test_user
	pnpm install --frozen-lockfile
	echo "electron: $(apps/desktop/scripts/electron-path.sh)"
	# The build compiles the devhub command (cli/, Go); go.mod states the
	# version, and GOTOOLCHAIN fetches it when the installed Go is older.
	command -v go >/dev/null || { echo "Go is not installed: the build needs it for cli/ (https://go.dev/dl/)" >&2; return 1; }
	echo "go: $(go version)"
	pnpm --filter @devhub/desktop build
	set +e
}

# --- the stages -------------------------------------------------------------
stage_vitest() {
	prepare_test_user || return 1
	(cd apps/desktop && pnpm run build:nvim && pnpm run build:bash && pnpm run build:tmux) || return 1
	(cd apps/desktop && as_test_user node_modules/.bin/vitest run)
}

stage_pty() {
	prepare_test_user || return 1
	(cd apps/desktop && pnpm run build:nvim && pnpm run build:bash && pnpm run build:tmux) || return 1
	(cd apps/desktop && as_test_user test/terminal/run-under-electron.sh)
}

stage_scripts() {
	prepare_test_user || return 1
	as_test_user python3 -m unittest discover -s scripts -p '*_test.py'
}

# The `devhub` command (cli/, Go): gofmt, vet and its tests, as the test
# user, with a Go cache of that user's own.
stage_cli() {
	prepare_test_user || return 1
	(cd cli && test -z "$(gofmt -l .)") || { (cd cli && gofmt -l .); return 1; }
	(cd cli && as_test_user env GOCACHE="${TEST_HOME:-$HOME}/.cache/go-build" GOPATH="${TEST_HOME:-$HOME}/go" go vet ./...) || return 1
	(cd cli && as_test_user env GOCACHE="${TEST_HOME:-$HOME}/.cache/go-build" GOPATH="${TEST_HOME:-$HOME}/go" go test -count=1 ./...)
}

stage_app() {
	if [ "$OS" = Darwin ] && [ -d dist/DevHub.app ]; then
		scripts/smoke_packaged_app.py dist/DevHub.app
		return
	fi
	local build="$LOG_DIR/app-build.log" layout="$REPO_ROOT/.spike/test-local/app-layout"
	pnpm --filter @devhub/desktop build >"$build" 2>&1 || { tail -40 "$build"; return 1; }
	if [ "$OS" = Linux ]; then
		# The packaged app's own tree, run by npm's Electron.
		scripts/package-nightly.py --layout-only "$layout" >>"$build" 2>&1 || { tail -40 "$build"; return 1; }
		local args=()
		# Chromium refuses to run as root with its sandbox on.
		[ "$(id -u)" = 0 ] && args+=(--electron-arg=--no-sandbox)
		xvfb-run -a -s "-screen 0 1280x1024x24" scripts/smoke_packaged_app.py --layout "$layout" "${args[@]}"
	else
		scripts/smoke_packaged_app.py --source
	fi
}

summarize() {
	local total=$((SECONDS - STARTED_ALL)) line
	printf '\n\033[1m==> summary\033[0m  (%dm%02ds; logs in %s)\n' $((total / 60)) $((total % 60)) "${LOG_DIR#"$REPO_ROOT"/}"
	for line in "${RESULTS[@]}"; do echo "  $line"; done
	echo "  disk: $(df -h "$REPO_ROOT" | awk 'NR==2 {print $4 " free of " $2}'); installed:"
	du -sh node_modules apps/desktop/node_modules "$(dirname "$(dirname "$(apps/desktop/scripts/electron-path.sh 2>/dev/null)")")" 2>/dev/null | sed 's/^/    /'
}

for stage in "${STAGES[@]}"; do
	case "$stage" in
		provision) run_stage provision provision ;;
		fmt) run_stage fmt pnpm run fmt ;;
		lint) run_stage lint pnpm run lint ;;
		typecheck) run_stage typecheck pnpm run typecheck ;;
		vitest) run_stage vitest stage_vitest ;;
		pty) run_stage pty stage_pty ;;
		scripts) run_stage scripts stage_scripts ;;
		cli) run_stage cli stage_cli ;;
		app) run_stage app stage_app ;;
	esac
done
summarize
exit $FAILED
