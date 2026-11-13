/**
 * The right-click menu of a link the conversation's renderer draws — a
 * `devhub:` chip, a file path, a URL, an attached picture — in a GUI Agent's
 * conversation and on the Orchestrator's board alike.
 *
 * A native menu, put up by main (`showContextMenu`, the mechanism the
 * Sidebar's row menus and a diagram's menu use): only ids and labels cross;
 * the id that comes back says which of the items here to run. Copying a link
 * goes through main too (`copyText`, `copyDevhubLink`), which writes the
 * clipboard and says so in the quiet "コピーしました" notice the row menu's
 * Copy Link shows.
 *
 * Nothing in it is mouse-only. On a focused link, Shift+F10 or the menu key
 * opens the same menu under it (the platform's keyboard menu keys; Chromium
 * on macOS has none of its own), and ⌘C — with no text selected — runs the
 * item marked `copyKey`, the one a reader most often wants: the link itself.
 */

import type { KeyboardEvent, MouseEvent } from "react";
import type { ContextMenuRequestWire } from "../../ipc/contract";
import type { FileRange } from "../../ipc/conversation";
import { formatDevhubLink } from "../../model/devhubLink";

export interface LinkMenuItem {
  readonly id: string;
  readonly label: string;
  readonly run: () => unknown;
  readonly separatorBefore?: true;
  /** What ⌘C on the focused link does (one item per menu). */
  readonly copyKey?: true;
}

export type ShowMenu = (
  request: ContextMenuRequestWire,
) => Promise<string | undefined>;

/** Put `items` up at `at` and run the one chosen. */
export function openLinkMenu(
  items: readonly LinkMenuItem[],
  at: { readonly x: number; readonly y: number },
  show: ShowMenu,
  reportFailure: (error: unknown) => void,
): void {
  void show({
    items: items.map(({ id, label, separatorBefore }) =>
      separatorBefore === true ? { id, label, separatorBefore } : { id, label },
    ),
    at: { x: Math.round(at.x), y: Math.round(at.y) },
  })
    .then((chosen) => items.find((item) => item.id === chosen)?.run())
    .catch(reportFailure);
}

/** Shift+F10, or the menu key: the keyboard's right-click. */
export function isMenuKey(event: {
  readonly key: string;
  readonly shiftKey: boolean;
}): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

function isCopyKey(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "c"
  );
}

function selectionIn(element: Element): boolean {
  const selection = window.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    selection.anchorNode !== null &&
    element.contains(selection.anchorNode)
  );
}

/**
 * The handlers a link takes: a right-click, and the keys above. `items` is
 * asked for when the menu opens, so a link that is never right-clicked
 * builds nothing.
 */
export function linkMenuHandlers(
  items: () => readonly LinkMenuItem[],
  show: ShowMenu,
  reportFailure: (error: unknown) => void,
): {
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
} {
  return {
    onContextMenu: (event) => {
      // Text selected across the link is copied the ordinary way.
      if (selectionIn(event.currentTarget)) return;
      event.preventDefault();
      event.stopPropagation();
      const keyboard = event.clientX === 0 && event.clientY === 0;
      openLinkMenu(
        items(),
        keyboard ? under(event.currentTarget) : at(event),
        show,
        reportFailure,
      );
    },
    onKeyDown: (event) => {
      if (isMenuKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        openLinkMenu(items(), under(event.currentTarget), show, reportFailure);
        return;
      }
      if (isCopyKey(event) && !selectionIn(document.body)) {
        const copy = items().find((item) => item.copyKey === true);
        if (copy === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        void Promise.resolve()
          .then(() => copy.run())
          .catch(reportFailure);
      }
    },
  };
}

function at(event: MouseEvent): { x: number; y: number } {
  return { x: event.clientX, y: event.clientY };
}

/** Under the element's start, where a keyboard menu opens. */
function under(element: Element): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.bottom };
}

// --- what each kind of link offers --------------------------------------------

/** A URL: Open in Browser, Copy Link. */
export function urlMenu(
  url: string,
  ports: {
    readonly openExternalUrl: (url: string) => Promise<void>;
    readonly copyText: (text: string) => Promise<void>;
  },
): readonly LinkMenuItem[] {
  return [
    {
      id: "open",
      label: "Open in Browser",
      run: () => ports.openExternalUrl(url),
    },
    {
      id: "copy-link",
      label: "Copy Link",
      run: () => ports.copyText(url),
      copyKey: true,
    },
  ];
}

/** The `devhub:file` link to a file, at its line when it has one. */
export function fileDevhubLink(
  path: string,
  range: FileRange | undefined,
): string {
  const line =
    range === undefined
      ? undefined
      : range.kind === "line"
        ? {
            line: range.line,
            column: range.column === 1 ? undefined : range.column,
          }
        : { line: range.from, column: undefined };
  return formatDevhubLink({
    kind: "file",
    path,
    ...(line === undefined ? {} : { line: line.line }),
    ...(line?.column === undefined ? {} : { column: line.column }),
  });
}

/**
 * A file: Open, Copy Path, Copy Link (`devhub:file/…`). `path` is the file's
 * absolute path, or how to find it (a Markdown link's target, asked of main
 * when chosen; `undefined` when there is none, which the finder has said).
 */
export function fileMenu(
  path: string | (() => Promise<string | undefined>),
  range: FileRange | undefined,
  ports: {
    readonly open: () => Promise<void>;
    readonly copyText: (text: string) => Promise<void>;
  },
): readonly LinkMenuItem[] {
  const copy = async (text: (file: string) => string) => {
    const file = typeof path === "string" ? path : await path();
    if (file !== undefined) await ports.copyText(text(file));
  };
  return [
    { id: "open", label: "Open", run: ports.open },
    {
      id: "copy-path",
      label: "Copy Path",
      run: () => copy((file) => file),
      copyKey: true,
    },
    {
      id: "copy-link",
      label: "Copy Link",
      run: () => copy((file) => fileDevhubLink(file, range)),
    },
  ];
}

/** A `devhub:` link: Open, Copy Link, Copy Markdown Link. */
export function devhubMenu(
  link: string,
  ports: {
    readonly open: () => Promise<void>;
    readonly copyLink: (link: string, markdown: boolean) => Promise<void>;
  },
): readonly LinkMenuItem[] {
  return [
    { id: "open", label: "Open", run: ports.open },
    {
      id: "copy-link",
      label: "Copy Link",
      run: () => ports.copyLink(link, false),
      copyKey: true,
    },
    {
      id: "copy-markdown-link",
      label: "Copy Markdown Link",
      run: () => ports.copyLink(link, true),
    },
  ];
}

/** A picture: Open (large), Copy Image, Save Image…. */
export function imageMenu(ports: {
  readonly open: () => void;
  readonly copyImage: () => Promise<void>;
  readonly saveImage?: () => Promise<unknown>;
}): readonly LinkMenuItem[] {
  return [
    { id: "open", label: "Open", run: ports.open },
    {
      id: "copy-image",
      label: "Copy Image",
      run: ports.copyImage,
      copyKey: true,
    },
    ...(ports.saveImage === undefined
      ? []
      : [{ id: "save-image", label: "Save Image…", run: ports.saveImage }]),
  ];
}
