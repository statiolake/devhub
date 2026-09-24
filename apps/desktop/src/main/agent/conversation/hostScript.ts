/**
 * The host: a GUI Agent's CLI, wired to files, inside the Agent's tmux session.
 *
 * A GUI Agent is a tmux session like every other Agent, and this is its
 * session command. It connects the structured-mode CLI's stdin to a FIFO and
 * its stdout to a file that is only ever appended to, and when the CLI exits
 * it writes down how. That is all it does, and all of it is POSIX `sh`,
 * `mkfifo`, `tail`, `tee`, `wc` and `cat` — so it runs the same on this Mac,
 * on a Linux host and on a busybox appliance with no Node on it, and there is
 * nothing to install: the script travels as the session command's own argv,
 * which also means a running host can never be edited underneath itself by a
 * newer DevHub writing a newer copy.
 *
 * Why the files, and not a pipe to DevHub: DevHub restarts, often, and a turn
 * must not notice. A CLI writing into a pipe nobody is reading blocks; a CLI
 * appending to a file never does. So the file is the journal, DevHub reads it
 * from wherever it got to, and DevHub being gone for a minute costs nothing.
 *
 * # The state directory contract
 *
 * One directory per Agent (`hostCommand.ts` says where). DevHub makes it
 * before the launch and removes it after the Agent is over; the host only
 * ever creates files in it.
 *
 * - `out`    the CLI's stdout, appended to, never truncated. The journal.
 * - `err`    the CLI's stderr, and the host's own complaints, prefixed
 *            `devhub-agent-host:`.
 * - `in`     a FIFO; the CLI's stdin. The host holds it open for reading and
 *            writing, so the CLI never sees EOF and a writer never blocks on
 *            open while the host is alive.
 * - `in.log` every line DevHub wrote to `in`, appended by the writer.
 * - `pid`    the host's own pid, written (atomically) once `in` is open: the
 *            host is ready when this exists.
 * - `exit`   written (atomically) once, when the host is over: the CLI's exit
 *            status as a decimal (128 + n for a signal, as `sh` reports it),
 *            or the word `host` when the host itself could not start the CLI
 *            — the reason is then the last line of `err`.
 *
 * No `exit` and no live `pid` means the host was killed: tmux killed the
 * session (DevHub's Stop, or a person's `kill-session`) or the machine went
 * down. That is the one way to tell "stopped" from "ended".
 */

/** `$0` of the host, so that `ps` on any machine says what it is. */
export const HOST_NAME = "devhub-agent-host";

/**
 * The host itself. `$1` is the state directory; the rest is the CLI's argv.
 *
 * `command exec` and not `exec` for the redirections that may fail: a failed
 * redirection on the special builtin `exec` exits a non-interactive shell on
 * the spot, before the `||` could say why.
 */
export const HOST_SCRIPT = `set -u
D=$1
shift
command exec 2>>"$D/err" || exit 70
say() { printf 'devhub-agent-host: %s\\n' "$*" >&2; }
ended() { printf '%s\\n' "$1" >"$D/exit.new" && mv -f "$D/exit.new" "$D/exit"; }
refuse() { say "$1"; ended host; exit 70; }
: >>"$D/out" || refuse "cannot create the journal $D/out"
mkfifo "$D/in" || refuse "cannot make the input pipe $D/in"
command exec 3<>"$D/in" || refuse "cannot open the input pipe $D/in"
{ printf '%s\\n' "$$" >"$D/pid.new" && mv -f "$D/pid.new" "$D/pid"; } ||
  refuse "cannot record the host's pid in $D/pid"
"$@" <&3 3<&- >>"$D/out"
ended "$?"
`;

/** `$0` of a journal stream. */
export const STREAM_NAME = "devhub-agent-stream";

/**
 * How a journal stream ends, as its exit status.
 *
 * Zero is not "fine" but a fact: the host is over, so the journal will not
 * grow again and whatever `tail` had not yet passed on can be read once, to
 * the end. Every other status is a reason the stream cannot go on, with its
 * sentence on stderr.
 */
export const STREAM_EXIT = {
	hostOver: 0,
	notStarted: 71,
	stateMissing: 72,
	truncated: 73,
	tailStopped: 74,
} as const;

/** How long a stream waits for a host that has not written its `pid` yet. */
export const HOST_START_SECONDS = 30;

/**
 * Follow the journal from a byte offset. `$1` is the state directory, `$2`
 * the number of bytes already read.
 *
 * `tail -f` is the follower, and it is fast where it can be (kqueue on macOS,
 * inotify on GNU) and a one-second poll on busybox. Beside it runs a watchdog,
 * once a second, for the three things `tail -f` will not say:
 *
 * - **The host is over.** `tail -f` follows a file for ever, and the file
 *   stopping growing is not an ending. The watchdog sees `exit`, or a `pid`
 *   that no longer answers, and ends the stream with `hostOver`.
 * - **The journal shrank.** BSD `tail` silently starts again from the top of
 *   a truncated file, which would hand DevHub the whole conversation a second
 *   time as if it were new. The journal is append-only by contract, so a size
 *   smaller than one already seen — or than the offset asked for — is a broken
 *   invariant and ends the stream with `truncated`.
 * - **DevHub let go.** Killing a local `ssh` or `docker exec` sends nothing to
 *   the far side, where this would otherwise poll for ever. The stream's stdin
 *   is held open by DevHub and never written; EOF on it stops everything. It
 *   is read through fd 4 because an asynchronous list in a shell without job
 *   control gets `/dev/null` as its stdin.
 */
export const STREAM_SCRIPT = `set -u
D=$1
N=$2
say() { printf 'devhub-agent-stream: %s\\n' "$*" >&2; }
n=0
while [ ! -f "$D/pid" ]; do
  [ -d "$D" ] || { say "there is no host state at $D"; exit ${STREAM_EXIT.stateMissing}; }
  if [ -f "$D/exit" ]; then
    say "the host in $D ended before it started: $(tail -n 1 "$D/err" 2>/dev/null)"
    exit ${STREAM_EXIT.notStarted}
  fi
  n=$((n + 1))
  [ "$n" -le ${HOST_START_SECONDS} ] ||
    { say "the host in $D did not start within ${HOST_START_SECONDS} seconds"; exit ${STREAM_EXIT.notStarted}; }
  sleep 1
done
pid=$(cat "$D/pid") || { say "the host's pid in $D cannot be read"; exit ${STREAM_EXIT.stateMissing}; }
s=$(wc -c <"$D/out") || { say "the journal $D/out cannot be read"; exit ${STREAM_EXIT.stateMissing}; }
last=$((s))
[ "$last" -ge "$N" ] ||
  { say "the journal $D/out has $last bytes, fewer than the $N already read: it was truncated or replaced"; exit ${STREAM_EXIT.truncated}; }
exec 4<&0
tail -c +$((N + 1)) -f "$D/out" &
t=$!
( cat <&4 >/dev/null 2>&1; kill "$t" "$$" 2>/dev/null ) >/dev/null 2>&1 &
w=$!
stop() { kill "$w" "$t" 2>/dev/null; exit "$1"; }
while :; do
  if [ -f "$D/exit" ] || ! kill -0 "$pid" 2>/dev/null; then stop ${STREAM_EXIT.hostOver}; fi
  s=$(wc -c <"$D/out") || { say "the journal $D/out cannot be read"; stop ${STREAM_EXIT.stateMissing}; }
  s=$((s))
  [ "$s" -ge "$last" ] ||
    { say "the journal $D/out went from $last to $s bytes: it was truncated or replaced"; stop ${STREAM_EXIT.truncated}; }
  last=$s
  kill -0 "$t" 2>/dev/null || { say "tail stopped following $D/out"; stop ${STREAM_EXIT.tailStopped}; }
  sleep 1
done
`;

/** How a write to the host refuses, as its exit status. */
export const WRITE_EXIT = { stateMissing: 3, hostGone: 4 } as const;

/**
 * One line (on stdin) into the CLI, and into `in.log`. `$1` is the state
 * directory.
 *
 * A host that has not written its `pid` yet is waited for — the first line a
 * conversation sends goes out straight after the launch, before the host has
 * had its first few milliseconds — and the wait is bounded by the write's own
 * deadline, not by anything here.
 *
 * The checks after it are what keep the write from being a silent wrong:
 * without the first, a missing FIFO would be *created* as a regular file by
 * the redirection and the line written into nowhere; without the second,
 * opening a FIFO nobody holds blocks until the deadline, and a host that is
 * gone would be reported as one that is slow.
 *
 * None of these sentences may say "is not running": that is docker's phrase
 * for a stopped container, and the container runtime reads it as one.
 */
export const WRITE_SCRIPT = `set -u
D=$1
while [ ! -f "$D/pid" ]; do
  [ -d "$D" ] || { echo "there is no host state at $D" >&2; exit ${WRITE_EXIT.stateMissing}; }
  [ ! -f "$D/exit" ] || { echo "the host in $D ended before it started" >&2; exit ${WRITE_EXIT.hostGone}; }
  sleep 0.1 2>/dev/null || sleep 1
done
[ -p "$D/in" ] || { echo "there is no input pipe at $D/in" >&2; exit ${WRITE_EXIT.stateMissing}; }
if [ -f "$D/exit" ] || ! kill -0 "$(cat "$D/pid")" 2>/dev/null; then
  echo "the host in $D has ended, so nothing is reading its input" >&2; exit ${WRITE_EXIT.hostGone}
fi
exec tee -a "$D/in.log" >"$D/in"
`;

/** Everything DevHub has written to the host. `$1` is the state directory. */
export const SENT_LOG_SCRIPT = `D=$1
[ -d "$D" ] || { echo "there is no host state at $D" >&2; exit ${WRITE_EXIT.stateMissing}; }
[ -f "$D/in.log" ] || exit 0
exec cat -- "$D/in.log"
`;

/** How many bytes of `err` an ending carries. */
export const STDERR_TAIL_BYTES = 4096;

/**
 * How the host ended, and the end of its stderr. `$1` is the state directory.
 *
 * The first line is the verdict — `missing`, `running`, `vanished` or `exit
 * <what the host wrote>` — and everything after it is the tail of `err`.
 */
export const ENDING_SCRIPT = `D=$1
[ -d "$D" ] || { echo missing; exit 0; }
if [ -f "$D/exit" ]; then printf 'exit %s\\n' "$(cat "$D/exit")"
elif [ -f "$D/pid" ] && kill -0 "$(cat "$D/pid")" 2>/dev/null; then echo running
else echo vanished
fi
[ ! -f "$D/err" ] || exec tail -c ${STDERR_TAIL_BYTES} "$D/err"
`;
