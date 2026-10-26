pane=$1 kind=$2 dir=$3 files=${4:-}
if command -v ps >/dev/null 2>&1; then
	table=$(ps -A -o pid= -o ppid= -o comm=) || exit 70
elif [ -d /proc/self ]; then
	table=$(for s in /proc/[0-9]*/stat; do sed -n 's/^\([0-9]*\) (\(.*\)) [A-Za-z] \([0-9]*\) .*/\1 \3 \2/p' "$s" 2>/dev/null; done)
else
	echo "there is neither ps nor /proc to find the processes under pane $pane" >&2
	exit 69
fi
if [ "$kind" = codex ] && [ ! -d /proc/self/fd ] && ! command -v lsof >/dev/null 2>&1; then
	echo "there is neither /proc nor lsof to find the files Codex holds open" >&2
	exit 69
fi
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
tree=$(printf '%s\n' "$table" | awk -v root="$pane" '
{ cmd = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]*/, "", cmd); name[$1] = cmd; kids[$2] = kids[$2] " " $1 }
END { q[1] = root; n = 1; for (i = 1; i <= n; i++) { print q[i] " " name[q[i]]; m = split(kids[q[i]], c, " "); for (j = 1; j <= m; j++) q[++n] = c[j] } }
')
if [ "$kind" = claude ]; then
	printf '%s\n' "$tree" | while read -r pid comm; do
		f="$dir/$pid.json"
		[ -f "$f" ] || continue
		printf 'claude\t%s\t\t%s\n' "$pid" "$f"
		tr -d '\n' <"$f"
		echo
	done
	exit 0
fi
printf '%s\n' "$tree" | while read -r pid comm; do
	printf 'proc\t%s\t\t%s\n\n' "$pid" "$comm"
done
rollouts() { awk -v p="$1" '/\/rollout-[^\/]*\.jsonl$/ { print p "\t" $0 }'; }
if [ -d /proc/self/fd ] && [ "$files" != lsof ]; then
	open=$(printf '%s\n' "$tree" | while read -r pid comm; do
		for fd in /proc/"$pid"/fd/*; do readlink "$fd" 2>/dev/null; done | rollouts "$pid"
	done)
else
	pids=$(printf '%s\n' "$tree" | awk '{ printf "%s%s", (NR > 1 ? "," : ""), $1 }')
	listed=$(lsof -n -P -Fn -p "$pids" 2>/dev/null)
	status=$?
	open=$(printf '%s\n' "$listed" | awk '/^p/ { p = substr($0, 2); next } /^n/ && p != "" { f = substr($0, 2); if (f ~ /\/rollout-[^\/]*\.jsonl$/) print p "\t" f }')
	[ "$status" -eq 0 ] || printf 'note\t\t\tlsof exited %s listing the files of processes %s\n\n' "$status" "$pids"
fi
printf '%s\n' "$open" | sort -u | while IFS='	' read -r pid f; do
	[ -n "$f" ] && [ -f "$f" ] || continue
	printf 'codex\t%s\t%s\t%s\n' "$pid" "$(mtime "$f")" "$f"
	head -n 1 "$f" | head -c 1048576 | tr -d '\n'
	echo
done
