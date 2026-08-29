/**
 * Dev-only trace of the Editor's start.
 *
 * The start crosses three layers — a Tauri command, a dynamically imported
 * bundle, and VS Code's own initialisation — and a stall in any of them looks
 * the same from the outside: a Surface that is still waiting. Compiled out of
 * release builds.
 */
export function trace(step: string, detail?: unknown): void {
  if (!import.meta.env.DEV) return;
  if (detail === undefined) {
    console.log(`[devhub:editor] ${step}`);
    return;
  }
  console.log(`[devhub:editor] ${step}`, detail);
}
