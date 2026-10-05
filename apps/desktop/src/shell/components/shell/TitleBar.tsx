/**
 * The title bar DevHub draws for itself.
 *
 * macOS will draw a window a title bar, and it draws it in the system's
 * colour. DevHub's chrome is the Workbench's colour theme — the Sidebar is
 * `--chrome`, and so is everything around it — so a system bar is a band of
 * somebody else's grey sitting on top of a window that is not that grey, in
 * both appearances and under every theme. There is no setting that fixes
 * that; the colour is not DevHub's to choose.
 *
 * So the window is a `hiddenInset` one — a transparent native bar with the
 * traffic lights inset and no title text of its own — and this is the bar. It
 * is the same surface as the Sidebar and continues into it with no seam: one
 * chrome, from the top of the window down the leading edge, and a hairline
 * only where that chrome meets the content area. See `shellWindowOptions`,
 * which is where the argument for the window's shape is written.
 *
 * **Double-clicking it zooms the window, and there is no code here for that.**
 * A `-webkit-app-region: drag` area is not a CSS hit-test: Electron hands its
 * rectangles to macOS, which takes the mouse before the page sees it and
 * performs whatever "Double-click a window's title bar to" is set to — zoom,
 * by default. It is the same thing that makes double-clicking the Sidebar zoom
 * the window in the other chrome. A `maximize`/`unmaximize` over IPC would be
 * a second answer racing the first, and it would ignore the person's setting.
 *
 * What it carries is what a macOS bar carries. The lights are the window's
 * own, still drawn by the system into the room this bar reserves for them;
 * the name is the one main composed (`shellTitle.ts`), read rather than
 * recomposed, so the bar and Mission Control cannot say different things
 * about the same window; and the whole band is the window's handle, with
 * everything that does something opting out of the drag region.
 *
 * The one control is the Sidebar's, and it is here rather than in the Sidebar
 * for the reason Finder's is: it has to be reachable when the Sidebar is a
 * rail, and a rail that had to be wide enough for a button would be a rail
 * sized by its chrome again. It dispatches the same `toggle_sidebar` the chord
 * does, so there is one path from either.
 *
 * Beside it are Back and Forward, for the same reason they are beside the
 * sidebar button in Finder: they are about the window — which place it is
 * showing — and not about anything inside one place. **They always walk the
 * app's history** (`model/navigationHistory.ts`), never an editor's. The bar
 * is the shell's chrome, above every surface at once, so an arrow here whose
 * meaning changed with which pane last had the keyboard would be a button you
 * could not predict by looking at it; the editor's own Back and Forward are
 * VS Code's, on VS Code's keys and the mouse's side buttons over the editor.
 * Each is disabled when there is nowhere it would go, which the model answers
 * with the same rule the move itself obeys, skipped places and all.
 */

import { useShellPage } from "../../ShellPageContext";
import type { AppIntent } from "../../../ipc/appShell";

export interface TitleBarProps {
  /** Whether the Sidebar is a rail right now — what the button reports. */
  readonly sidebarCollapsed: boolean;
  /** Whether Back would go anywhere. */
  readonly canGoBack: boolean;
  /** Whether Forward would go anywhere. */
  readonly canGoForward: boolean;
  readonly onDispatch: (intent: AppIntent) => void;
}

/**
 * The sidebar mark: a pane with a narrower one held off its leading edge.
 *
 * `sidebar-glyph` is the shared convention — a 16-unit box with the drawing in
 * the 12 units from 2 to 14, stroked in `currentcolor` at one weight — so the
 * bar's one mark is drawn on the same grid as every mark below it. The shape
 * is here rather than in `sidebar/icons.tsx` because it is not a Sidebar mark:
 * it belongs to the bar, and the bar is not the Sidebar.
 */
function SidebarMark() {
  return (
    <svg
      className="sidebar-glyph"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6.5 3v10" />
    </svg>
  );
}

/** Back and Forward: a chevron, on the same grid as the sidebar mark. */
function ChevronMark({
  direction,
}: {
  readonly direction: "back" | "forward";
}) {
  return (
    <svg
      className="sidebar-glyph"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={
          direction === "back"
            ? "M10 3.5 5.5 8l4.5 4.5"
            : "M6 3.5 10.5 8 6 12.5"
        }
      />
    </svg>
  );
}

/**
 * What the arrows' tooltips name. `Cmd+[` and `Cmd+]` are main's
 * (`main/shell/historyKeys.ts`), answered over DevHub's own pages; over an
 * editor those keys are VS Code's, and so is its Back and Forward.
 */
export const BACK_TITLE = "Back (Cmd+[)";
export const FORWARD_TITLE = "Forward (Cmd+])";

export function TitleBar({
  sidebarCollapsed,
  canGoBack,
  canGoForward,
  onDispatch,
}: TitleBarProps) {
  const { windowTitle } = useShellPage();

  return (
    // A `header`, not a `div`: it is the window's banner, and it is the only
    // thing in this page that is.
    <header className="title-bar">
      <div className="title-bar-leading">
        <button
          type="button"
          className="title-bar-button"
          aria-label="Toggle Sidebar"
          aria-pressed={!sidebarCollapsed}
          title="Toggle Sidebar (Cmd+Q B)"
          onClick={() => {
            onDispatch({ type: "toggle_sidebar" });
          }}
        >
          <SidebarMark />
        </button>
        <button
          type="button"
          className="title-bar-button"
          aria-label="Back"
          title={BACK_TITLE}
          disabled={!canGoBack}
          onClick={() => {
            onDispatch({ type: "navigate_history", direction: "back" });
          }}
        >
          <ChevronMark direction="back" />
        </button>
        <button
          type="button"
          className="title-bar-button"
          aria-label="Forward"
          title={FORWARD_TITLE}
          disabled={!canGoForward}
          onClick={() => {
            onDispatch({ type: "navigate_history", direction: "forward" });
          }}
        >
          <ChevronMark direction="forward" />
        </button>
      </div>
      {/*
        Centred in the window rather than in the room left over, which is what
        macOS does: the leading and trailing insets are the same token, so what
        is between them is centred on the window's middle whatever is in it.
        Inert to the pointer, so the band under it stays a drag handle.
      */}
      <div className="title-bar-name">{windowTitle}</div>
    </header>
  );
}
