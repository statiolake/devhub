/**
 * One place that knows a failure happened, and one rule for how long it shows.
 *
 * Nothing in the App Shell catches its own errors. Everything — a rejected call
 * to main, a render that threw, an unhandled rejection anywhere on the page —
 * arrives here, and the page draws whatever is here. A failure stays until the
 * person dismisses it or a newer failure replaces it; no unrelated event, and
 * no routine state update, may clear it.
 */

export interface Failure {
  readonly summary: string;
  readonly detail: string;
}

type Listener = (failure: Failure | undefined) => void;

const listeners = new Set<Listener>();
let current: Failure | undefined;

function describe(reason: unknown): Failure {
  if (reason instanceof Error) {
    return { summary: reason.message, detail: reason.stack ?? String(reason) };
  }
  return { summary: "Something went wrong", detail: String(reason) };
}

export function reportFailure(reason: unknown): void {
  current = describe(reason);
  for (const listener of listeners) {
    listener(current);
  }
}

export function dismissFailure(): void {
  current = undefined;
  for (const listener of listeners) {
    listener(undefined);
  }
}

export function currentFailure(): Failure | undefined {
  return current;
}

export function subscribeToFailures(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The root handler. Installed once, from the page's entry point. */
export function installRootFailureHandler(): void {
  window.addEventListener("error", (event) =>
    reportFailure(event.error ?? event.message),
  );
  window.addEventListener("unhandledrejection", (event) =>
    reportFailure(event.reason),
  );
}
