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
