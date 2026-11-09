/**
 * The `nvim` a DevHub terminal runs: DevHub's own Neovim (the one inside the
 * app here, the delivered one on a host), with the person's config, drawn by
 * DevHub over the pane it was typed in (`docs/neovim-editor.md`, "Neovim in
 * a terminal").
 *
 * # Why a program on the PATH, and what it does
 *
 * It has to catch `nvim` typed at a prompt and `nvim` run by another program —
 * `git commit`, `crontab -e`, `$EDITOR` — and the one thing both go through is
 * the PATH. `EDITOR`/`VISUAL` alone would miss the first, and a dotfile that
 * sets `EDITOR=nvim` (most do) would undo them. So the directory this script
 * is in goes in front of every DevHub pane's PATH, as the host's `devhub` does
 * (`TmuxTerminalRuntime.panePath`).
 *
 * The script runs DevHub's Neovim — its absolute path is written in, never
 * looked up on the PATH (`Runtime.neovimProgram`) — with the person's own
 * arguments, in the pane, as the pane's foreground program,
 * so its exit status, its environment (`GIT_*` under `git commit`), its cwd
 * and its life are the pane's, exactly as a TUI's would be. What changes is
 * only who draws it: `--embed --listen <socket>` instead of the TUI, and DevHub
 * attaches to that socket as its only UI. `--embed` waits for that UI before
 * it reads the config or opens a file, so a swap-file question or a config
 * error is drawn, never answered blind by a headless Neovim. Its stdin and
 * stdout are the embedder's channel, which nothing uses: a FIFO held open by
 * Neovim itself (EOF there would end it) and `/dev/null`.
 *
 * # How DevHub learns of it — tmux, on every machine
 *
 * Nothing new is opened between the pane and DevHub. The script writes the
 * socket into a pane option of DevHub's own tmux server (`@devhub-nvim`),
 * which DevHub reads while that terminal is on screen, and DevHub answers on
 * another (`@devhub-nvim-ui` = 1) once its UI is attached. That is the same
 * channel on this Mac and on an SSH host — the host's tmux is DevHub's there
 * too — and needs no Node, no `devhub` command and no forwarded control socket
 * on the far side; the socket itself is reached the way the managed Neovim's
 * is (`neovimMachines.ts`).
 *
 * # When it is just `nvim`
 *
 * It `exec`s the same Neovim as a TUI, untouched, whenever DevHub would not
 * draw it:
 * outside a DevHub pane (no `$TMUX_PANE`, or a session that is neither an
 * Agent terminal's nor a Workspace's), with the overlay off (`@devhub-nvim-overlay`, a server option
 * DevHub states while it is on), inside a DevHub GUI Neovim already
 * (`$DEVHUB_NEOVIM_GUI`, a `:terminal` in it), with stdin or stdout not a
 * terminal, with arguments that are not an editing session (`--headless`,
 * `-es`, `--remote*`, `--version`, `-`…), in a pane that already has one, and
 * when no UI attaches within ten seconds (the terminal is not on screen, say):
 * then the Neovim waiting for it is ended and the TUI runs instead, with the
 * same arguments.
 *
 * # `:restart`
 *
 * `:restart` replaces the server with one it starts itself, on
 * the same socket: the script keeps the pane, and its exit status is the
 * last server's (`neovimRestart.ts`).
 *
 * # What tmux writes into the pane
 *
 * Once the UI is attached the pane's tty is read for that Neovim:
 * `send-prefix`, a `send-keys` binding, `paste-buffer` (`terminalNeovimTtyKeys.ts`).
 */

import { shellQuote } from "../runtime/quote.js";
import { NVIM_STATE_VARIABLE, followRestartSh } from "./neovimRestart.js";
import { ttyKeysShim } from "./terminalNeovimTtyKeys.js";
import { NVIM_NAMED_OSC } from "../../ipc/terminalControl.js";

/** `NVIM_NAMED_OSC` as `printf` writes it. */
function shNamedOsc(): string {
	return NVIM_NAMED_OSC.replace("\u001b", "\\033").replace("\u0007", "\\007");
}

/** The pane option the script names its socket in. */
export const NVIM_SOCKET_OPTION = "@devhub-nvim";
/** The pane option DevHub sets once its UI is attached: the script waits on it. */
export const NVIM_UI_OPTION = "@devhub-nvim-ui";
/** The server option that says the overlay is on (`1`). */
export const NVIM_OVERLAY_OPTION = "@devhub-nvim-overlay";
/** How long the script waits for DevHub's UI before it runs the TUI, in tenths. */
export const NVIM_UI_WAIT_TENTHS = 100;

export interface NeovimShimFacts {
	/** DevHub's Neovim on that machine, by its absolute path. */
	readonly nvim: string;
	/** The tmux of DevHub's server on that machine, by its absolute path. */
	readonly tmux: string;
	/** What the sessions it draws over are named with: Agent terminals' (`tm-`), Workspaces' (`ws-`). */
	readonly sessionPrefixes: readonly string[];
	/** How long it waits for DevHub's UI, in tenths; `NVIM_UI_WAIT_TENTHS` but in tests. */
	readonly uiWaitTenths?: number;
}

/**
 * The script, with the machine's facts written in. POSIX `sh`, like every
 * script DevHub sends a host (`docs/remote-ssh.md`); `sleep 0.1` is the one
 * thing beyond POSIX, and every `sleep` DevHub meets (GNU, BSD, BusyBox) takes
 * a fraction.
 */
export function neovimShimScript(facts: NeovimShimFacts): string {
	const tmux = shellQuote(facts.tmux);
	const waitTenths = facts.uiWaitTenths ?? NVIM_UI_WAIT_TENTHS;
	return `#!/bin/sh
# Generated by DevHub - do not edit. DevHub's \`nvim\`: in a DevHub terminal,
# DevHub's Neovim drawn by DevHub over this pane; otherwise the same Neovim
# as a TUI. Only DevHub's panes have this on their PATH.
shim_tmux=${tmux}
real=${shellQuote(facts.nvim)}
if ! [ -x "$real" ]; then
	echo "nvim: DevHub's Neovim ($real) is not there; reconnect or restart DevHub" >&2
	exit 127
fi
# It finds its runtime beside itself; one inherited from another Neovim is
# that Neovim's.
unset VIMRUNTIME VIM

# DEVHUB_NVIM_DEBUG=1 says on stderr why it runs the TUI.
why() {
	[ -z "\${DEVHUB_NVIM_DEBUG-}" ] || echo "DevHub's nvim runs $real as it is: $*" >&2
	return 1
}

overlay() {
	[ -n "\${TMUX_PANE-}" ] && [ -n "\${TMUX-}" ] || { why "not in a tmux pane (TMUX_PANE, TMUX)"; return 1; }
	[ -z "\${DEVHUB_NEOVIM_GUI-}" ] || { why "inside a Neovim DevHub draws (DEVHUB_NEOVIM_GUI)"; return 1; }
	[ -t 0 ] && [ -t 1 ] || { why "stdin or stdout is not a terminal"; return 1; }
	for argument in "$@"; do
		case $argument in
		--) break ;;
		-|--headless|--embed|--listen|-es|-Es|-e|-E|-l|-L|-r|-h|-v|-\\?|--help|--version|--api-info|--server|--remote*) why "not an editing session ($argument)"; return 1 ;;
		esac
	done
	state=$("$shim_tmux" display-message -p -t "$TMUX_PANE" '#{${NVIM_OVERLAY_OPTION}}|#{session_name}|#{${NVIM_SOCKET_OPTION}}' 2>/dev/null) || { why "$shim_tmux could not read pane $TMUX_PANE (not DevHub's tmux server?)"; return 1; }
	case $state in
	${facts.sessionPrefixes.map((prefix) => `"1|${prefix}"*"|"`).join(" | ")}) return 0 ;;
	esac
	why "overlay|session|socket is $state (wants 1|${facts.sessionPrefixes.join(" or ")}...|empty)"
}

overlay "$@" || exec "$real" "$@"

dir=$(mktemp -d "\${TMPDIR:-/tmp}/devhub-nvim.XXXXXX") || exec "$real" "$@"
socket=$dir/s
cleanup() {
	"$shim_tmux" set-option -p -u -t "$TMUX_PANE" ${NVIM_SOCKET_OPTION} 2>/dev/null
	"$shim_tmux" set-option -p -u -t "$TMUX_PANE" ${NVIM_UI_OPTION} 2>/dev/null
	rm -rf "$dir"
}
if ! mkfifo "$dir/i" || ! exec 3<>"$dir/i"; then
	rm -rf "$dir"
	exec "$real" "$@"
fi
${ttyKeysShim()}# Ctrl-C, Ctrl-\\ and Ctrl-Z typed at the pane under the GUI are not Neovim's:
# its keys are the GUI's. A hangup (the pane killed) still ends both.
trap '' INT QUIT TSTP
"$shim_tmux" set-option -p -t "$TMUX_PANE" ${NVIM_SOCKET_OPTION} "$socket" 2>/dev/null
# Said in the pane too, for a DevHub in tmux control mode, which sees the
# pane's bytes (tmux drops an OSC it does not know).
printf '${shNamedOsc()}'
DEVHUB_NEOVIM_GUI=1 ${NVIM_STATE_VARIABLE}=$dir "$real" --embed --listen "$socket" "$@" <&3 >/dev/null 3>&- &
pid=$!
exec 3>&-
waited=0
while kill -0 "$pid" 2>/dev/null; do
	ui=$("$shim_tmux" display-message -p -t "$TMUX_PANE" '#{${NVIM_UI_OPTION}}' 2>/dev/null)
	[ "$ui" = 1 ] && break
	if [ "$waited" -ge ${String(waitTenths)} ]; then
		# With no UI it has read no config and opened no file (\`--embed\`
		# waits), so there is nothing to keep; SIGTERM would only have it say
		# "Caught deadly signal" in the pane.
		kill -KILL "$pid" 2>/dev/null
		wait "$pid" 2>/dev/null
		cleanup
		why "no DevHub UI attached within ${String(waitTenths / 10)} s"
		# Said once, dim, without DEVHUB_NVIM_DEBUG too: DevHub was asked to
		# draw this Neovim and did not, which is worth knowing (it stays in
		# the scrollback above the shell once the TUI's screen is gone).
		[ -n "\${DEVHUB_NVIM_DEBUG-}" ] || printf '\\033[2m%s\\033[22m\\n' "nvim: DevHub did not draw it within ${String(waitTenths / 10)} s (DevHub not running, the terminal not on screen, or the overlay failed): running it in the terminal" >&2
		trap - INT QUIT TSTP
		exec "$real" "$@"
	fi
	waited=$((waited + 1))
	sleep 0.1
done
# What tmux writes into this pane is that Neovim's input.
kill -0 "$pid" 2>/dev/null && start_tty_keys
wait "$pid"
status=$?
# :restart: the server it started takes over on the same socket, the
# old one's child and not this script's; the pane stays the Neovim's until
# the last of them ends, with its status (neovimRestart.ts).
state=$dir
${followRestartSh()}
stop_tty_keys
cleanup
exit "$status"
`;
}

/**
 * The `tmux` beside DevHub's `nvim`: DevHub's own tmux on that machine (the
 * app's here, the delivered one on a host), by its absolute path, whatever
 * `tmux` the machine's PATH has. A pane's `tmux`, a binding's `run-shell
 * 'tmux …'`, a `copy-pipe "tmux load-buffer -w -"` and a popup's `tmux
 * move-pane` all reach DevHub's server through it, and a tmux client of
 * another version — a host's own, Ubuntu's 3.4 — may not speak to that
 * server, or speaks it differently. It is in the same directory as `nvim`
 * so the same PATH entry and the same zsh hook keep it first
 * (`neovimShimZshenv`). Outside DevHub's panes nothing has it on the PATH.
 */
export function paneTmuxScript(tmux: string): string {
	return `#!/bin/sh
# Generated by DevHub - do not edit. DevHub's tmux, ahead of any other on a
# DevHub pane's PATH: the server this pane is in is that tmux's.
tmux=${shellQuote(tmux)}
# What tmux draws on the client's screen and waits on, asked from a shell:
# DevHub's control client is drawn by DevHub, so it is handed there
# (TMUX_RUN_MARK), and this waits as tmux would until DevHub is done.
case "\${1-}" in
${SHELL_ROUTED_COMMANDS.join("|")})
	if [ -n "\${TMUX-}" ] &&
		[ "$("$tmux" display-message -p '#{client_control_mode}' 2>/dev/null)" = 1 ]; then
		id="$$.$(date +%s)"
		pane=\${TMUX_PANE-}
		message="${TMUX_RUN_MARK}$id \${pane#%}"
		for word in "$@"; do
			message="$message x$(printf '%s' "$word" | od -An -tx1 | tr -d ' \\n')"
		done
		"$tmux" wait-for "devhub-ack-$id" &
		ack=$!
		"$tmux" display-message "$message"
		# Not taken (no DevHub drawing this client): tmux's own after all.
		tries=0
		while kill -0 "$ack" 2>/dev/null; do
			tries=$((tries + 1))
			if [ "$tries" -gt 30 ]; then
				kill "$ack" 2>/dev/null
				exec "$tmux" "$@"
			fi
			sleep 0.1
		done
		exec "$tmux" wait-for "devhub-done-$id"
	fi
	;;
esac
exec "$tmux" "$@"
`;
}

/**
 * The commands DevHub's pane `tmux` hands to DevHub when the client they
 * would draw on is a control client (`paneTmuxScript`): those tmux waits on
 * the client's screen for, as `controlClient.ts` opens them for a binding.
 */
export const SHELL_ROUTED_COMMANDS = [
	"display-popup",
	"popup",
	"command-prompt",
	"confirm-before",
	"confirm",
	"display-menu",
	"menu",
	"display-panes",
	"displayp",
	"choose-tree",
	"choose-window",
	"choose-session",
	"choose-client",
	"choose-buffer",
] as const;

/**
 * How a pane's `tmux` hands DevHub a command (`paneTmuxScript`): a
 * `display-message` to the control client of `TMUX_RUN_MARK<id> <pane>`
 * (the pane's number, without its `%`) and each word as `x` and its bytes
 * in hex. tmux expands a message as a format and then with `strftime`, so
 * nothing in it may hold a `#` or a `%`: a `%5` emptied the whole message. DevHub signals `devhub-ack-<id>` (`wait-for -S`) once it
 * has it, and `devhub-done-<id>` when it is done: a popup once it has
 * closed, the rest once open.
 */
export const TMUX_RUN_MARK = "devhub-run:1 ";

/**
 * The directory, beside the script, that a pane's zsh is pointed at
 * (`ZDOTDIR`), and the variables that say what to restore.
 */
export const NVIM_SHIM_ZSH_DIRECTORY = "zsh";
export const NVIM_SHIM_VARIABLE = "DEVHUB_NVIM_SHIM";
export const USER_ZDOTDIR_VARIABLE = "DEVHUB_USER_ZDOTDIR";

/**
 * What keeps DevHub's `nvim` first on a zsh pane's PATH.
 *
 * The PATH a pane starts with has the script's directory in front, and then
 * the person's startup files run: one that puts Homebrew's directory first
 * (`export PATH=/opt/homebrew/bin:$PATH`, `brew shellenv`, macOS's
 * `path_helper`) puts Homebrew's `nvim` ahead of DevHub's, and `nvim` is the
 * TUI again. Asking the person to edit their dotfiles for it would make the
 * setting not work as said, so zsh — macOS's shell — is pointed at this file
 * first (`ZDOTDIR`). It gives `ZDOTDIR` back at once (the person's, or none),
 * so zsh reads every one of the person's own files where it always would,
 * and adds one `precmd` hook that, before each prompt, puts the script's
 * directory back in front of the PATH if anything moved it. Nothing else of
 * the shell is touched; a nested zsh started from the pane is an ordinary one.
 */
export function neovimShimZshenv(): string {
	const shim = NVIM_SHIM_VARIABLE;
	const user = USER_ZDOTDIR_VARIABLE;
	return [
		"# Generated by DevHub - do not edit. Gives ZDOTDIR back, then keeps",
		"# DevHub's nvim and tmux first on this zsh's PATH.",
		`if (( \${+${user}} )); then`,
		`\tZDOTDIR=$${user}`,
		"else",
		"\tunset ZDOTDIR",
		"fi",
		`unset ${user}`,
		"_devhub_nvim_shim_first() {",
		`\t[[ -n \${${shim}-} && \${path[1]-} != $${shim} ]] || return 0`,
		`\tpath=($${shim} \${path:#$${shim}})`,
		"}",
		"autoload -Uz add-zsh-hook && add-zsh-hook precmd _devhub_nvim_shim_first",
		"if [[ -r ${ZDOTDIR:-$HOME}/.zshenv ]]; then",
		"\tbuiltin source ${ZDOTDIR:-$HOME}/.zshenv",
		"fi",
		// A `zsh -c` (a binding's `run-shell`, a popup's command) has no prompt
		// to put it back before: once, after the person's `.zshenv`.
		"_devhub_nvim_shim_first",
		"",
	].join("\n");
}
