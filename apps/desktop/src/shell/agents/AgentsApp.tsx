/**
 * Every Agent, in one view.
 *
 * # Why one view and not one per Agent
 *
 * An Agent's pane is an xterm.js instance attached to a tmux session that
 * lives in main. The terminal is cheap and the session is not drawn at all
 * while it is hidden, so there is nothing to win by giving each Agent a
 * renderer of its own and a great deal to lose: a new view per Agent is a new
 * process per Agent, a new page load between selecting one and seeing it, and
 * a scrollback that has to be re-attached every time somebody switches back.
 * So every running Agent is mounted here, all the time, and the selection
 * decides which of them is not `hidden`. Coming back to an Agent is unhiding a
 * pane.
 *
 * The frames already arrive per surface — `channelId` is the routing key in
 * `preload/terminal.ts`, and the demux is per page — so hosting every Agent in
 * one page costs the transport nothing.
 *
 * # Where this view is
 *
 * Wherever the owner puts it: over the whole content area when an Agent is
 * what is selected, and the trailing share of it when one is open beside its
 * editor. This page does not lay out a split and has no idea it is in one.
 * That used to be a flexbox in the window's own document with a native view
 * laid into a hole in it; it is two rectangles the owner computes now
 * (`main/shell/windowLayout.ts`, `agentsRect`).
 *
 *
 * # `window.innerWidth` is not the window
 *
 * This page is a `WebContentsView`, and what it measures is its own box — one
 * frame stale after main calls `setBounds` on it. Nothing here reads it, and
 * nothing here should: where anything is, is `main/shell/windowLayout.ts`, and
 * a page that needs a number from it is told the number.
 * # Its contract with main
 *
 * - **reads**: the snapshot (the running Agents, the selection, each Agent's
 *   `failure` and `injection`), the appearance (the terminal's font and
 *   theme), and the palette.
 * - **is pushed**: `snapshotChanged`, `appearanceChanged`, `themeChanged`.
 * - **asks**: the terminal channels (`ipc/terminal.ts`), `dispatch`, `openModal` (an injection to review), `writeClipboard` (OSC 52,
 *   which cannot go through `navigator.clipboard` because that is gated on the
 *   document being focused and a PTY writes at a moment nobody chose).
 * - **draws no failure it raised**: what goes wrong here is handed to main and
 *   drawn on the `toasts` view. An Agent's *own* failure is not that — it is a
 *   fact about that Agent, read off the projection, and it is drawn over that
 *   Agent's pane because that is where its subject is.
 */

import { AgentsProvider } from "./AgentsContext";
import { useAgents } from "./AgentsContext";
import { AgentPane } from "./AgentPane";

export function AgentsApp() {
  return (
    <AgentsProvider>
      <Panes />
    </AgentsProvider>
  );
}

/**
 * The panes, once there is a projection to say which Agents there are.
 *
 * Nothing is drawn before that — not a spinner. This view is only ever on
 * screen when an Agent is selected, and an Agent cannot be selected before the
 * projection that names it has arrived, so "loading" here is a state nobody
 * can see.
 */
function Panes() {
  const { state, appearance } = useAgents();
  if (state.status !== "ready") return null;
  const layout = state.snapshot.layout;
  // Which Agent is on screen is the projection's answer, read the one way it
  // is read everywhere: off `layout`, which is already the single answer to
  // "what is in the content area". Asking the selection separately would be a
  // second reading of the same fact, free to disagree with the first.
  const activeKey =
    layout.kind === "agent" || layout.kind === "split"
      ? layout.agentKey
      : undefined;
  return (
    <div className="app-shell agents-page">
      <AgentPane
        snapshot={state.snapshot}
        appearance={appearance}
        activeKey={activeKey}
      />
    </div>
  );
}
