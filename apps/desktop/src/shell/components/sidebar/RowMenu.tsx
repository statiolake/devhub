/**
 * The context menu a Sidebar row opens on a right-click.
 *
 * It is a DOM menu rather than a native `Menu.popup`, for the same reason the
 * Sidebar is a DOM tree rather than an `NSOutlineView`: the shell page owns its
 * own chrome, and a native popup would need a channel, a serialised template
 * and a reply for every item — one more place for the row's actions and the
 * menu's actions to drift apart. Everything here is dispatched exactly the way
 * the row's own buttons dispatch.
 *
 * It closes on Escape, on a click anywhere else, and on choosing something. It
 * does not close on scroll or on a snapshot arriving: a menu that vanished
 * because a status changed underneath it would take the person's aim with it.
 */

import { useEffect, useLayoutEffect, useRef } from "react";

export interface RowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
}

export interface RowMenuProps {
  readonly items: readonly RowMenuItem[];
  /** Viewport coordinates of the click that opened it. */
  readonly at: { readonly x: number; readonly y: number };
  readonly label: string;
  readonly onDismiss: () => void;
}

export function RowMenu({ items, at, label, onDismiss }: RowMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus the menu itself, so Escape and arrow keys reach it and so the row
  // behind it stops looking like the thing keys go to.
  useLayoutEffect(() => {
    menuRef.current?.focus();
  }, []);

  useEffect(() => {
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      onDismiss();
    };
    // Capture, so a click on any control below closes the menu before that
    // control acts on it.
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("contextmenu", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("contextmenu", dismiss, true);
    };
  }, [onDismiss]);

  return (
    <div
      ref={menuRef}
      className="row-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: `${String(at.x)}px`, top: `${String(at.y)}px` }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          className="row-menu-item"
          type="button"
          role="menuitem"
          onClick={() => {
            item.run();
            onDismiss();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
