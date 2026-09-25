/**
 * The parts a page's model is assembled from.
 *
 * There used to be one provider for every page — `AppShellProvider`, fifty
 * members on one context — and it took every subscription DevHub has whether
 * or not the page drawing it had anything to do with them. The notices page
 * was told about workspaces; the sidebar was told about the workspace picker's
 * candidates; every page took `nativeError`, which is what made the failure
 * echo possible at all.
 *
 * Each page has a provider of its own now, holding exactly the contract its
 * header declares. What they share is here: one hook per projection, so that
 * "the snapshot" means the same subscription, the same revision ordering and
 * the same replay on every page that has it, rather than four near-copies that
 * can drift. A page composes the ones it needs and exposes nothing else.
 *
 * Every hook takes the bridge as an argument rather than reaching for it. The
 * bridge differs per page — that is the whole point — and a hook that reached
 * for `window.devhub` would have to be typed as the union of every page's,
 * which is the god-interface coming back by another door.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentProfiles,
  AppAppearance,
  AppError,
  AppIntent,
  AppLoadState,
  AppOutcome,
  AppSnapshot,
  ConfirmationPurposeWire,
} from "../../ipc/appShell";
import type {
  AgentProfilesBridge,
  AppearanceBridge,
  PageBridge,
  ProjectionBridge,
  RepositoryStatusBridge,
  RepositoryStatusWire,
} from "../../ipc/contract";
import { subscribeToUnhandled, toAppError } from "../failure";

/**
 * What a dispatch came back asking to have confirmed.
 *
 * The token, and what the question is about. There used to be an `agentId`
 * beside the purpose, filled in by sniffing the request that had been sent —
 * which said nothing for a confirmation main raised on its own, and left the
 * answering path guarding against a state it could not do anything about. The
 * purpose carries its own subject now (`ConfirmationPurposeWire`), so there is
 * nothing here to disagree with it.
 */
export interface PendingConfirmation {
  readonly confirmationId: string;
  readonly purpose: ConfirmationPurposeWire;
}

/**
 * Hand a failure to main rather than explaining it locally.
 *
 * Every page raises the same way and none of them decides where the failure is
 * drawn: main journals it and publishes it to the page that draws failures,
 * which is almost never this one. The other half of the rule is that what
 * arrived is never raised again — see `main/shell/publishAudience.ts`.
 *
 * The root handler is wired here too, because "a failure began on this page"
 * and "this page has a root handler" are the same statement: there is one
 * place a page says it, and this is it.
 */
export function useRaiseFailure(bridge: PageBridge): (error: unknown) => void {
  const raise = useCallback(
    (error: AppError) => {
      // A failure main already drew — a refused request, handed back marked
      // `reported` so that it is answered in the same words — did not begin
      // on this page, and raising it would draw it a second time.
      if (error.reported === true) return;
      bridge.raiseFailure(error);
    },
    [bridge],
  );
  useEffect(() => subscribeToUnhandled(raise), [raise]);
  return useCallback(
    (error: unknown) => {
      raise(toAppError(error));
    },
    [raise],
  );
}

export interface Projection {
  /** Loading, ready with a snapshot, or stopped before there was one. */
  readonly state: AppLoadState;
  readonly dispatch: (intent: AppIntent) => Promise<AppOutcome | undefined>;
  /** Start this page's projection over — "Try Again" on a start failure. */
  readonly retry: () => void;
  /**
   * Take a snapshot a call answered with, under the same ordering rule the
   * subscription follows. Every call that changes the model answers with one,
   * and applying it is how the page that asked sees the result now rather than
   * on the next push.
   */
  readonly applySnapshot: (snapshot: AppSnapshot) => void;
  /** Which attempt this is; other projections restart with it. */
  readonly attempt: number;
}

/**
 * The model, and the one way to ask for a change to it.
 *
 * Nothing derived is kept: no workspace list, no selection, no disclosure
 * state. The snapshot is main's projection, and a second copy of any part of
 * it is a second thing that can be wrong.
 */
export function useProjection(
  bridge: ProjectionBridge,
  raiseFailure: (error: unknown) => void,
  /**
   * Where a confirmation goes when main asks for one.
   *
   * It is not the same answer on every page, which is why it is asked for
   * rather than decided here: the `picker` view draws the sheet, so there the
   * confirmation is held in place; every other page has nowhere to draw one
   * and hands it to main, which puts it on the picker.
   */
  onConfirmationRequired: (confirmation: PendingConfirmation) => void,
): Projection {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AppLoadState>({ status: "loading" });
  const lastRevision = useRef(-1);
  const lastEventCursor = useRef(0);
  const generation = useRef(0);

  const applySnapshot = useCallback((snapshot: AppSnapshot) => {
    if (snapshot.revision < lastRevision.current) return;
    lastRevision.current = snapshot.revision;
    setState({ status: "ready", snapshot });
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    let active = true;
    const disposers: (() => void)[] = [];
    lastRevision.current = -1;

    const live = () => active && generation.current === currentGeneration;
    const applyIfActive = (snapshot: AppSnapshot) => {
      if (live()) applySnapshot(snapshot);
    };

    const initialize = async () => {
      try {
        // Subscribe before the first query, so an update cannot be missed in
        // the gap between reconstruction and the initial projection.
        disposers.push(bridge.onSnapshot(applyIfActive));
        const replay = await bridge.replay(lastEventCursor.current);
        if (!live()) return;
        // The replay cursor is independent of the snapshot revision. On a gap,
        // replace the projection with the supplied snapshot before applying
        // any later live notification.
        lastEventCursor.current = replay.cursor;
        applyIfActive(replay.snapshot);
        applyIfActive(await bridge.getSnapshot());
      } catch (error) {
        if (live()) setState({ status: "error", error: toAppError(error) });
      }
    };

    void initialize();
    return () => {
      active = false;
      generation.current += 1;
      for (const dispose of disposers) dispose();
    };
  }, [applySnapshot, attempt, bridge]);

  const dispatch = useCallback(
    async (intent: AppIntent): Promise<AppOutcome | undefined> => {
      const dispatchGeneration = generation.current;
      try {
        const outcome = await bridge.dispatch(intent);
        if (generation.current !== dispatchGeneration) return undefined;
        applySnapshot(outcome.snapshot);
        // A degraded save is *not* turned into a second alert here. Main
        // already emitted one, with the file and the reason on it; raising a
        // detail-free copy beside it left two sentences for one failure and
        // put the useless one on screen.
        if (outcome.kind === "confirmation_required") {
          onConfirmationRequired({
            confirmationId: outcome.confirmationId,
            purpose: outcome.purpose,
          });
        }
        return outcome;
      } catch (error) {
        if (generation.current !== dispatchGeneration) return undefined;
        raiseFailure(error);
        return undefined;
      }
    },
    [applySnapshot, bridge, onConfirmationRequired, raiseFailure],
  );

  const retry = useCallback(() => {
    generation.current += 1;
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  return { state, dispatch, retry, applySnapshot, attempt };
}

/**
 * What the person wrote about how DevHub should look.
 *
 * A non-blocking projection — every page is usable with its defaults — but
 * "usable with defaults" is a different thing from "the settings you chose are
 * being ignored", and only one of those is worth not saying. So a failed read
 * is reported and boot continues.
 */
export function useAppearance(
  bridge: AppearanceBridge,
  raiseFailure: (error: unknown) => void,
  attempt: number,
): AppAppearance | undefined {
  const [appearance, setAppearance] = useState<AppAppearance>();
  const lastSequence = useRef(-1);

  useEffect(() => {
    let active = true;
    lastSequence.current = -1;
    const apply = (next: AppAppearance) => {
      if (!active || next.sequence < lastSequence.current) return;
      lastSequence.current = next.sequence;
      setAppearance(next);
    };
    const dispose = bridge.onAppearance(apply);
    void bridge.getAppearance().then(apply, raiseFailure);
    return () => {
      active = false;
      dispose();
    };
  }, [attempt, bridge, raiseFailure]);

  return appearance;
}

/**
 * What each workspace is working on, as of the last look.
 *
 * A projection of its own, on its own clock: it is observed rather than
 * decided, so it does not move with the snapshot's revision — and a round that
 * answered late must not replace a newer one, which is what the sequence is
 * compared for.
 */
export function useRepositoryStatus(
  bridge: RepositoryStatusBridge,
  raiseFailure: (error: unknown) => void,
  attempt: number,
): RepositoryStatusWire {
  const [status, setStatus] = useState<RepositoryStatusWire>({
    sequence: 0,
    workspaces: [],
  });

  useEffect(() => {
    let active = true;
    const apply = (next: RepositoryStatusWire) => {
      if (!active) return;
      setStatus((current) =>
        next.sequence < current.sequence ? current : next,
      );
    };
    const dispose = bridge.onRepositoryStatus(apply);
    // What the last round found, so a page that opened between two of them
    // draws a branch name now rather than in a minute. A failed read recovers
    // in place: the rows draw what the live subscription brings them, one
    // round later than they would have.
    void bridge.getRepositoryStatus().then(apply, raiseFailure);
    return () => {
      active = false;
      dispose();
    };
  }, [attempt, bridge, raiseFailure]);

  return status;
}

const PROFILES_UNAVAILABLE: AgentProfiles = {
  sequence: 1,
  availability: "unavailable",
  diagnostic: "projection_unavailable",
  profiles: [],
};

/**
 * The agents DevHub knows how to start.
 *
 * A failed read is *not* reported as an app-scoped failure: profile discovery
 * failing and a config with no profiles in it are different things, and the
 * page has to be able to tell them apart — so it is answered with the
 * unavailable projection, which says which of the two this is.
 */
export function useAgentProfiles(
  bridge: AgentProfilesBridge,
  attempt: number,
): AgentProfiles {
  const [profiles, setProfiles] = useState<AgentProfiles>(PROFILES_UNAVAILABLE);
  const lastSequence = useRef(0);

  useEffect(() => {
    let active = true;
    lastSequence.current = 0;
    const apply = (next: AgentProfiles) => {
      if (!active || next.sequence <= lastSequence.current) return;
      lastSequence.current = next.sequence;
      setProfiles(next);
    };
    const dispose = bridge.onAgentProfiles(apply);
    void bridge.getAgentProfiles().then(apply, () => {
      if (!active) return;
      // A local fallback, not main's own sequence: do not advance the cursor,
      // or a later same-sequence projection would be discarded.
      setProfiles({
        ...PROFILES_UNAVAILABLE,
        sequence: Math.max(1, lastSequence.current + 1),
      });
    });
    return () => {
      active = false;
      dispose();
    };
  }, [attempt, bridge]);

  return profiles;
}
