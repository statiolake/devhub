/**
 * The bridge this page was loaded with.
 *
 * `window.devhub` is `unknown` here on purpose. Its shape is decided by which
 * preload main loaded, and main loads a different one per page
 * (`preload/<page>.ts`, and `ipc/contract.ts` for what each of them is), so
 * there is no one type it could be declared as without declaring that every
 * page can reach every member — which is the thing the split exists to end.
 * A page names its own bridge once, in its own `client.ts`, and everything on
 * that page reads it from there.
 *
 * There used to be an `AppShellClient` in front of this: an interface over the
 * bridge that components were given so a test could hand them a different one.
 * It described nothing the bridge did not, and it described it *badly* — five
 * members reached `window.devhub` around it, so the one artefact that claimed
 * to be a page's contract silently omitted `onMenuCommand`, `onTheme`,
 * `onEditorRestarting`, `onModals` and `writeClipboard`. The contract is the
 * preload now, and a test stubs `window.devhub` the way the preload fills it.
 */

declare global {
  interface Window {
    /**
     * Not `readonly`, and not typed: the terminal and agent surfaces augment
     * this same global, a test assigns it, and every page gets a different
     * shape of it. `pageBridge` is where it becomes something with members.
     */
    devhub?: unknown;
  }
}

/**
 * The bridge, as this page's own interface.
 *
 * Its absence means the page was loaded without its preload, which is not a
 * state any page can work around: every one of them exists to draw something
 * main knows and it has just been told it cannot ask.
 */
export function pageBridge<Api>(page: string): Api {
  const api = window.devhub;
  if (!api) {
    throw new Error(
      `the ${page} page was loaded without its preload: window.devhub is missing`,
    );
  }
  return api as Api;
}
