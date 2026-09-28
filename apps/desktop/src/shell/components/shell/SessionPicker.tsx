/**
 * Which earlier session of an Agent's CLI to go on with: what `/resume` asks
 * inside a GUI Agent.
 *
 * The Workspace's sessions lead; "All projects" lists every directory's, as the CLIs' own pickers do,
 * and a session Claude cannot resume in this Workspace (it ran elsewhere) is
 * listed with that reason rather than hidden. The row the person is on is
 * previewed beside the list — its last few messages, read on demand and kept
 * for as long as the sheet stands — so a session can be told apart from its
 * neighbours by more than a title.
 *
 * What fails says so where the question is: a listing that could not be read
 * in the note, a preview that could not be read in the preview's place.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PastSessionWire,
  SessionPreviewLineWire,
  SessionScopeWire,
} from "../../../ipc/contract";
import { Picker, type PickerItem } from "./Picker";
import {
  said,
  sessionDetail,
  SessionPreview,
  useSessionPreview,
} from "./sessionRows";

/** Where the sheet reads what it lists, bound to the Workspace or the Agent it asks for. */
export interface SessionSource {
  readonly list: (
    scope: SessionScopeWire,
  ) => Promise<readonly PastSessionWire[]>;
  readonly preview: (
    session: string,
    cwd: string,
  ) => Promise<readonly SessionPreviewLineWire[]>;
}

export interface SessionPickerProps {
  readonly title: string;
  readonly question: string;
  /** The CLI's name, for what the sheet says about its sessions ("Claude"). */
  readonly cli: string;
  readonly source: SessionSource;
  readonly onChoose: (session: string) => void;
  readonly onCancel: () => void;
}

const NO_SESSIONS: readonly PastSessionWire[] = [];

export function SessionPicker({
  title,
  question,
  cli,
  source,
  onChoose,
  onCancel,
}: SessionPickerProps) {
  const [scope, setScope] = useState<SessionScopeWire>("here");
  const [listed, setListed] = useState<{
    readonly scope: SessionScopeWire;
    readonly sessions: readonly PastSessionWire[];
    readonly refusal: string | undefined;
  }>();
  useEffect(() => {
    let live = true;
    setListed(undefined);
    source.list(scope).then(
      (sessions) => {
        if (live) setListed({ scope, sessions, refusal: undefined });
      },
      (error: unknown) => {
        if (live) setListed({ scope, sessions: [], refusal: said(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [source, scope]);

  const sessions = listed?.sessions ?? NO_SESSIONS;
  const byId = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const items: readonly PickerItem[] = useMemo(
    () =>
      sessions.map((session) => {
        const detail = sessionDetail(
          session,
          Date.now(),
          scope === "everywhere",
        );
        return {
          id: session.id,
          label: session.title,
          ...(detail === undefined ? {} : { detail }),
          searchText: `${session.title} ${session.branch ?? ""} ${session.cwd ?? ""}`,
          ...(session.resumableHere
            ? {}
            : {
                unavailable: `${cli} goes on with it only in ${session.cwd ?? "the directory it ran in"}.`,
              }),
        };
      }),
    [sessions, scope, cli],
  );

  // The preview of the row the person is on.
  const [activeId, setActiveId] = useState<string>();
  const onActiveChange = useCallback((item: PickerItem | undefined) => {
    setActiveId(item?.id);
  }, []);
  const active = activeId === undefined ? undefined : byId.get(activeId);
  const preview = useSessionPreview(
    active === undefined
      ? undefined
      : {
          key: active.id,
          cli,
          cwd: active.cwd,
          read: (cwd) => source.preview(active.id, cwd),
        },
  );

  const refusal = listed?.refusal;
  return (
    <Picker
      // A new scope is a new list: the selection starts from its top.
      key={scope}
      title={title}
      question={question}
      items={items}
      busy={listed === undefined}
      toolbar={
        <div
          className="session-picker-scope"
          role="group"
          aria-label="Sessions of"
        >
          {(
            [
              ["here", "This project"],
              ["everywhere", "All projects"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="mac-button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>
      }
      onActiveChange={onActiveChange}
      aside={<SessionPreview preview={preview} empty={items.length === 0} />}
      note={
        refusal === undefined ? undefined : (
          <span className="picker-note-failure">{refusal}</span>
        )
      }
      emptyNoItems={
        refusal !== undefined
          ? "The sessions could not be listed."
          : scope === "here"
            ? `This workspace has no earlier ${cli} sessions.`
            : `There are no earlier ${cli} sessions on this machine.`
      }
      emptyNoMatch="No earlier session matches."
      onChoose={(choice) => onChoose(choice.id)}
      onCancel={onCancel}
    />
  );
}
