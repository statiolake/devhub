/**
 * Browser keyboard events can report `isComposing` inconsistently around the
 * final Japanese IME key event. Keep the extra local guard at text-control
 * seams so Enter/Escape/shortcut handlers never consume composition input.
 */
export function isImeComposing(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode">,
  compositionActive = false,
): boolean {
  return event.isComposing || event.keyCode === 229 || compositionActive;
}
