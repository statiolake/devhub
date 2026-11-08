/**
 * Following Neovim's `:restart` (0.12) from the program that keeps a
 * Neovim's tmux pane: the `nvim` shim (`terminalNeovimShim.ts`) and the
 * `devhub-nvim` window's keeper (`managedNeovim.ts`).
 *
 * `:restart` starts a new server with the old one's arguments — the same
 * `--listen` socket — tells its UIs `restart` and exits. The new server is
 * the old one's child, not the pane's: the program waiting on the old one
 * sees it exit (status 0) while the Neovim goes on. Left at that, the shim
 * would give the pane back to the shell (and `git commit` would go on with
 * the message as it was) and the keeper's pane would close.
 *
 * So the pane's program is told what happened through a directory of its
 * own named in the server's environment (`DEVHUB_NVIM_STATE`, inherited by
 * the server a restart starts): DevHub's setup (`RESTART_STATE_LUA`, run at
 * every attach) writes the server's pid there, and at `VimLeave` either
 * `restart` (`v:exitreason`) or the exit status (`v:exiting`). After the
 * server it started exits, the program waits on each new server in turn —
 * by the pid written when DevHub's UI attaches to it
 * (`neovimUiSessions.ts`) — and ends with the last one's status: `:cq`
 * after a restart still fails a commit. Neovim 0.11 and older have no
 * `:restart` and never write `restart`: nothing changes there.
 */

/** The variable that names the directory, in the server's environment. */
export const NVIM_STATE_VARIABLE = "DEVHUB_NVIM_STATE";

/** How long a restarted server is waited for to say its pid, in tenths. */
export const NVIM_RESTART_WAIT_TENTHS = 150;

/**
 * POSIX `sh` that, after `wait` on the first server, follows its restarts:
 * it reads `$state` (the directory) and `$pid` (the server waited on), and
 * leaves the final exit status in `$status`.
 */
export function followRestartSh(): string {
	return `while [ -f "$state/restart" ]; do
	rm -f "$state/restart" "$state/exit"
	next=
	tries=0
	while [ "$tries" -lt ${String(NVIM_RESTART_WAIT_TENTHS)} ]; do
		next=$(cat "$state/pid" 2>/dev/null)
		[ -n "$next" ] && [ "$next" != "$pid" ] && kill -0 "$next" 2>/dev/null && break
		next=
		tries=$((tries + 1))
		sleep 0.1
	done
	[ -n "$next" ] || break
	pid=$next
	while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
	status=$(cat "$state/exit" 2>/dev/null)
	case $status in ''|*[!0-9]*) status=1 ;; esac
done`;
}

/**
 * Run by DevHub's setup at every attach: the pid, and at the end what the
 * exit was, for the pane's program (above). Nothing without the variable.
 */
export const RESTART_STATE_LUA = `
do
  local state = vim.env.${NVIM_STATE_VARIABLE}
  if state and state ~= "" and vim.fn.isdirectory(state) == 1 then
    pcall(vim.fn.writefile, { tostring(vim.fn.getpid()) }, state .. "/pid")
    vim.api.nvim_create_autocmd("VimLeave", {
      group = vim.api.nvim_create_augroup("devhub_gui_restart", { clear = true }),
      callback = function()
        local ok, reason = pcall(function() return vim.v.exitreason end)
        if ok and type(reason) == "string" and reason:match("^restart") then
          pcall(vim.fn.writefile, { "restart" }, state .. "/restart")
        else
          pcall(vim.fn.writefile, { tostring(vim.v.exiting or 0) }, state .. "/exit")
        end
      end,
    })
  end
end
`;
