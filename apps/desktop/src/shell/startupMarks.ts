/**
 * A page's stages on the way to its first frame, as `performance` marks
 * (`devhub:<name>`), each once per page: the stability suite's startup
 * scenario (`test/stability/startup.mjs`) reads them with
 * `performance.timeOrigin`, on the clock main's `startupTrace` lines are on.
 * A mark is a few microseconds and there are a handful per page.
 */

const marked = new Set<string>();

export function startupMark(name: string): void {
  if (marked.has(name)) return;
  marked.add(name);
  performance.mark(`devhub:${name}`);
}
