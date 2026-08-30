import type { DevhubApi } from "../ipc/contract";

declare global {
  interface Window {
    readonly devhub: DevhubApi;
  }
}

/**
 * The bridge the preload installed. Its absence means the page was loaded
 * without its preload, which is not a state the App Shell can work around.
 */
export function devhub(): DevhubApi {
  if (!window.devhub) {
    throw new Error(
      "the App Shell page was loaded without its preload: window.devhub is missing",
    );
  }
  return window.devhub;
}
