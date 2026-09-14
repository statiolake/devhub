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

import { useCallback, useMemo, useRef, useState } from "react";
import {
  appConditionIdentity,
  appFailureIdentity,
  type AppError,
  type AppErrorActionWire,
  type NoticeRetiredWire,
} from "../ipc/appShell";
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
   * is suppressed and whether a dismissal still holds — and the toast stack
   * keys by it, so it also decides which DOM node draws it. Two notices with
   * the same identity are one thing being re-raised; a different identity is
   * news, *and a node removed and another added*.
   *
   * It is the code and the subject and never the sentence, and the one
   * definition of that is `ipc/appShell.ts`, which main computes from too.
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
 * The **code alone** is the identity, on this app-scoped channel where the
 * subject is always the application. The words used to be part of it, and that
 * was the flicker: a failure's detail is the failing side's own sentence, and
 * that sentence moves while the condition behind it stands still. A tmux that
 * will not answer names a different subcommand and a different budget every
 * round (`main/terminal/tmux.ts`), a workbench that keeps restarting counts
 * its attempts — so every publish was a *different* notice, the stack is keyed
 * by identity, and a different key is a node removed and another added. At the
 * rate a reconcile round publishes, that is a sentence blinking several times
 * a second.
 *
 * What it costs is that a failure the person dismissed stays dismissed even if
 * the next one of that code says something new. That is the right way round:
 * the alternative is an alert that cannot be got out of the way of, because
 * the source only has to word itself differently to put it straight back.
 */
function failureNotice(error: AppError): Notice {
  return {
    identity: appFailureIdentity(error.code),
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

export function useAppNotices(
  /**
   * Where a retirement is reported, so main can log it.
   *
   * Main publishes every notice and sees none of them go: two of the three
   * exits are gestures that only happen here. Required rather than optional,
   * because a page that quietly did not report would produce a log saying a
   * notice went up and never came down — which is a worse answer than none.
   */
  report: (retired: NoticeRetiredWire) => void,
): AppNotices {
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
    clear: clearFailureNotice,
    dismiss: dismissFailure,
  } = useAlertLifetime<Notice>(identityOf);

  // What is on screen, readable from a callback that must not depend on it:
  // a `clearFailure` that changed identity whenever a notice arrived would run
  // every effect built on it again, which is the loop `useAlertLifetime`'s own
  // comment warns about.
  const held = useRef<{ condition: Notice | null; failure: Notice | null }>({
    condition: null,
    failure: null,
  });
  held.current = { condition: conditionAlert, failure: failureAlert };
  const reportRef = useRef(report);
  reportRef.current = report;

  const clearFailure = useCallback(() => {
    const retiring = held.current.failure;
    if (retiring) {
      reportRef.current({
        identity: retiring.identity,
        reason: "next_action",
      });
    }
    clearFailureNotice();
  }, [clearFailureNotice]);

  // Which channel spoke last, kept as state rather than a ref because the
  // order the stack is drawn in is something the render reads.
  const [order, setOrder] = useState<readonly Channel[]>(CHANNELS);
  const promote = useCallback((channel: Channel) => {
    setOrder((current) => {
      // The same channel speaking again does not change the order, and saying
      // so is what stops it becoming work: a fresh array here is a fresh
      // `notices`, which is a fresh context value and a re-render of the stack
      // — at the rate a reconcile round publishes into a condition that is
      // already up, which is once a second per machine and nothing to show
      // for it.
      if (current[current.length - 1] === channel) return current;
      return [...current.filter((c) => c !== channel), channel];
    });
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
        const retiring = held.current.condition;
        if (retiring) {
          reportRef.current({ identity: retiring.identity, reason: "source" });
        }
        clearCondition();
        return;
      }
      promote("condition");
      raiseConditionNotice({
        // The source alone is the identity, because the source *is* the slot:
        // one source holds one condition. The words used to be part of it, and
        // a source that reworded a standing fact — which is what a round that
        // fails differently does — then read as one condition ending and
        // another beginning, i.e. a remove and an add, i.e. a blink.
        identity: appConditionIdentity(source),
        summary,
        actions: [],
        live: "status",
      });
    },
    [clearCondition, raiseConditionNotice, promote],
  );

  const dismiss = useCallback(
    (identity: string) => {
      const matched =
        conditionAlert?.identity === identity ||
        failureAlert?.identity === identity;
      if (conditionAlert?.identity === identity) dismissCondition();
      if (failureAlert?.identity === identity) dismissFailure();
      if (matched) reportRef.current({ identity, reason: "person" });
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
