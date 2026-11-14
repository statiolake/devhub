/**
 * A still copy of part of the page as it is drawn now: what a window that
 * goes keeps showing while it is covered (`WindowMotion`), its grid's
 * picture and, over it, a copy of what the page drew there (a view, a
 * framed view's chrome, a document). The elements themselves are React's,
 * which lets go of them as the window closes; the copy is nobody's.
 *
 * `cloneNode` copies the elements and their styles but not what is only
 * drawn — a canvas's pixels — nor where an element is scrolled to: the
 * pixels are copied here, the scroll offsets once the copy is in the page
 * (`putPicture`), where an element can be scrolled. A frame (an iframe) is
 * left out: a copy would load its page again.
 */

const scrolls = new WeakMap<
  HTMLElement,
  readonly (readonly [Element, number, number])[]
>();

export function domPicture(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  const from = [el, ...el.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  const offsets: (readonly [Element, number, number])[] = [];
  from.forEach((source, i) => {
    const target = to[i];
    if (target === undefined) return;
    if (source.scrollTop !== 0 || source.scrollLeft !== 0)
      offsets.push([target, source.scrollTop, source.scrollLeft]);
    if (
      source instanceof HTMLCanvasElement &&
      target instanceof HTMLCanvasElement &&
      source.width > 0 &&
      source.height > 0
    ) {
      try {
        target.getContext("2d")?.drawImage(source, 0, 0);
      } catch {
        // a canvas with another context: left blank
      }
    }
  });
  for (const frame of copy.querySelectorAll("iframe")) frame.remove();
  // Not focusable, not hit: a picture.
  copy.inert = true;
  copy.style.pointerEvents = "none";
  scrolls.set(copy, offsets);
  return copy;
}

/** `picture` (`domPicture`) put in `parent`, scrolled as its original was. */
export function putPicture(parent: HTMLElement, picture: HTMLElement): void {
  if (picture.parentElement !== parent) parent.append(picture);
  for (const [el, top, left] of scrolls.get(picture) ?? []) {
    el.scrollTop = top;
    el.scrollLeft = left;
  }
}
