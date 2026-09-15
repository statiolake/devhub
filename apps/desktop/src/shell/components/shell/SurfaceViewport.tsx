/**
 * What is left for the window's own page to draw in the content area.
 *
 * Almost nothing, and that is the point. A workbench is a native view the
 * owner lays over this rectangle; an Agent is another view beside or over it.
 * Neither is here. What is here is the three states in which there is no view
 * to show — starting up, a workbench being rebuilt, a Workspace whose folder
 * has gone — and the seam between the two halves of a split.
 *
 * Those states belong to this page rather than to a fourth view because they
 * are drawn *in place of* a child, in that child's own rectangle, and a view
 * that existed only to say "there is nothing here" would be a renderer for an
 * empty room. The window's own page is already under every child and already
 * the whole window; drawing in the rectangle a child is not covering costs it
 * nothing.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  clampSplitRatio,
  workspaceForContext,
  type AppSnapshot,
  type WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { useAppShell } from "../../useAppShell";
import { devhub } from "../../client";
import { closeDiagnosticLabel, closeFailureLabel } from "./diagnosticLabel";
import { Failure, Waiting } from "./SurfaceState";
import { useRestartingEditors } from "./workbenchDialogs";
import type { WorkbenchAreaWire } from "../../../ipc/contract";

/**
 * The rectangle main laid the workbench into, as it says so.
 *
 * `undefined` until the first one arrives, which is one frame at launch and
 * never again — and this page draws nothing at all until it has one, because
 * there is no rectangle to guess. The page used to measure this element with a
 * `ResizeObserver` and report it back, which made main's idea of the layout a
 * page's idea of it, one frame late, and made every window resize a round trip
 * through a renderer.
 */
function useWorkbenchArea(): WorkbenchAreaWire | undefined {
  const [area, setArea] = useState<WorkbenchAreaWire | undefined>(undefined);
  useEffect(() => devhub().onWorkbenchArea(setArea), []);
  return area;
}

export interface SurfaceViewportProps {
  readonly snapshot: AppSnapshot;
}

/**
 * The divider between the workbench and an Agent's pane.
 *
 * It has to be a real element of its own, between the two panes, rather than a
 * hairline drawn on the edge of either: the workbench is a native view that
 * main lays over the hole this page leaves for it, and a native view paints
 * over everything in the page. A divider on top of the hole would be invisible
 * — and a divider drawn on the Agent pane's leading edge would put its grab
 * area a few pixels from where the eye says the seam is. So the seam *is* this
 * element, the hole stops where it starts, and the pointer meets the same
 * pixels it can see.
 */
function SplitDivider({
  ratio,
  onPreview,
  onCommit,
  area,
}: {
  readonly ratio: number;
  readonly onPreview: (ratio: number) => void;
  readonly onCommit: (ratio: number) => void;
  /** Where the content area starts and how wide it is, in window pixels. */
  readonly area: { readonly left: number; readonly width: number };
}) {
  const [dragging, setDragging] = useState(false);
  const preview = useRef(ratio);

  // Against the content area, which is what the ratio is a ratio *of* — not
  // against this element's neighbours, because its neighbours are native views
  // and this document cannot measure them. The numbers are the owner's: the
  // area begins where the workbench's rectangle begins and runs to the
  // window's trailing edge.
  const ratioAt = (clientX: number): number | undefined => {
    if (area.width <= 0) return undefined;
    return clampSplitRatio((clientX - area.left) / area.width);
  };

  useEffect(() => {
    if (!dragging) return undefined;
    document.body.classList.add("is-resizing-split");
    return () => document.body.classList.remove("is-resizing-split");
  }, [dragging]);

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (dragging) onCommit(preview.current);
    setDragging(false);
  };

  const step = (delta: number) => onCommit(clampSplitRatio(ratio + delta));

  return (
    <div
      className={`split-divider${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-label="Resize the agent pane"
      aria-orientation="vertical"
      aria-valuemin={25}
      aria-valuemax={85}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        preview.current = ratio;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const next = ratioAt(event.clientX);
        if (next === undefined) return;
        preview.current = next;
        onPreview(next);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          step(-0.02);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          step(0.02);
        }
      }}
    />
  );
}

/** Why this Workspace cannot be shown, in the Sidebar's own vocabulary. */
export function Unavailable({
  workspace,
  actions,
  onClose,
}: {
  readonly workspace: WorkspaceSnapshot | undefined;
  readonly actions: React.ComponentProps<typeof Failure>["actions"];
  /** Main's one close. Not an intent: see `closeWorkspace` in the client. */
  readonly onClose: () => void;
}) {
  if (!workspace) {
    return <Failure summary="The selected context is no longer available." />;
  }
  const state = workspace.state;
  const close = workspace.close;
  if (close.kind === "running") {
    return <Waiting label="Closing the workspace…" />;
  }
  // Two facts, not one: a folder that has gone missing and a close that
  // stopped are independent, and either used to overwrite the other. The
  // close is the newer news, so it is what the pane leads with.
  const closeFailed = close.kind === "failed";
  const detail =
    close.kind === "failed"
      ? closeFailureLabel(close.step, close.diagnostic, close.detail)
      : state.kind === "unavailable"
        ? closeDiagnosticLabel(state.reason)
        : workspace.root;
  return (
    <Failure
      summary={
        closeFailed
          ? "This Workspace could not be closed."
          : "This workspace is unavailable."
      }
      detail={detail}
      /**
       * A failed close is answered where it is read. It used to say "retry
       * close from the Sidebar" and offer nothing: the pane a person was
       * looking at stated a problem, named a control somewhere else, and could
       * not be put away — which is what a workspace nobody could close looked
       * like from the inside.
       */
      actions={
        closeFailed
          ? [{ label: "Close Workspace", primary: true, run: onClose }]
          : state.kind === "unavailable"
            ? actions
            : undefined
      }
    />
  );
}

/**
 * The states there is no child view to show, drawn where that child would be.
 *
 * The rectangle is the owner's, pushed here (`WorkbenchAreaWire`), and this
 * element is laid at exactly it — absolutely, over the window's own page,
 * rather than as a flex item in a row that no longer exists. There is no
 * "hole" any more: what used to be a hole with a native view over it is a
 * native view, and what used to be the row around it is four sibling views the
 * owner places.
 *
 * The seam is the one thing here that is not a state. It is a real element in
 * the one strip of the content area no child covers, which is exactly what
 * makes it draggable: a hairline drawn on a native view's edge would be
 * painted over, and one hung off the Agent's leading edge would put the grab
 * area a few pixels from where the eye says the seam is.
 */
export function SurfaceViewport({ snapshot }: SurfaceViewportProps) {
  const { dispatch, closeWorkspace, chooseWorkspaceFolder } = useAppShell();
  const layout = snapshot.layout;
  const workspace = workspaceForContext(snapshot, snapshot.selection.context);
  const restartingEditors = useRestartingEditors();
  const area = useWorkbenchArea();

  // The divider moves under the pointer; the model learns where it stopped.
  // Sending an intent per pointer move would put a round trip in the middle of
  // a drag, and the drag is the one thing that has to feel direct.
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const ratio = dragRatio ?? snapshot.splitRatio;
  const commitRatio = useCallback(
    (next: number) => {
      setDragRatio(next);
      void dispatch({ type: "resize_split", ratio: next }).finally(() => {
        setDragRatio(null);
        // The model has the number now, so the preview is over: main goes back
        // to reading the seam off the projection like everything else.
        void devhub().previewLayout({ splitRatio: null });
      });
    },
    [dispatch],
  );

  // A drag moves the seam under the pointer, and both panes are native views
  // main has to move with it. The *pointer* is what is reported — the number
  // this page owns — and never a rectangle.
  const previewRatio = useCallback((next: number) => {
    setDragRatio(next);
    void devhub().previewLayout({ splitRatio: next });
  }, []);

  const unavailableActions =
    workspace?.state.kind === "unavailable"
      ? ([
          {
            label: "Retry",
            primary: true,
            run: () =>
              void dispatch({
                type: "retry_workspace",
                workspaceId: workspace.id,
              }),
          },
          {
            label: "Locate…",
            run: () =>
              void chooseWorkspaceFolder().then((path) => {
                if (path)
                  void dispatch({
                    type: "locate_workspace",
                    workspaceId: workspace.id,
                    path,
                  });
              }),
          },
          {
            // Main's one close, the same one the Sidebar's button asks for.
            // This used to dispatch the raw lifecycle intent, which went around
            // the worktree rule entirely — so closing an unavailable worktree
            // from the Sidebar deleted the folder and closing the same
            // workspace from this pane did not.
            label: "Close",
            run: () => {
              closeWorkspace(workspace.id);
            },
          },
        ] as const)
      : undefined;

  let surfaceState: string;
  let body: ReactNode = null;
  let editorKey: string | undefined;
  // Only the transient states announce themselves; a workbench speaks for
  // itself, and `aria-live` on it would narrate every frame of output.
  let announce = true;

  if (snapshot.readiness !== "ready") {
    surfaceState = "loading";
    body = <Waiting label="Connecting…" />;
  } else if (layout.kind === "unavailable") {
    surfaceState = workspace?.state.kind ?? "unavailable";
    body = (
      <Unavailable
        workspace={workspace}
        actions={unavailableActions}
        onClose={() => {
          if (workspace) closeWorkspace(workspace.id);
        }}
      />
    );
  } else if (layout.kind === "agent") {
    // The Agents' view covers this rectangle entirely, so there is nothing to
    // draw under it. The workbenches stay built and running behind both: this
    // is an Agent covering a workbench, not a workbench going away.
    surfaceState = "agent";
  } else if (restartingEditors.has(layout.editorKey)) {
    // The workbench is being rebuilt in this same slot. The selection has not
    // moved and must not: what changed is that there is nothing to show yet,
    // which is a state of this area rather than a reason to leave it.
    surfaceState = "editor-restarting";
    editorKey = layout.editorKey;
    body = <Waiting label="Restarting the editor…" />;
  } else {
    surfaceState = layout.kind;
    editorKey = layout.editorKey;
    announce = false;
  }

  // Nothing at all until the owner has said where this rectangle is. One frame
  // at launch, and never again — and a guessed rectangle for that frame would
  // be the page having an opinion about the layout, which is the whole thing
  // this direction of travel removes.
  if (!area) return null;
  const split = layout.kind === "split";
  const content = { left: area.x, width: window.innerWidth - area.x };

  return (
    <>
      <section
        className="surface"
        aria-label="Surface"
        aria-busy={snapshot.readiness !== "ready" ? "true" : undefined}
        aria-live={announce ? "polite" : undefined}
        data-surface-key={editorKey}
        data-surface-state={surfaceState}
        style={{
          left: `${String(area.x)}px`,
          top: `${String(area.y)}px`,
          width: `${String(area.width)}px`,
          height: `${String(area.height)}px`,
        }}
      >
        {body}
      </section>
      {split ? (
        <div
          className="split-seam"
          style={{
            left: `${String(area.x + area.width)}px`,
            top: `${String(area.y)}px`,
            height: `${String(area.height)}px`,
          }}
        >
          <SplitDivider
            ratio={ratio}
            onPreview={previewRatio}
            onCommit={commitRatio}
            area={content}
          />
        </div>
      ) : null}
    </>
  );
}
