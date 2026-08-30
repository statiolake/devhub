/**
 * A workbench's last frame, standing in for the workbench.
 *
 * Shared by everything that has to appear above a native view — a DevHub
 * modal, a workbench's own dialog — because they all face the same fact: DOM
 * cannot be painted over a `WebContentsView`, so the view stands down, and
 * without this the editor would vanish rather than dim.
 */

export function SurfaceBackdrop({ src }: { readonly src?: string }) {
  if (!src) return null;
  return (
    <img
      className="surface-backdrop"
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
