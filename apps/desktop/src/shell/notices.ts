/**
 * What the application itself has to say, and how long it says it for.
 *
 * A notice is app-scoped by construction: it is about DevHub, not about one
 * Agent and not about one workspace. Those two have surfaces of their own —
 * an Agent's refusal is drawn on that Agent's pane and a workspace's on that
 * workspace's surface, the rule `main/shell/agentFailure.ts` routes by — and
 * what is left over is what this module holds. There is one display site for
 * it (`components/shell/Toasts.tsx`) and this is the one state behind it, so a
 * new app-wide condition has one place to arrive and one place to be drawn.
 *
 * # Channels, and why there is more than one notice
 *
 * The lifetime rule is `useAlertLifetime`, unchanged and not copied: it holds
 * exactly one thing at a time, because "a newer failure replaces the one on
 * screen" is only true of failures that are about the same kind of thing. A
 * *channel* is that "kind of thing" — one source of notices, holding at most
 * one live notice, under the shared rule. The stack on screen is the channels
 * that have something to say, in the order they last said it.
 *
 * That is why a repeat cannot pile up: a channel has one slot, so the same
 * condition arriving a second time replaces itself rather than stacking, and
 * a condition the person has put away stays away because the rule remembers
 * which identity was dismissed.
 *
 * # Failures and conditions are retired differently
 *
 * A **failure** is about something the person just asked for, so all three of
 * the shared rule's exits apply to it, the person's next action included: they
 * have moved on, and a report about the last thing is in the way of the next.
 *
 * A **condition** is not about any action — `gh` is not on the PATH, the
 * network dropped — so the person's next action is no evidence at all that it
 * is over, and retiring it there would take a standing fact off screen while
 * it was still true. A condition is retired by the person dismissing it, or by
 * *its own source retracting it*: the source that says a condition holds is
 * the only thing that can say it no longer does. `RepositoryStatusWire` has
 * always documented exactly this — its diagnostic "is gone when a later round
 * succeeds, and by no other rule" — and `observeCondition` is that sentence,
 * applied to every condition rather than to the one that happened to have it
 * written down.
 *
 * A retraction also forgets that the condition was dismissed, which is the
 * right thing for the same reason: the condition genuinely ended, so its
 * coming back is news rather than the repeat the dismissal was about.
 */

import { useCallback, useMemo, useState } from "react";
import type { AppError, AppErrorActionWire } from "../ipc/appShell";
import { useAlertLifetime } from "./alertLifetime";

/**
 * One sentence the application has to say, and what can be done about it.
 *
 * `live` is which of the two announcements it is, because the two channels are
 * two different urgencies to a screen reader: a failure interrupts, since the
 * person is waiting on the action it is about, and a condition does not, since
 * nothing was asked for.
 */
export interface Notice {
  /**
   * What makes two notices the same notice.
   *
   * The shared lifetime rule reads it, so it is what decides whether a repeat
   * is suppressed and whether a dismissal still holds. Two notices with the
   * same identity are one thing being re-raised; a different identity is news.
   */
  readonly identity: string;
  readonly summary: string;
  readonly detail?: string;
  readonly actions: readonly AppErrorActionWire[];
  readonly live: "alert" | "status";
}

/**
 * The channels, in the order they are read when nothing has happened yet.
 *
 * One `useAlertLifetime` call each, named rather than built from a list,
 * because a hook cannot be called in a loop over data that changes — and
 * because a channel is a decision about what shares one slot, which is worth
 * writing down rather than deriving.
 */
const CHANNELS = ["condition", "failure"] as const;
type Channel = (typeof CHANNELS)[number];

function identityOf(notice: Notice): string {
  return notice.identity;
}

/**
 * What a failure the application published looks like as a notice.
 *
 * The code and the words are the identity, the same pair the App Shell has
 * always used: a save that keeps failing for the same reason is one failure
 * being re-raised, and one that starts failing differently is news.
 */
function failureNotice(error: AppError): Notice {
  return {
    identity: `${error.code}\u0000${error.detail ?? ""}`,
    summary: error.summary,
    ...(error.detail == null ? {} : { detail: error.detail }),
    actions: error.actions,
    live: "alert",
  };
}

export interface AppNotices {
  /** What is on screen, oldest first — so the newest is nearest the corner. */
  readonly notices: readonly Notice[];
  /** The application failed at something that was asked of it. */
  readonly raiseFailure: (error: AppError) => void;
  /**
   * What a source says about a condition it watches, every time it looks.
   *
   * `summary` absent means the condition does not hold — which is the source
   * retracting it, and the only thing besides the person that can.
   */
  readonly observeCondition: (
    source: string,
    summary: string | undefined,
  ) => void;
  /** The person started another action. Retires failures, not conditions. */
  readonly clearFailure: () => void;
  /** The person put one notice away, by its identity. */
  readonly dismiss: (identity: string) => void;
  /** The person put the newest notice away — what `dismiss_alert` reaches. */
  readonly dismissNewest: () => void;
}

export function useAppNotices(): AppNotices {
  // Destructured rather than kept whole: `useAlertLifetime` returns a fresh
  // object every render and its callbacks are the stable part, so anything
  // built on the object would change identity on every render — and an effect
  // depending on it would run on every render, which is how a condition
  // observed in an effect becomes a loop that never settles.
  const {
    alert: conditionAlert,
    raise: raiseConditionNotice,
    clear: clearCondition,
    dismiss: dismissCondition,
  } = useAlertLifetime<Notice>(identityOf);
  const {
    alert: failureAlert,
    raise: raiseFailureNotice,
    clear: clearFailure,
    dismiss: dismissFailure,
  } = useAlertLifetime<Notice>(identityOf);

  // Which channel spoke last, kept as state rather than a ref because the
  // order the stack is drawn in is something the render reads.
  const [order, setOrder] = useState<readonly Channel[]>(CHANNELS);
  const promote = useCallback((channel: Channel) => {
    setOrder((current) => [...current.filter((c) => c !== channel), channel]);
  }, []);

  const notices = useMemo(() => {
    const held: Record<Channel, Notice | null> = {
      condition: conditionAlert,
      failure: failureAlert,
    };
    return order
      .map((channel) => held[channel])
      .filter((notice): notice is Notice => notice !== null);
  }, [order, conditionAlert, failureAlert]);

  const raiseFailure = useCallback(
    (error: AppError) => {
      promote("failure");
      raiseFailureNotice(failureNotice(error));
    },
    [raiseFailureNotice, promote],
  );

  const observeCondition = useCallback(
    (source: string, summary: string | undefined) => {
      if (summary === undefined) {
        // The source retracted it. `clear` and not `dismiss`: the condition
        // ended, so nothing about it is being kept away.
        clearCondition();
        return;
      }
      promote("condition");
      raiseConditionNotice({
        // The words are part of the identity: a network that dropped and a
        // `gh` that is missing are two conditions from one source, and having
        // put one away is no reason not to be told about the other.
        identity: `${source}\u0000${summary}`,
        summary,
        actions: [],
        live: "status",
      });
    },
    [clearCondition, raiseConditionNotice, promote],
  );

  const dismiss = useCallback(
    (identity: string) => {
      if (conditionAlert?.identity === identity) dismissCondition();
      if (failureAlert?.identity === identity) dismissFailure();
    },
    [conditionAlert, failureAlert, dismissCondition, dismissFailure],
  );

  const dismissNewest = useCallback(() => {
    const newest = notices[notices.length - 1];
    if (newest) dismiss(newest.identity);
  }, [dismiss, notices]);

  return useMemo(
    () => ({
      notices,
      raiseFailure,
      observeCondition,
      clearFailure,
      dismiss,
      dismissNewest,
    }),
    [
      notices,
      raiseFailure,
      observeCondition,
      clearFailure,
      dismiss,
      dismissNewest,
    ],
  );
}
