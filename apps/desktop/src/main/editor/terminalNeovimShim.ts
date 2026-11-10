/**
 * The `nvim` a DevHub terminal runs: DevHub's own Neovim (the one inside the
 * app here, the delivered one on a host), with the person's config, drawn by
 * DevHub over the pane it was typed in (`docs/neovim-editor.md`, "Neovim in
 * a terminal").
 *
 * # Why a program on the PATH, and which
 *
 * It has to catch `nvim` typed at a prompt and `nvim` run by another program —
 * `git commit`, `crontab -e`, `$EDITOR` — and the one thing both go through is
 * the PATH. `EDITOR`/`VISUAL` alone would miss the first, and a dotfile that
 * sets `EDITOR=nvim` (most do) would undo them. So the directory it is in
 * goes in front of every DevHub pane's PATH, as the host's `devhub` does
 * (`TmuxTerminalRuntime.panePath`).
 *
 * It is the `devhub` command itself (`cli/nvim.go`), copied into that
 * directory under the name `nvim`: the binary is DevHub's on every machine
 * (`Runtime.devhubProgram`), and run as `nvim` it is this. A copy, not a
 * link, because the pane's foreground program is what tmux names the window
 * by — `/proc/<pid>/cmdline` on Linux, `p_comm` on macOS, which is the name
 * of the file executed — and the window is to read `nvim`. What it cannot
 * discover is in a file beside it (`NVIM_SHIM_FACTS_FILE`): DevHub's Neovim
 * and tmux by their absolute paths, never looked up on the PATH, and the tty
 * reader (`NVIM_SHIM_KEYS_FILE`).
 *
 * It used to be a POSIX `sh` script that ran `tmux`, `mktemp`, `cat`,
 * `mkfifo`, a second `tmux` and an `nvim -l` launcher before the Neovim, and
 * polled tmux every 100 ms after it: about 40 ms between Enter and a Neovim
 * DevHub could attach to, against a few for this.
 *
 * It runs DevHub's Neovim with the person's own arguments, in the pane, as
 * its child, so its exit status, its environment (`GIT_*` under `git
 * commit`), its cwd and its life are the pane's, exactly as a TUI's would
 * be. What changes is only who draws it: `--embed --listen <socket>` instead
 * of the TUI, and DevHub attaches to that socket as its only UI. `--embed`
 * waits for that UI before it reads the config or opens a file, so a
 * swap-file question or a config error is drawn, never answered blind by a
 * headless Neovim. Its stdin and stdout are the embedder's channel, which
 * nothing uses: a FIFO held open by Neovim itself (EOF there would end it)
 * and `/dev/null`.
 *
 * # How DevHub learns of it — tmux, on every machine
 *
 * Nothing new is opened between the pane and DevHub. In one tmux client it
 * reads the pane and, if DevHub draws over it, names the socket in a pane
 * option of DevHub's own tmux server (`@devhub-nvim`), while the Neovim
 * starts; once that Neovim listens it writes an OSC tmux does not know
 * (`NVIM_NAMED_OSC`) into the pane, which a control client sees at once.
 * DevHub reads the option while that terminal is on screen. Its attach
 * answers in the directory named in the Neovim's environment
 * (`DEVHUB_NVIM_STATE`): `ui`, once the UI is attached and Neovim has
 * started (`neovimUi.ts`). That is the same channel on this Mac and on an
 * SSH host — the host's tmux is DevHub's there too — and needs no forwarded
 * control socket on the far side; the socket itself is reached the way the
 * managed Neovim's is (`neovimMachines.ts`).
 *
 * # When it is just `nvim`
 *
 * It `exec`s the same Neovim as a TUI, untouched, whenever DevHub would not
 * draw it: outside a DevHub pane (no `$TMUX_PANE`, or a session that is
 * neither an Agent terminal's nor a Workspace's), with the overlay off
 * (`@devhub-nvim-overlay`, a server option DevHub states while it is on),
 * inside a DevHub GUI Neovim already (`$DEVHUB_NEOVIM_GUI`, a `:terminal` in
 * it), with stdin or stdout not a terminal, with arguments that are not an
 * editing session (`--headless`, `-es`, `--remote*`, `--version`, `-`…), in
 * a pane that already has one, and when no UI attaches within ten seconds
 * (the terminal is not on screen, say): then the Neovim waiting for it is
 * ended and the TUI runs in its place, with the same arguments.
 *
 * # `:restart`
 *
 * `:restart` replaces the server with one it starts itself, on the same
 * socket: the program keeps the pane, and its exit status is the last
 * server's (`neovimRestart.ts`).
 *
 * # What tmux writes into the pane
 *
 * Once the UI is attached the pane's tty is read for that Neovim:
 * `send-prefix`, a `send-keys` binding, `paste-buffer` (`terminalNeovimTtyKeys.ts`).
 */

import { shellQuote } from "../runtime/quote.js";
import { TTY_KEYS_LUA } from "./terminalNeovimTtyKeys.js";

/** The pane option the program names its socket in. */
export const NVIM_SOCKET_OPTION = "@devhub-nvim";
/** The server option that says the overlay is on (`1`). */
export const NVIM_OVERLAY_OPTION = "@devhub-nvim-overlay";
/** How long it waits for DevHub's UI before it runs the TUI, in tenths. */
export const NVIM_UI_WAIT_TENTHS = 100;
/** Beside the `nvim` copy: what it cannot discover (`cli/nvim.go`'s `NvimFacts`). */
export const NVIM_SHIM_FACTS_FILE = "nvim-shim.json";
/** Beside it too: the tty reader it runs once attached (`TTY_KEYS_LUA`). */
export const NVIM_SHIM_KEYS_FILE = "nvim-keys.lua";

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

/** The facts file, for a `nvim` in `directory` (the tty reader beside it). */
export function neovimShimFacts(
	facts: NeovimShimFacts,
	directory: string,
): string {
	return `${JSON.stringify({
		nvim: facts.nvim,
		tmux: facts.tmux,
		sessionPrefixes: facts.sessionPrefixes,
		uiWaitTenths: facts.uiWaitTenths ?? NVIM_UI_WAIT_TENTHS,
		keys: `${directory}/${NVIM_SHIM_KEYS_FILE}`,
	})}\n`;
}

/** The tty reader's file (`NVIM_SHIM_KEYS_FILE`). */
export function neovimShimKeys(): string {
	return TTY_KEYS_LUA;
}

/**
 * POSIX `sh` that puts the `devhub` binary at `program` in `directory` as
 * `nvim` (`$1` the binary, `$2` the directory): copied beside its final name
 * and renamed over it, so a `nvim` running from the old copy keeps its file
 * and a new one never starts from half a copy; nothing is written when the
 * copy there is already that binary.
 */
export const INSTALL_NEOVIM_SHIM_SH = `cmp -s "$1" "$2/nvim" 2>/dev/null && exit 0
cp "$1" "$2/.nvim.$$" && chmod 755 "$2/.nvim.$$" && mv -f "$2/.nvim.$$" "$2/nvim" || { rm -f "$2/.nvim.$$"; exit 1; }`;

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
