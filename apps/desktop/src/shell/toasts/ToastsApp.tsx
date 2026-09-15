/**
 * The page the application speaks from.
 *
 * Its own view, its own entry, its own root handler. Nothing else is drawn
 * here: no sidebar, no title bar, no surfaces, no model. It is the smallest
 * page DevHub has, and that is what makes it the right one to draw failures on
 * — it has nothing else that could fail while it is telling you something
 * failed.
 *
 * # The whole contract, said once
 *
 * **Arriving from main**
 * - `devhub:native-error` — an app-scoped failure. Drawn, and *never raised
 *   again*: that is the page-side half of the one-way rule, and the half that
 *   stopped the echo. See `main/shell/publishAudience.ts`.
 * - `devhub:app-condition` — a standing condition going up, or its own source
 *   taking it down.
 * - `devhub:menu-command` — only `dismiss_alert`, which is `Cmd+Q D`. Main
 *   sends it to the page that has notices, which is this one.
 * - `devhub:action-started` — the person asked DevHub for something. One of
 *   the three rules that retire a failure, and the only one this page cannot
 *   see for itself: it has no model, so main says it.
 * - `devhub:theme-changed` — the palette, handled outside React by
 *   `installPalette`, so the notices wear the Workbench's colours.
 *
 * **Leaving for main**
 * - `devhub:raise-failure` — what began *here*: this page's root handler, and
 *   its own rejected calls. One way, so telling main cannot itself fail into
 *   the handler that told it.
 * - `devhub:toasts-size` — how much room the stack takes. This page's view is
 *   exactly that big, because a native view takes every click inside its
 *   bounds whether or not anything is painted there. See
 *   `main/shell/toastsView.ts`.
 * - `devhub:notice-retired` — a notice left the screen, and by which rule.
 *   Main publishes every notice and sees none of them go.
 * - `devhub:retry-app` — "Try Again". What it restarts is the App Shell page's
 *   projection, which is another page, so main is what joins the two ends.
 * - `devhub:open-settings` — "Open Settings".
 *
 * That is all of it. The snapshot is not in it, the appearance is not in it,
 * the workspaces are not in it: a notice is about DevHub, and nothing about
 * DevHub's model is needed to draw one.
 */

import { useCallback, useEffect } from "react";
import { devhub } from "../client";
import { useAppNotices } from "../notices";
import { ToastStack } from "./ToastStack";
import { useStackSize } from "./stackSize";

export function ToastsApp() {
  const {
    notices,
    raiseFailure: drawFailure,
    observeCondition,
    clearFailure,
    dismiss,
    dismissNewest,
  } = useAppNotices(
    useCallback((retired) => {
      // `void` and not awaited: a retirement is a thing to write down, and a
      // page that waited on the write would make closing a toast depend on
      // main answering.
      void devhub().reportNoticeRetired(retired);
    }, []),
  );

  // Delivered for display, so it is drawn and nothing else. What arrived is
  // never raised again — see this file's header, and `publishAudience.ts` for
  // main's half of the same rule.
  useEffect(() => devhub().onNativeError(drawFailure), [drawFailure]);
  useEffect(
    () =>
      devhub().onAppCondition((condition) => {
        observeCondition(condition.source, condition.summary);
      }),
    [observeCondition],
  );

  // The person started another action. Failures are retired by it and
  // conditions are not: nobody asked for the condition, so their next click is
  // no evidence at all that it is over. See `notices.ts`.
  useEffect(() => devhub().onActionStarted(clearFailure), [clearFailure]);

  // `Cmd+Q D`. The chord layer is in main and the notice is here, so the chord
  // arrives as a message; a page with nothing on screen answers with nothing,
  // which is what makes one chord right in every window.
  useEffect(
    () =>
      devhub().onMenuCommand((command) => {
        if (command === "dismiss_alert") dismissNewest();
      }),
    [dismissNewest],
  );

  const measure = useStackSize(notices.length);

  return (
    <ToastStack
      ref={measure}
      notices={notices}
      onDismiss={dismiss}
      onRetry={() => {
        devhub().retryApp();
      }}
      onOpenSettings={() => {
        void devhub().openSettings();
      }}
    />
  );
}
