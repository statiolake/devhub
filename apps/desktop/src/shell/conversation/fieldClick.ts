/**
 * A press anywhere in a composer that is not on one of its controls is a
 * press on its field: the padding, the gaps between rows, the toolbar's empty
 * stretch. It is taken on `mousedown`, and the default prevented, so the
 * field never loses focus to the frame first; the caret goes to the end.
 */

import type { MouseEvent } from "react";

/** What a press means for itself, and the field must leave alone. */
const CONTROLS =
  "button, a[href], input, select, textarea, label, summary, [role=button], [role=combobox], [role=listbox], [role=option], [contenteditable=true]";

export function pressFocusesField(
  event: MouseEvent,
  field: HTMLTextAreaElement | null,
): void {
  if (event.button !== 0 || field === null || field.disabled) return;
  if (!(event.target instanceof Element) || event.target.closest(CONTROLS))
    return;
  event.preventDefault();
  field.focus({ preventScroll: true });
  const end = field.value.length;
  field.setSelectionRange(end, end);
}
