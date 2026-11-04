#!/bin/sh
# A stand-in for `codex app-server` on stdio that keeps Codex's one rule about
# who may write a thread: one process at a time.
#
# Never a model. It answers the handshake DevHub's Codex adapter makes
# (initialize, account/read, thread/start or thread/resume, model/list,
# skills/list) from the hand-written handshake fixture, $FAKE_CODEX_HANDSHAKE,
# with the thread's id put in, and refuses every other request.
#
# The writer lock, as Codex 0.166 keeps it (codex-rs/rollout/src/writer_lock.rs):
# a process that opens a thread holds it until the process exits — opening
# another thread does not let go of the first — and a thread some other live
# process holds is refused with "thread <id> already has an active writer".
# Codex holds an OS file lock, which the kernel lets go of when the process
# dies; here the holder's pid is written in $FAKE_CODEX_LOCKS/<id>, and a pid
# that is gone (or a zombie nobody has reaped yet: it has exited) holds
# nothing, as a lock file nobody has locked holds nothing.
#
# A thread/start opens $FAKE_CODEX_NEW_THREAD.
set -u
locks=${FAKE_CODEX_LOCKS:?fake-codex-app-server: FAKE_CODEX_LOCKS is not set}
handshake=${FAKE_CODEX_HANDSHAKE:?fake-codex-app-server: FAKE_CODEX_HANDSHAKE is not set}
main=00000000-0000-7000-8000-00000000000a
mkdir -p "$locks"
answer() { # $1 the request's id, $2 the fixture line (1-based), $3 the thread
  sed -n "${2}p" "$handshake" |
    sed "s/^{\"id\":[0-9]*,/{\"id\":$1,/;s/$main/$3/g"
}
alive() { # $1 a pid: a process that has not exited
  state=$(ps -o stat= -p "$1" 2>/dev/null) || return 1
  case "$state" in Z*) return 1 ;; *) return 0 ;; esac
}
open_thread() { # $1 the request's id, $2 the thread
  if [ -f "$locks/$2" ]; then
    holder=$(cat "$locks/$2")
    if [ "$holder" != "$$" ] && alive "$holder"; then
      printf '{"id":%s,"error":{"code":-32600,"message":"thread %s already has an active writer"}}\n' "$1" "$2"
      return
    fi
  fi
  printf '%s\n' "$$" >"$locks/$2"
  answer "$1" 3 "$2"
}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  [ -n "$id" ] || continue
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize) answer "$id" 1 "$main" ;;
    account/read) answer "$id" 2 "$main" ;;
    thread/start) open_thread "$id" "${FAKE_CODEX_NEW_THREAD:?fake-codex-app-server: FAKE_CODEX_NEW_THREAD is not set}" ;;
    thread/resume)
      open_thread "$id" "$(printf '%s' "$line" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')" ;;
    model/list) answer "$id" 5 "$main" ;;
    skills/list) answer "$id" 6 "$main" ;;
    *) printf '{"id":%s,"error":{"code":-32601,"message":"the fake app-server has no %s"}}\n' "$id" "$method" ;;
  esac
done
