import { useEffect, useRef } from "react";
import { familyOf, kindOf, markPath, type Kind } from "../neovim/kinds";
import "./completionMenu.css";

/**
 * A completion menu, one look across DevHub (`completionMenu.css`): the
 * Neovim editor's (`ext_popupmenu`, `neovim/NeovimApp.tsx`) and the tmux
 * prompt's in a control-mode terminal (`terminal/control/`). Words on the
 * editor's rows; the kind as a mark in the kind's own colour (`kinds.ts`);
 * the kind's name and the item's source in the UI face, labels about the
 * word. The selected row is kept in view. Where it is and its colours are
 * the caller's (`style`).
 */

export interface CompletionItem {
  readonly word: string;
  /** A kind as Neovim or LSP names it (`kindOf`), or `""`: its label. */
  readonly kind: string;
  /** The mark, when `kind` is a name of the caller's own (tmux's "option"). */
  readonly mark?: Kind;
  /** The item's source or a note about it, shown after the kind. */
  readonly extra?: string;
}

/** A completion kind's mark (`kinds.ts`): a cap-height square on the baseline. */
export function KindMark({
  kind,
  color,
}: {
  readonly kind: Kind | undefined;
  readonly color: string | undefined;
}) {
  if (!kind) return <span className="completion-menu-mark" />;
  const mark = markPath(familyOf(kind), 10);
  return (
    <svg
      className="completion-menu-mark"
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <path
        d={mark.d}
        fill={mark.fill ? color : "none"}
        stroke={mark.fill ? "none" : color}
        strokeWidth={mark.stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CompletionMenu({
  items,
  selected,
  style,
  kindColour,
  onChoose,
}: {
  readonly items: readonly CompletionItem[];
  /** The selected row; -1 none. */
  readonly selected: number;
  readonly style: React.CSSProperties;
  /** The colour of a kind's mark; `currentcolor` when none. */
  readonly kindColour?: (kind: Kind) => string | undefined;
  readonly onChoose?: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".completion-menu-selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, items]);
  return (
    <div
      className="completion-menu"
      style={style}
      role="listbox"
      ref={listRef}
      // The keys stay where they are typed.
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        const kind = item.mark ?? kindOf(item.kind);
        const label =
          item.mark !== undefined
            ? item.kind.trim()
            : (kind ?? item.kind.trim());
        return (
          <div
            key={index}
            role="option"
            aria-selected={index === selected}
            className={
              index === selected
                ? "completion-menu-item completion-menu-selected"
                : "completion-menu-item"
            }
            onMouseDown={() => onChoose?.(index)}
          >
            <KindMark
              kind={kind}
              color={(kind && kindColour?.(kind)) ?? "currentcolor"}
            />
            <span className="completion-menu-word">{item.word}</span>
            {label !== "" ? (
              <span className="completion-menu-kind">{label}</span>
            ) : null}
            {item.extra ? (
              <span className="completion-menu-extra">{item.extra}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
