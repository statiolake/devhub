/**
 * How long a failure stays on screen — the rule, in one place.
 *
 * A failure is retired by exactly three things: the person dismisses it, the
 * person starts another action, or a *different* failure replaces it. Nothing
 * that merely arrives can retire it — a snapshot showing up is not evidence
 * that anything was fixed, and letting one clear the alert is how a reported
 * failure reaches the screen and vanishes before it can be read. Nor can
 * anything that merely arrives bring a dismissed failure back: re-raising the
 * same failure is not news, and an alert that returns as fast as it is closed
 * is one the person cannot get out of the way of.
 *
 * It lives here rather than in the App Shell's provider because the App Shell
 * is not the only window DevHub has. The Settings window had its own rules —
 * an arriving snapshot wiped the refusal the person was reading — and the way
 * to make sure that does not happen again is for there to be one rule and no
 * second implementation of it to drift from. A page supplies only the identity
 * of a failure, because "the same failure" is the one part that depends on
 * what a failure *is* on that page.
 */

import { useCallback, useRef, useState } from "react";

export interface AlertLifetime<E> {
  /** The failure on screen, or `null`. */
  readonly alert: E | null;
  /** Something failed. */
  readonly raise: (error: E) => void;
  /**
   * The person started another action.
   *
   * The alert goes, and so does the memory of what was dismissed: a failure
   * that is still happening is worth showing again once the person has asked
   * for something new.
   */
  readonly clear: () => void;
  /**
   * The person put the alert away.
   *
   * Records *which* failure was put away, so the source that keeps raising it
   * cannot put it straight back.
   */
  readonly dismiss: () => void;
}

export function useAlertLifetime<E>(
  identity: (error: E) => string,
): AlertLifetime<E> {
  const [alert, setAlert] = useState<E | null>(null);
  const dismissed = useRef<string | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const raise = useCallback((error: E) => {
    if (dismissed.current === identityRef.current(error)) return;
    dismissed.current = null;
    setAlert(error);
  }, []);

  const clear = useCallback(() => {
    dismissed.current = null;
    setAlert(null);
  }, []);

  const dismiss = useCallback(() => {
    setAlert((current) => {
      dismissed.current =
        current === null ? null : identityRef.current(current);
      return null;
    });
  }, []);

  return { alert, raise, clear, dismiss };
}
