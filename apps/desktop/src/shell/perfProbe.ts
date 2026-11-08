/**
 * A measurement hook, compiled out of every ordinary build.
 *
 * `__DEVHUB_PERF_PROBE__` is `false` unless the pages were built with
 * `DEVHUB_PERF_PROBE=1` (`vite.config.ts`), and then the call below is dead
 * code that the bundler drops. A build made with it calls whatever a
 * measurement harness put at `globalThis.__devhubPerf` over the DevTools
 * protocol — the moment a terminal's output has been parsed, for an
 * input-to-paint figure (docs/process-model.md, "How it was measured").
 * Nothing in DevHub defines that function, so even a probe build does nothing
 * until a harness asks.
 */

declare const __DEVHUB_PERF_PROBE__: boolean;

type PerfHook = (kind: string, detail: unknown) => void;

export function perfProbe(kind: string, detail: unknown): void {
  if (!__DEVHUB_PERF_PROBE__) return;
  (globalThis as { __devhubPerf?: PerfHook }).__devhubPerf?.(kind, detail);
}
