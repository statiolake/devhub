#!/bin/sh
# A stand-in for a structured-mode Agent CLI: JSON lines out, lines in.
#
# Never a model. It says hello with its own argv count, then answers every line
# it reads on stdin, so a test can see that a line went in and what came out.
# A few lines are instructions to it rather than messages:
#
#   {"fake":"count","n":N}   write N lines {"seq":1} .. {"seq":N}
#   {"fake":"exit","code":N} say so on stderr and exit N
#   {"fake":"partial"}       write half a line with no newline, then exit 9
#
# Anything else is echoed back inside {"echo":<the line>}, which is valid JSON
# because what it reads is.
#
# With FAKE_AGENT_SCRIPT set to a conversation fixture (the "> " / "< " files
# in src/main/agent/conversation/fixtures), it plays that instead: each "< "
# line is printed, and at each "> " line it waits for DevHub to write exactly
# that line — anything else is said on stderr and exits 3; at a ">* " line it
# waits for any one line (for a protocol whose lines DevHub numbers or words
# itself, where the fixture pins the answers rather than the asks). A request_id is
# the one thing DevHub chooses (it names DevHub's boot), so the one DevHub
# wrote stands in for the fixture's from then on, in both directions. When
# the fixture runs out it keeps reading, as a CLI waiting for its next turn
# does.
request_id() { printf '%s' "$1" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p'; }
if [ -n "${FAKE_AGENT_SCRIPT:-}" ]; then
  ids=
  while IFS= read -r step <&4; do
    step=$(printf '%s' "$step" | sed "s/^/x/;$ids;s/^x//")
    case "$step" in
      '< '*) printf '%s\n' "${step#< }" ;;
      '>* '*) IFS= read -r got || exit 0 ;;
      '> '*)
        IFS= read -r got || exit 0
        want=$(request_id "${step#> }")
        have=$(request_id "$got")
        if [ -n "$want" ] && [ "$want" != "$have" ]; then
          ids="$ids;s/\"request_id\":\"$want\"/\"request_id\":\"$have\"/g"
          step=$(printf '%s' "$step" | sed "s/\"request_id\":\"$want\"/\"request_id\":\"$have\"/g")
        fi
        if [ "$got" != "${step#> }" ]; then
          printf 'fake-agent: expected %s\nfake-agent: got      %s\n' "${step#> }" "$got" >&2
          exit 3
        fi
        ;;
    esac
  done 4<"$FAKE_AGENT_SCRIPT"
  while IFS= read -r got; do :; done
  exit 0
fi
printf '{"type":"hello","argc":%s}\n' "$#"
while IFS= read -r line; do
  case "$line" in
    '{"fake":"count","n":'*)
      n=${line#*'"n":'}
      n=${n%\}}
      i=1
      while [ "$i" -le "$n" ]; do
        printf '{"seq":%s}\n' "$i"
        i=$((i + 1))
      done
      ;;
    '{"fake":"exit","code":'*)
      code=${line#*'"code":'}
      code=${code%\}}
      printf 'fake-agent: exiting with %s\n' "$code" >&2
      exit "$code"
      ;;
    '{"fake":"partial"}')
      printf '{"cut":'
      exit 9
      ;;
    *)
      printf '{"echo":%s}\n' "$line"
      ;;
  esac
done
printf 'fake-agent: stdin ended\n' >&2
exit 0
