/**
 * Which earlier session of an Agent's CLI to go on with: what New Agent's
 * "Resume a session…" asks, and what `/resume` asks inside a GUI Agent.
 *
 * One sheet for both, because it is one question. The Workspace's sessions
 * lead; "All projects" lists every directory's, as the CLIs' own pickers do,
 * and a session Claude cannot resume in this Workspace (it ran elsewhere) is
 * listed with that reason rather than hidden. The row the person is on is
 * previewed beside the list — its last few messages, read on demand and kept
 * for as long as the sheet stands — so a session can be told apart from its
 * neighbours by more than a title.
 *
 * What fails says so where the question is: a listing that could not be read
 * in the note, a preview that could not be read in the preview's place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PastSessionWire,
  SessionPreviewLineWire,
  SessionScopeWire,
} from "../../../ipc/contract";
import { toAppError } from "../../failure";
import { Picker, type PickerItem } from "./Picker";

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
  readonly step?: number;
  /** The CLI's name, for what the sheet says about its sessions ("Claude"). */
  readonly cli: string;
  readonly source: SessionSource;
  /** A line of guidance under the list, while nothing has failed. */
  readonly hint?: string;
  readonly onChoose: (session: string, split: boolean) => void;
  readonly onCancel: () => void;
}

const NO_SESSIONS: readonly PastSessionWire[] = [];

/** How long the pointer or the arrows rest on a row before its preview is read. */
const PREVIEW_DELAY_MS = 150;

function said(error: unknown): string {
  const failure = toAppError(error);
  return failure.detail === undefined
    ? failure.summary
    : `${failure.summary} ${failure.detail}`;
}

type Preview =
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly lines: readonly SessionPreviewLineWire[] }
  | { readonly kind: "failed"; readonly reason: string };

export function SessionPicker({
  title,
  question,
  step,
  cli,
  source,
  hint,
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
        const when =
          session.updatedAt === undefined
            ? undefined
            : new Date(session.updatedAt).toLocaleString();
        const where = scope === "everywhere" ? session.cwd : undefined;
        const detail = [when, where].filter(Boolean).join(" · ");
        return {
          id: session.id,
          label: session.title,
          ...(detail === "" ? {} : { detail }),
          searchText: `${session.title} ${session.cwd ?? ""}`,
          ...(session.resumableHere
            ? {}
            : {
                unavailable: `${cli} goes on with it only in ${session.cwd ?? "the directory it ran in"}.`,
              }),
        };
      }),
    [sessions, scope, cli],
  );

  // The preview of the row the person is on: read after they rest on it,
  // once per session for as long as the sheet stands.
  const previews = useRef(new Map<string, Preview>());
  const [shown, setShown] = useState<{
    readonly id: string;
    readonly preview: Preview;
  }>();
  const [activeId, setActiveId] = useState<string>();
  const onActiveChange = useCallback((item: PickerItem | undefined) => {
    setActiveId(item?.id);
  }, []);
  useEffect(() => {
    const session = activeId === undefined ? undefined : byId.get(activeId);
    if (session === undefined) {
      setShown(undefined);
      return;
    }
    const known = previews.current.get(session.id);
    if (known !== undefined) {
      setShown({ id: session.id, preview: known });
      return;
    }
    setShown({ id: session.id, preview: { kind: "reading" } });
    const cwd = session.cwd;
    if (cwd === undefined) {
      const failed: Preview = {
        kind: "failed",
        reason: `${cli} does not say where this session ran, so it cannot be previewed.`,
      };
      previews.current.set(session.id, failed);
      setShown({ id: session.id, preview: failed });
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      source.preview(session.id, cwd).then(
        (lines) => {
          const read: Preview = { kind: "read", lines };
          previews.current.set(session.id, read);
          if (live) setShown({ id: session.id, preview: read });
        },
        (error: unknown) => {
          // Not kept: a preview that failed is tried again when the row is.
          if (live)
            setShown({
              id: session.id,
              preview: { kind: "failed", reason: said(error) },
            });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [activeId, byId, source, cli]);

  const refusal = listed?.refusal;
  return (
    <Picker
      // A new scope is a new list: the selection starts from its top.
      key={scope}
      title={title}
      question={question}
      {...(step === undefined ? {} : { step })}
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
      aside={
        <SessionPreview preview={shown?.preview} empty={items.length === 0} />
      }
      note={
        refusal === undefined ? (
          hint
        ) : (
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
      onChoose={(choice) => onChoose(choice.id, choice.split)}
      onCancel={onCancel}
    />
  );
}

function SessionPreview({
  preview,
  empty,
}: {
  readonly preview: Preview | undefined;
  readonly empty: boolean;
}) {
  if (preview === undefined) {
    return empty ? null : (
      <p className="session-preview-empty mac-caption">
        Point at a session to see how it ended.
      </p>
    );
  }
  switch (preview.kind) {
    case "reading":
      return (
        <span className="mac-spinner" role="status" aria-label="Reading" />
      );
    case "failed":
      return (
        <p className="picker-note-failure" role="alert">
          {preview.reason}
        </p>
      );
    case "read":
      return preview.lines.length === 0 ? (
        <p className="session-preview-empty mac-caption">
          Nothing was said in this session&apos;s last part.
        </p>
      ) : (
        <ol className="session-preview" aria-label="How the session ended">
          {preview.lines.map((line, index) => (
            <li key={index} className={`session-preview-${line.role}`}>
              <span className="session-preview-who mac-caption">
                {line.role === "person" ? "You" : "Agent"}
              </span>
              <span className="session-preview-text">{line.text}</span>
            </li>
          ))}
        </ol>
      );
  }
}
