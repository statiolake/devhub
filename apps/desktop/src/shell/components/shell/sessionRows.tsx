/**
 * An earlier session of an Agent's CLI, as a row and as a preview.
 *
 * Two sheets list sessions — the agent picker, whose past-session rows sit
 * under its "New … Session" rows, and `/resume` inside a GUI Agent — and a
 * session is the same thing in both: its title, when it last changed and on
 * which branch, and beside the list how it ended. So what a row says and how
 * its preview is read and drawn are written here, once, and a session cannot
 * read one way in one sheet and another way in the other.
 */

import { useEffect, useRef, useState } from "react";
import type {
  PastSessionWire,
  SessionPreviewLineWire,
} from "../../../ipc/contract";
import { toAppError } from "../../failure";

/** How long the pointer or the arrows rest on a row before its preview is read. */
const PREVIEW_DELAY_MS = 150;

/** A failure's words, as a sheet says them under its list or in a preview. */
export function said(error: unknown): string {
  const failure = toAppError(error);
  return failure.detail === undefined
    ? failure.summary
    : `${failure.summary} ${failure.detail}`;
}

/**
 * A session row's second line: when it last changed, relative to `now`, and
 * the branch it was on — and where it ran, for a list that spans directories.
 */
export function sessionDetail(
  session: PastSessionWire,
  now: number,
  where: boolean,
): string | undefined {
  const parts = [
    session.updatedAt === undefined
      ? undefined
      : relativeTime(session.updatedAt, now),
    session.branch,
    where ? session.cwd : undefined,
  ].filter((part): part is string => part !== undefined && part !== "");
  return parts.length === 0 ? undefined : parts.join(" · ");
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/** "3 hours ago", "yesterday", "just now": how long before `now` `at` was. */
export function relativeTime(at: number, now: number): string {
  const elapsed = now - at;
  for (const [unit, length] of UNITS) {
    if (Math.abs(elapsed) >= length) {
      return RELATIVE.format(-Math.round(elapsed / length), unit);
    }
  }
  return "just now";
}

export type Preview =
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly lines: readonly SessionPreviewLineWire[] }
  | { readonly kind: "failed"; readonly reason: string };

/** The session a sheet's selection is on, and how to read how it ended. */
export interface PreviewTarget {
  /** Which session this is, among everything the sheet lists. */
  readonly key: string;
  /** The CLI's name, for what the preview says about its sessions ("Claude"). */
  readonly cli: string;
  /** The directory the listing said it ran in. */
  readonly cwd: string | undefined;
  readonly read: (cwd: string) => Promise<readonly SessionPreviewLineWire[]>;
}

/**
 * The preview of the session the person is on: read after they rest on it,
 * once per session for as long as the sheet stands. A preview that failed is
 * not kept, so it is tried again when the row is.
 */
export function useSessionPreview(
  target: PreviewTarget | undefined,
): Preview | undefined {
  const previews = useRef(new Map<string, Preview>());
  const [shown, setShown] = useState<{
    readonly key: string;
    readonly preview: Preview;
  }>();
  const latest = useRef(target);
  latest.current = target;
  const key = target?.key;
  useEffect(() => {
    const session = latest.current;
    if (session === undefined) {
      setShown(undefined);
      return;
    }
    const known = previews.current.get(session.key);
    if (known !== undefined) {
      setShown({ key: session.key, preview: known });
      return;
    }
    setShown({ key: session.key, preview: { kind: "reading" } });
    const cwd = session.cwd;
    if (cwd === undefined) {
      const failed: Preview = {
        kind: "failed",
        reason: `${session.cli} does not say where this session ran, so it cannot be previewed.`,
      };
      previews.current.set(session.key, failed);
      setShown({ key: session.key, preview: failed });
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      session.read(cwd).then(
        (lines) => {
          const read: Preview = { kind: "read", lines };
          previews.current.set(session.key, read);
          if (live) setShown({ key: session.key, preview: read });
        },
        (error: unknown) => {
          if (live)
            setShown({
              key: session.key,
              preview: { kind: "failed", reason: said(error) },
            });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key]);
  return shown !== undefined && shown.key === key ? shown.preview : undefined;
}

/** How the session the person is on ended, beside the list. */
export function SessionPreview({
  preview,
  empty,
}: {
  readonly preview: Preview | undefined;
  /** Whether there is no session to point at, so nothing to invite. */
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
