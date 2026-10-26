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
 * # Slots, and why there is more than one notice
 *
 * Failures share one slot under `useAlertLifetime`, unchanged and not copied:
 * "a newer failure replaces the one on screen" is the failure rule. Conditions
 * do not share one: each *source* holds its own (keyed by
 * `appConditionIdentity`), because two sources are two standing facts and one
 * of them ending says nothing about the other. The stack on screen is every
 * slot that has something to say: a condition where it first appeared, the
 * failure slot moved to the newest end whenever a failure is raised.
 *
 * That is why a repeat cannot pile up: a source has one slot, so its
 * condition arriving a second time replaces itself rather than stacking, and
 * a condition the person has put away stays away because which identities
 * were put away is remembered until their own source retracts them.
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
 *
 * # Hiding is not dismissing
 *
 * A toast hides itself after a while (`hide`, reason `timeout`) the way the
 * person's × would put it away — so a repeat does not bring it straight back —
 * but what it said is kept in the notice center (`model/noticeCenter.ts`),
 * unread if nobody looked at it. Every notice that reaches the screen is an
 * entry there, whichever way it leaves.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  appConditionIdentity,
  appFailureIdentity,
  type AppError,
  type AppErrorActionWire,
  type NoticeRetiredWire,
} from "../ipc/appShell";
import {
  noticeRemoved,
  noticesEnded,
  noticeShown,
  noticesRead,
  type NoticeCenter,
} from "../model/noticeCenter";
import { NoticeEpisodes } from "../model/noticeEpisodes";
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
 * The failures' one slot in the stack's order. Every other slot is a
 * condition's identity, which starts `condition\u0000` and so cannot be this.
 */
const FAILURE_SLOT = "failure";

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
  /** Its time on screen ran out: off the stack, kept in the center. */
  readonly hide: (identity: string) => void;
  /** The person looked at it (pointer or keyboard on the toast). */
  readonly seen: (identity: string) => void;
  /** Everything that reached the screen this run, newest first. */
  readonly center: NoticeCenter<Notice>;
  /** The center was opened: everything in it has been seen. */
  readonly readAll: () => void;
  /** Take one entry out of the center, and its toast off screen with it. */
  readonly remove: (key: number) => void;
  /** Empty the center, and the stack with it. */
  readonly clearAll: () => void;
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
    alert: failureAlert,
    raise: raiseFailureNotice,
    clear: clearFailureNotice,
    dismiss: dismissFailure,
  } = useAlertLifetime<Notice>(identityOf);

  // What is on screen, readable from a callback that must not depend on it:
  // a `clearFailure` that changed identity whenever a notice arrived would run
  // every effect built on it again, which is the loop `useAlertLifetime`'s own
  // comment warns about.
  const heldFailure = useRef<Notice | null>(null);
  heldFailure.current = failureAlert;
  const reportRef = useRef(report);
  reportRef.current = report;

  const [center, setCenter] = useState<NoticeCenter<Notice>>([]);
  const nextKey = useRef(0);
  // What reached the screen goes into the center. An effect on what is held,
  // rather than at each raise, because a raise the lifetime rule refused
  // never reached the screen.
  const record = useCallback((notice: Notice) => {
    const key = nextKey.current;
    nextKey.current += 1;
    setCenter((current) => {
      // A newer failure replaces the one on screen, so that one is over.
      const ended =
        notice.live === "alert"
          ? noticesEnded(
              current,
              (each) =>
                each.live === "alert" && each.identity !== notice.identity,
            )
          : current;
      return noticeShown(ended, notice, Date.now(), key);
    });
  }, []);
  useEffect(() => {
    if (failureAlert) record(failureAlert);
  }, [failureAlert, record]);

  /**
   * The seam every app-scoped notice passes through, and the one rule that
   * makes a publisher's rate stop mattering.
   *
   * Everything arrives here: main's `devhub:native-error`, the overlay handing
   * its failures over, this page's own `reportFailure` — including the ones
   * that fire from a `ResizeObserver` or an unhandled rejection, which have no
   * rate of their own and take the rate of whatever is failing. Below this
   * line there is one notice per episode, so none of them can flap.
   *
   * Failures only: a condition comes from main's set
   * (`main/shell/appConditions.ts`), which already sends only a change.
   */
  const failureEpisodes = useRef(new NoticeEpisodes());

  const clearFailure = useCallback(() => {
    const retiring = heldFailure.current;
    if (retiring) {
      reportRef.current({
        identity: retiring.identity,
        reason: "next_action",
      });
    }
    // Unconditionally, and not only for what was on screen: the person's next
    // action retires every failure, including the ones held back because one
    // of them already was. A publisher that fails again after that has news,
    // and holding *that* back would turn a failure into silence — which is
    // worse than the flicker the holding back is for.
    failureEpisodes.current.endedAll();
    clearFailureNotice();
    setCenter((center) =>
      noticesEnded(center, (notice) => notice.live === "alert"),
    );
  }, [clearFailureNotice]);

  // The conditions that hold and are on screen, one per source, and the
  // order of every slot on screen. Refs, so a callback reads what is held now
  // — several retirements in one gesture (Clear All) each see the last — and
  // a counter that re-renders when either moves.
  const conditions = useRef(new Map<string, Notice>());
  const order = useRef<readonly string[]>([]);
  const putAwayConditions = useRef(new Set<string>());
  const [standing, changed] = useReducer((n: number) => n + 1, 0);

  const notices = useMemo(() => {
    void standing;
    return order.current
      .map((slot) =>
        slot === FAILURE_SLOT ? failureAlert : conditions.current.get(slot),
      )
      .filter((notice): notice is Notice => notice != null);
  }, [standing, failureAlert]);

  /** A condition leaves the screen; `false` if it was not on it. */
  const takeCondition = useCallback((identity: string): boolean => {
    if (!conditions.current.delete(identity)) return false;
    order.current = order.current.filter((slot) => slot !== identity);
    changed();
    return true;
  }, []);

  const raiseFailure = useCallback(
    (error: AppError) => {
      const notice = failureNotice(error);
      // Not a failure dropped: what it would raise is already on screen,
      // saying the same thing about the same subject. Its own words went to
      // the main log, where a second reason is worth having.
      if (!failureEpisodes.current.begins(notice.identity)) return;
      // The newest failure is the newest slot, so `Cmd+Q D` reaches it.
      if (order.current[order.current.length - 1] !== FAILURE_SLOT) {
        order.current = [
          ...order.current.filter((slot) => slot !== FAILURE_SLOT),
          FAILURE_SLOT,
        ];
        changed();
      }
      raiseFailureNotice(notice);
    },
    [raiseFailureNotice],
  );

  const observeCondition = useCallback(
    (source: string, summary: string | undefined) => {
      // The source alone is the identity, because the source *is* the slot:
      // one source holds one condition. The words used to be part of it, and
      // a source that reworded a standing fact then read as one condition
      // ending and another beginning, i.e. a remove and an add, i.e. a blink.
      const identity = appConditionIdentity(source);
      if (summary === undefined) {
        // This source retracted its own — and only its own. `clear` and not
        // `dismiss`: it ended, so nothing about it is kept away, and its
        // coming back is news.
        putAwayConditions.current.delete(identity);
        setCenter((center) =>
          noticesEnded(center, (notice) => notice.identity === identity),
        );
        if (takeCondition(identity)) {
          reportRef.current({ identity, reason: "source" });
        }
        return;
      }
      // Put away by the person or the clock: a repeat is not news.
      if (putAwayConditions.current.has(identity)) return;
      const held = conditions.current.get(identity);
      if (held?.summary === summary) return;
      const notice: Notice = {
        identity,
        summary,
        actions: [],
        live: "status",
      };
      conditions.current.set(identity, notice);
      if (!held) order.current = [...order.current, identity];
      changed();
      record(notice);
    },
    [record, takeCondition],
  );

  // Off the stack, by the person or by the clock. Either way it is
  // remembered, so a repeat does not put it straight back.
  const putAway = useCallback(
    (identity: string, reason: "person" | "timeout") => {
      const wasCondition = takeCondition(identity);
      if (wasCondition) putAwayConditions.current.add(identity);
      const wasFailure = heldFailure.current?.identity === identity;
      if (wasFailure) {
        dismissFailure();
        failureEpisodes.current.ended(identity);
      }
      if (!wasCondition && !wasFailure) return;
      reportRef.current({ identity, reason });
    },
    [takeCondition, dismissFailure],
  );

  const seen = useCallback((identity: string) => {
    setCenter((center) => noticesRead(center, identity));
  }, []);

  const dismiss = useCallback(
    (identity: string) => {
      // Put away by hand is seen; it stays in the center, read.
      seen(identity);
      putAway(identity, "person");
    },
    [putAway, seen],
  );

  const hide = useCallback(
    (identity: string) => {
      putAway(identity, "timeout");
    },
    [putAway],
  );

  const dismissNewest = useCallback(() => {
    const newest = notices[notices.length - 1];
    if (newest) dismiss(newest.identity);
  }, [dismiss, notices]);

  const readAll = useCallback(() => {
    setCenter((center) => noticesRead(center));
  }, []);

  const remove = useCallback(
    (key: number) => {
      const entry = center.find((each) => each.key === key);
      if (entry?.current) putAway(entry.notice.identity, "person");
      setCenter((current) => noticeRemoved(current, key));
    },
    [center, putAway],
  );

  const clearAll = useCallback(() => {
    for (const notice of notices) putAway(notice.identity, "person");
    setCenter([]);
  }, [notices, putAway]);

  return useMemo(
    () => ({
      notices,
      raiseFailure,
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
    }),
    [
      notices,
      raiseFailure,
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
    ],
  );
}
