/**
 * "Which agent?", wherever it is asked: a new session of one of the profiles,
 * or an earlier session that ran in the folder the Agent is for.
 *
 * Three flows ask it — the sidebar's `+`, which starts an Agent in a Workspace
 * that is already open; Assign Issue, once it has made the Issue's folder
 * (both through `FolderAgentPicker`, in the same words); and the
 * workspace picker's Command gesture, which starts one in the Workspace it is
 * about to open — and they are the same question about the same list. A second
 * copy of it would be a list that could drift, and a person cannot know which
 * of two they are looking at.
 *
 * # The rows
 *
 * "New Claude Session", "New Codex Session", … — one per profile, first, drawn
 * the moment the sheet opens. Under them the earlier sessions of each profile
 * whose CLI keeps sessions DevHub can list (Claude and Codex), newest first
 * across profiles: those that ran in `sessionsIn` itself, not in another
 * worktree of the same repository — a session is its checkout's work, on its
 * branch, and Claude goes on with one only in the directory it ran in. They
 * are read on that folder's machine after the sheet is up, so a slow listing
 * never holds the New rows back: while one is still being read the list ends
 * in a quiet row that says so, and a listing that failed says why in the note,
 * with the New rows still there to take. A session two profiles of one kind
 * both list is offered once, under the first of them.
 *
 * The row the person is on, when it is a session, is previewed beside the list
 * (`sessionRows`), as `/resume` previews it.
 *
 * # Command
 *
 * The Command modifier means the same thing to every row, so it is answered
 * here: the profile's presentation turned the other way for this one launch.
 * Each row says at its right end which one Return will launch — `TUI` or
 * `GUI` — and says the other while Command is held. A profile with only one
 * presentation says the same thing either way. What reaches the caller is the
 * presentation the row was showing, not the gesture.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  AgentPresentationWire,
  AgentProfileKindWire,
  AgentProfileWire,
} from "../../../ipc/appShell";
import type {
  PastSessionWire,
  WorkspacePlaceWire,
} from "../../../ipc/contract";
import { usePicker } from "../../picker/PickerContext";
import { Picker, type PickerItem } from "./Picker";
import {
  said,
  sessionDetail,
  SessionPreview,
  useSessionPreview,
} from "./sessionRows";

/** What was chosen: the profile, how it is shown, and the session it goes on with. */
export interface AgentChoice {
  readonly profileId: string;
  /** Beside the editor — Command. */
  readonly split: boolean;
  readonly presentation: AgentPresentationWire;
  /** The earlier session the Agent resumes; absent starts afresh. */
  readonly resume?: string;
}

export interface AgentProfilePickerProps {
  /** What is being chosen: "New Agent", or the Agent for an Issue. */
  readonly title: string;
  /** What this list is for, and why it is being asked now. */
  readonly question: string;
  /** Which question this is, for a flow that asks more than one. */
  readonly step?: number;
  /**
   * What the footer says while nothing needs saying instead — which is where a
   * caller says what its Command gesture does, because only the caller knows.
   */
  readonly hint: ReactNode;
  /**
   * The folder the Agent will run in, whose earlier sessions are offered.
   * Undefined where there is no folder yet — a Workspace that opening will
   * start the Agent in — and then there are only the New rows.
   */
  readonly sessionsIn: WorkspacePlaceWire | undefined;
  readonly onChoose: (choice: AgentChoice) => void;
  readonly onCancel: () => void;
}

/** The kinds whose CLI keeps sessions DevHub can list and resume. */
const RESUMABLE: readonly AgentProfileKindWire[] = ["claude", "codex"];

/** The quiet last row while a listing is still being read. */
const READING_ROW = "devhub:sessions-reading";

type Listing =
  | { readonly kind: "reading" }
  | { readonly kind: "listed"; readonly sessions: readonly PastSessionWire[] }
  | { readonly kind: "failed"; readonly reason: string };

/** What a row stands for. */
interface RowTarget {
  readonly profile: AgentProfileWire;
  readonly session?: PastSessionWire;
}

export function AgentProfilePicker({
  title,
  question,
  step,
  hint,
  sessionsIn,
  onChoose,
  onCancel,
}: AgentProfilePickerProps) {
  const { agentProfiles, listAgentSessions, previewAgentSession } = usePicker();
  const profiles = agentProfiles.profiles;
  const listings = useListings(sessionsIn, profiles, listAgentSessions);

  const { items, targets, sessionCount } = useMemo(() => {
    const targets = new Map<string, RowTarget>();
    const items: PickerItem[] = profiles.map((profile) => {
      const id = `new:${profile.id}`;
      targets.set(id, { profile });
      const kind = kindLabel(profile.kind);
      return {
        id,
        label: `New ${profile.displayName} Session`,
        // A profile usually *is* its kind, and "Codex" under "New Codex
        // Session" says nothing twice. The line is for the profiles that
        // differ — a second Claude with its own arguments, or a custom one
        // whose status will never be known.
        detail: kind === profile.displayName ? undefined : kind,
        searchText: `new ${profile.displayName} ${profile.kind}`,
        accessory: presentationAccessory(profile),
      };
    });
    const now = Date.now();
    const offered = new Set<string>();
    const past: { readonly item: PickerItem; readonly at: number }[] = [];
    let reading = false;
    for (const profile of profiles) {
      const listing = listings.get(profile.id);
      if (listing?.kind === "reading") reading = true;
      if (listing?.kind !== "listed") continue;
      for (const session of listing.sessions) {
        const same = `${profile.kind}\u0000${session.id}`;
        if (offered.has(same)) continue;
        offered.add(same);
        const id = `session:${profile.id}:${session.id}`;
        targets.set(id, { profile, session });
        const detail = sessionDetail(session, now, false);
        past.push({
          at: session.updatedAt ?? Number.NEGATIVE_INFINITY,
          item: {
            id,
            label: `${profile.displayName} Session: ${session.title}`,
            ...(detail === undefined ? {} : { detail }),
            searchText: `${profile.displayName} ${session.branch ?? ""} ${session.title}`,
            accessory: presentationAccessory(profile),
          },
        });
      }
    }
    // Newest first across profiles; a sort that is stable keeps one CLI's
    // own order among sessions that say no time.
    past.sort((a, b) => (a.at === b.at ? 0 : b.at - a.at));
    items.push(...past.map((entry) => entry.item));
    if (reading) {
      items.push({
        id: READING_ROW,
        label: "Earlier sessions",
        // Matched by nothing typed: it is not an answer to any search.
        searchText: "",
        unavailable: "Reading…",
      });
    }
    return { items, targets, sessionCount: past.length };
  }, [profiles, listings]);

  const [activeId, setActiveId] = useState<string>();
  const onActiveChange = useCallback((item: PickerItem | undefined) => {
    setActiveId(item?.id);
  }, []);
  const active = activeId === undefined ? undefined : targets.get(activeId);
  const activeSession = active?.session;
  const preview = useSessionPreview(
    active === undefined ||
      activeSession === undefined ||
      sessionsIn === undefined
      ? undefined
      : {
          key: activeId!,
          cli: active.profile.displayName,
          cwd: activeSession.cwd,
          read: (cwd) =>
            previewAgentSession(
              sessionsIn,
              active.profile.id,
              activeSession.id,
              cwd,
            ),
        },
  );

  const refusals = profiles.flatMap((profile) => {
    const listing = listings.get(profile.id);
    return listing?.kind === "failed"
      ? [
          <div key={profile.id} className="picker-note-failure">
            {listing.reason}
          </div>,
        ]
      : [];
  });

  return (
    <Picker
      title={title}
      question={question}
      step={step}
      items={items}
      emptyNoMatch="No agent profile or earlier session matches."
      emptyNoItems={
        agentProfiles.availability === "unavailable"
          ? "Agent profiles are unavailable until the configuration is readable again."
          : "No agent profiles are enabled."
      }
      note={
        <>
          {refusals}
          {agentProfiles.availability === "degraded"
            ? "The configuration needs attention; these are the last profiles DevHub could confirm."
            : hint}
        </>
      }
      onActiveChange={onActiveChange}
      // Beside the list only when there is a session to point at.
      {...(sessionCount === 0
        ? {}
        : { aside: <SessionPreview preview={preview} empty={false} /> })}
      onChoose={(choice) => {
        const target = targets.get(choice.id);
        if (target === undefined) {
          // The row taken is one this list drew, from these profiles and
          // sessions. Not finding it means the two disagree, and launching
          // anything would launch something nobody picked.
          throw new Error(
            `the picker offered a row it does not have: ${choice.id}`,
          );
        }
        onChoose({
          profileId: target.profile.id,
          split: choice.split,
          presentation: launchPresentation(target.profile, choice.alternate),
          ...(target.session === undefined
            ? {}
            : { resume: target.session.id }),
        });
      }}
      onCancel={onCancel}
    />
  );
}

/**
 * Each resumable profile's sessions in `place`, read once the sheet is up:
 * reading until its listing answers, then what it listed or why it could not.
 */
function useListings(
  place: WorkspacePlaceWire | undefined,
  profiles: readonly AgentProfileWire[],
  list: (
    place: WorkspacePlaceWire,
    profileId: string,
  ) => Promise<readonly PastSessionWire[]>,
): ReadonlyMap<string, Listing> {
  // What is being listed, as a value: a new place or a new set of profiles is
  // a new listing, and one answered for the last is not this one's.
  const asked =
    place === undefined
      ? undefined
      : JSON.stringify({
          place,
          ids: profiles
            .filter((profile) => RESUMABLE.includes(profile.kind))
            .map((profile) => profile.id),
        });
  const request = useMemo(
    () =>
      asked === undefined
        ? undefined
        : (JSON.parse(asked) as {
            readonly place: WorkspacePlaceWire;
            readonly ids: readonly string[];
          }),
    [asked],
  );
  const [answered, setAnswered] = useState<{
    readonly request: object;
    readonly listings: ReadonlyMap<string, Listing>;
  }>();
  useEffect(() => {
    if (request === undefined) return;
    let live = true;
    const settle = (id: string, listing: Listing) => {
      if (!live) return;
      setAnswered((current) => {
        const listings = new Map(
          current?.request === request ? current.listings : [],
        );
        listings.set(id, listing);
        return { request, listings };
      });
    };
    for (const id of request.ids) {
      list(request.place, id).then(
        (sessions) => settle(id, { kind: "listed", sessions }),
        (error: unknown) => settle(id, { kind: "failed", reason: said(error) }),
      );
    }
    return () => {
      live = false;
    };
  }, [request, list]);
  return useMemo(() => {
    if (request === undefined) return new Map<string, Listing>();
    const settled =
      answered?.request === request ? answered.listings : undefined;
    return new Map<string, Listing>(
      request.ids.map((id) => [id, settled?.get(id) ?? { kind: "reading" }]),
    );
  }, [request, answered]);
}

const PRESENTATION_LABEL: Record<AgentPresentationWire, string> = {
  tui: "TUI",
  gui: "GUI",
};

/**
 * A profile row's right end: `TUI` or `GUI`, whichever Return launches — the
 * other while Command is held. Every row that starts an Agent draws it, so a
 * row means the same thing wherever it is.
 */
function presentationAccessory(
  profile: AgentProfileWire,
): (alternate: boolean) => string {
  return (alternate) =>
    PRESENTATION_LABEL[launchPresentation(profile, alternate)];
}

/**
 * What a launch of this profile is: its default, or with Command held, the
 * other presentation it has — and still its default when it has no other.
 */
function launchPresentation(
  profile: AgentProfileWire,
  alternate: boolean,
): AgentPresentationWire {
  if (!alternate) return profile.presentation;
  return (
    profile.presentations.find(
      (presentation) => presentation !== profile.presentation,
    ) ?? profile.presentation
  );
}

/**
 * The one line under a profile's row: whose screen it draws.
 *
 * A `custom` profile has no manifest, so its status will stay `?` for the life
 * of the Agent. Saying so here is where a person can still change their mind
 * about which profile to start.
 */
function kindLabel(kind: AgentProfileKindWire): string {
  switch (kind) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    // Deliberately narrower than "Cursor". DevHub reads Cursor's busy and
    // waiting screens but never claims its prompt is free, so a person picking
    // this profile should know the row will not go quiet-and-ready the way the
    // other two do — it goes to `?` instead.
    case "cursor":
      return "Cursor — busy and waiting only";
    case "custom":
      return "Other — no status detection";
  }
}
