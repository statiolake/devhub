/**
 * The frame every drawn preview sits in (`Preview.tsx`): the code block's
 * quiet header — the language, the toggle, the kind's own buttons, a copy —
 * over the drawing, with a right-click that opens a native menu of the kind's
 * items.
 */

import type { MouseEvent, ReactNode } from "react";
import { useConversationActions } from "./ConversationContext";
import type { PreviewKindId } from "./previewKinds";

/** One item of a preview's right-click menu, and what choosing it does. */
export interface PreviewMenuItem {
  readonly id: string;
  readonly label: string;
  readonly run: () => Promise<void>;
  readonly separatorBefore?: true;
}

/**
 * A right-click that opens `items` as a native menu at the click and runs the
 * one chosen. A right-click on text selected inside the drawing is left to
 * the page, so a selection can still be copied the ordinary way.
 */
export function usePreviewMenu(
  items: readonly PreviewMenuItem[],
): (event: MouseEvent) => void {
  const { showContextMenu, reportFailure } = useConversationActions();
  return (event: MouseEvent) => {
    const selection = window.getSelection();
    if (
      selection !== null &&
      !selection.isCollapsed &&
      event.currentTarget.contains(selection.anchorNode)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void showContextMenu({
      items: items.map(({ id, label, separatorBefore }) =>
        separatorBefore === true
          ? { id, label, separatorBefore }
          : { id, label },
      ),
      at: { x: event.clientX, y: event.clientY },
    })
      .then((chosen) => items.find((item) => item.id === chosen)?.run())
      .catch(reportFailure);
  };
}

/** The language a header names: the fence's first word, else the kind's. */
export function headerLanguage(
  info: string | undefined,
  fallback: string,
): string {
  return info?.trim().split(/\s+/u, 1)[0] || fallback;
}

/**
 * The frame every drawn preview sits in: the code block's header — the
 * language, then `actions`, then the copy — over the drawing.
 */
export function PreviewFigure({
  kind,
  language,
  actions,
  copy,
  menu,
  className,
  children,
  label,
}: {
  readonly kind: PreviewKindId;
  readonly language: string;
  readonly actions: ReactNode;
  readonly copy?: ReactNode;
  readonly menu?: readonly PreviewMenuItem[];
  readonly className?: string;
  readonly children: ReactNode;
  /** The figure's accessible name: "Marp slides". */
  readonly label?: string;
}) {
  const onContextMenu = usePreviewMenu(menu ?? []);
  return (
    <figure
      className={`conversation-diagram conversation-preview${className === undefined ? "" : ` ${className}`}`}
      data-kind={kind}
      aria-label={label}
      onContextMenu={menu === undefined ? undefined : onContextMenu}
    >
      <div className="conversation-code-header">
        <span className="conversation-code-language">{language}</span>
        <span className="conversation-code-actions">
          {actions}
          {copy}
        </span>
      </div>
      {children}
    </figure>
  );
}
