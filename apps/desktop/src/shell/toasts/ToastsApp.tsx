/**
 * The page the application speaks from.
 *
 * Its own view, its own entry, its own root handler. Nothing else is drawn
 * here: no sidebar, no title bar, no surfaces, no model. It is the smallest
 * page DevHub has, and that is what makes it the right one to draw failures on
 * — it has nothing else that could fail while it is telling you something
 * failed.
 *
 *
 * # `window.innerWidth` is not the window
 *
 * This page is a `WebContentsView`, and what it measures is its own box — one
 * frame stale after main calls `setBounds` on it. Nothing here reads it, and
 * nothing here should: where anything is, is `main/shell/windowLayout.ts`, and
 * a page that needs a number from it is told the number.
 * # The whole contract, said once
 *
 * **Arriving from main**
 * - `devhub:native-error` — an app-scoped failure. Drawn, and *never raised
 *   again*: that is the page-side half of the one-way rule, and the half that
 *   stopped the echo. See `main/shell/publishAudience.ts`.
 * - `devhub:app-condition` — a standing condition going up, or its own source
 *   taking it down.
 * - `devhub:menu-command` — `dismiss_alert` (`Cmd+Q D`) and
 *   `show_notifications` (`Cmd+Q M`, which opens or closes the notice center;
 *   main has already put the keyboard in this view). Main sends them to the
 *   page that has notices, which is this one.
 * - `devhub:notice-settings` — how long a toast stays up
 *   (`general.notice_seconds`).
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
 * - `devhub:focus-surface` — the notice center closed from the keyboard: the
 *   keys go back to whatever is on screen.
 *
 * That is all of it. The snapshot is not in it, the appearance is not in it,
 * the workspaces are not in it: a notice is about DevHub, and nothing about
 * DevHub's model is needed to draw one.
 */

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_NOTICE_SECONDS } from "../../model/noticeCenter";
import { devhub } from "./client";
import { useAppNotices } from "../notices";
import { NoticeCenter } from "./NoticeCenter";
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
    hide,
    seen,
    center,
    readAll,
    remove,
    clearAll,
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

  const [hideAfterSeconds, setHideAfterSeconds] = useState(
    DEFAULT_NOTICE_SECONDS,
  );
  useEffect(
    () =>
      devhub().onNoticeSettings((settings) => {
        setHideAfterSeconds(settings.hideAfterSeconds);
      }),
    [],
  );

  // The notice center, and which of its entries were news when it opened:
  // opening it is seeing them, so they are read from then on, and marked New
  // for as long as it stays open.
  const [open, setOpen] = useState<ReadonlySet<number> | null>(null);
  const openCenter = useCallback(() => {
    setOpen(
      new Set(center.filter((entry) => !entry.read).map((entry) => entry.key)),
    );
  }, [center]);
  // What arrives while it is open is seen as it arrives.
  useEffect(() => {
    if (open) readAll();
  }, [open, center, readAll]);
  const closeCenter = useCallback(() => {
    setOpen(null);
    void devhub().focusSurface();
  }, []);
  // Clicking anywhere else in the window puts it away, as a popover does.
  useEffect(() => {
    if (!open) return undefined;
    const away = () => {
      setOpen(null);
    };
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("blur", away);
    };
  }, [open]);

  // `Cmd+Q D` and `Cmd+Q M`. The chord layer is in main and the notice is
  // here, so the chord arrives as a message; a page with nothing on screen
  // answers `dismiss_alert` with nothing, which is what makes one chord right
  // in every window.
  useEffect(
    () =>
      devhub().onMenuCommand((command) => {
        if (command === "dismiss_alert") dismissNewest();
        if (command === "show_notifications") {
          if (open) closeCenter();
          else openCenter();
        }
      }),
    [dismissNewest, open, openCenter, closeCenter],
  );

  // After every listener above: effects run in order, so by now whatever main
  // sends is drawn. What it held back until there was somebody to tell comes
  // in answer to this. See `reportListening` in `ipc/contract.ts`.
  useEffect(() => {
    devhub().reportListening();
  }, []);

  const measure = useStackSize(notices.length, open !== null);
  const actions = {
    onRetry: () => {
      devhub().retryApp();
    },
    onOpenSettings: () => {
      void devhub().openSettings();
    },
    onOpenMicrophoneSettings: () => {
      void devhub().openMicrophoneSettings();
    },
    onCopy: (text: string) => devhub().writeClipboard(text),
  };

  // Open, the center is drawn in place of the stack: the toasts on screen
  // are its newest entries, and their clocks start again when it closes.
  if (open) {
    return (
      <NoticeCenter
        ref={measure}
        entries={center}
        unread={open}
        onClose={closeCenter}
        onRemove={remove}
        onClearAll={clearAll}
        {...actions}
      />
    );
  }
  return (
    <ToastStack
      ref={measure}
      notices={notices}
      hideAfterSeconds={hideAfterSeconds}
      onDismiss={dismiss}
      onHide={hide}
      onSeen={seen}
      {...actions}
    />
  );
}
