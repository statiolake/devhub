/**
 * The conversation's Markdown renderer, set up for the Orchestrator screen's
 * left pane — a task's memo, its request, an escalation's thread — where
 * nothing is a conversation: links, copies and diagrams go through the
 * bridge; a file it draws (`![…](path)`) is read on this Mac, relative to
 * `cwd`. A file path in it is a link when it names a file under any of the
 * task's folders (`bases`, first match wins), and opens in the editor of the
 * open Workspace that holds it — else in the Orchestrator's own Neovim, in
 * the board's Terminal tab.
 */

import { useEffect, useMemo, useState } from "react";
import type { ImageRef } from "../../model/conversation";
import type { EscalationAttachment } from "../../model/escalationAttachments";
import { ImageView } from "../conversation/EntryParts";
import { base64Of } from "../conversation/FileEmbed";
import { Markdown } from "../conversation/Markdown";
import {
  AgentCwdProvider,
  ConversationActionsProvider,
  type ConversationActions,
} from "../conversation/ConversationContext";
import { PathLinks, PathLinksProvider } from "../conversation/pathLinks";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";
import "../conversation/conversation.css";

/**
 * Where a thread's file paths are looked for and opened, beyond its `cwd`:
 * the task's other folders, and the open Workspaces on this Mac.
 */
export interface ThreadPlaces {
  /** Folders on this Mac a relative path may be relative to, in order. */
  readonly bases: readonly string[];
  /** The open Workspaces on this Mac: a file under one opens in its editor. */
  readonly workspaces: readonly {
    readonly id: string;
    readonly root: string;
  }[];
}

const NO_PLACES: ThreadPlaces = { bases: [], workspaces: [] };

/**
 * Which of `paths` name a file on this Mac: relative to `cwd`, and then —
 * for the ones that did not — to each of `bases` in turn. An absolute path
 * is asked about once.
 */
export async function resolveInBases(
  resolve: (
    cwd: string | undefined,
    paths: readonly string[],
  ) => Promise<readonly (string | null)[]>,
  cwd: string | undefined,
  bases: readonly string[],
  paths: readonly string[],
): Promise<readonly (string | null)[]> {
  const found = [...(await resolve(cwd, paths))];
  for (const base of bases) {
    if (base === cwd) continue;
    const missing = paths.flatMap((path, index) =>
      found[index] === null && !path.startsWith("/") && !path.startsWith("~/")
        ? [index]
        : [],
    );
    if (missing.length === 0) break;
    const more = await resolve(
      base,
      missing.map((index) => paths[index]!),
    );
    missing.forEach((index, at) => {
      found[index] = more[at] ?? null;
    });
  }
  return found;
}

/** The open Workspace whose folder is the nearest one holding `path`. */
export function workspaceHolding(
  workspaces: ThreadPlaces["workspaces"],
  path: string,
): string | undefined {
  let best: { id: string; length: number } | undefined;
  for (const one of workspaces) {
    const root = one.root.replace(/\/+$/u, "");
    if (!path.startsWith(`${root}/`)) continue;
    if (best === undefined || root.length > best.length)
      best = { id: one.id, length: root.length };
  }
  return best?.id;
}

/**
 * What the conversation's renderer asks of the page, for an escalation's
 * thread: links, copies and diagrams through the bridge; a file path is
 * looked up in the task's folders (`places`).
 * Nothing here sends anything to an agent — the composer below is the
 * board's own.
 */
function useThreadActions(
  places: ThreadPlaces,
  reportFailure: (error: unknown) => void,
): ConversationActions {
  return useMemo(() => {
    const bridge = devhub();
    const none = () =>
      Promise.reject(new Error("an escalation's thread sends nothing"));
    return {
      writeClipboard: (text) => bridge.writeClipboard(text),
      writeClipboardImage: (png) => bridge.writeClipboardImage(png),
      writeClipboardRich: (content) => bridge.writeClipboardRich(content),
      saveSlidesPdf: (request) => bridge.saveSlidesPdf(request),
      saveSlideImages: (request) => bridge.saveSlideImages(request),
      showContextMenu: (request) => bridge.showContextMenu(request),
      openExternalUrl: (url) => bridge.openExternalUrl(url),
      send: none,
      startEditingPending: none,
      editPending: none,
      stopEditingPending: none,
      removePending: none,
      sendPendingNow: none,
      instruct: none,
      rewind: none,
      cancelLimitResume: none,
      interrupt: none,
      stopTask: none,
      runInBackground: none,
      answer: none,
      setSetting: none,
      cliDefaults: () => Promise.resolve(undefined),
      setCliDefault: none,
      openResume: () => undefined,
      openMcp: () => undefined,
      restart: none,
      saveDraft: () => Promise.resolve(),
      // On this Mac, through the conversation's own readers, whether or not
      // the agent is still there: an escalation's pictures are copied into
      // its own folder when it is raised.
      resolvePaths: (cwd, paths) =>
        resolveInBases(
          (base, some) => bridge.resolveEscalationPaths(base, some),
          cwd,
          places.bases,
          paths,
        ),
      readEmbedFile: (path) => bridge.readEscalationEmbed(path),
      embedSignature: (path) => bridge.escalationEmbedSignature(path),
      // In the editor of the open Workspace that holds it, as a `devhub:file`
      // link goes (the Orchestrator's own folder: its Terminal tab); a file
      // in none of them, in the Orchestrator's own Neovim, in that tab.
      openFile: (path, range) => {
        const workspace = workspaceHolding(places.workspaces, path);
        if (workspace !== undefined)
          return bridge.openLinkedFile(workspace, path, range);
        return bridge.openOrchestratorFile(path, range);
      },
      copyText: (text) => bridge.copyText(text),
      reportFailure,
    } satisfies ConversationActions;
  }, [places, reportFailure]);
}

/**
 * The conversation's renderer, set up for a thread outside a conversation;
 * an escalation's `--attach` pictures under it as the conversation draws a
 * message's (`ImageStrip`).
 */
export function RichText({
  source,
  cwd,
  places = NO_PLACES,
  attachments = NO_ATTACHMENTS,
}: {
  readonly source: string;
  /** What a relative path in it is relative to first. */
  readonly cwd?: string;
  /** Where else a path is looked for, and where a file opens. */
  readonly places?: ThreadPlaces;
  /** Pictures attached to it (`model/escalationAttachments.ts`). */
  readonly attachments?: readonly EscalationAttachment[];
}) {
  const { reportFailure } = useAgents();
  const actions = useThreadActions(places, reportFailure);
  const links = useMemo(
    () => new PathLinks(actions.resolvePaths, actions.reportFailure),
    [actions],
  );
  return (
    <ConversationActionsProvider value={actions}>
      <PathLinksProvider value={links}>
        <AgentCwdProvider value={cwd}>
          <Markdown source={source} streaming={false} />
          <Attachments attachments={attachments} />
        </AgentCwdProvider>
      </PathLinksProvider>
    </ConversationActionsProvider>
  );
}

const NO_ATTACHMENTS: readonly EscalationAttachment[] = [];

/**
 * The pictures, read on this Mac from the escalation's folder, in a row of
 * thumbnails: the conversation's own (`ImageView`), each under its caption.
 * One still being read keeps its tile; one that is gone is named.
 */
function Attachments({
  attachments,
}: {
  readonly attachments: readonly EscalationAttachment[];
}) {
  const [read, setRead] = useState<ReadonlyMap<string, ImageRef | null>>(
    () => new Map(),
  );
  useEffect(() => {
    let gone = false;
    const bridge = devhub();
    for (const one of attachments) {
      void bridge
        .readEscalationEmbed(one.path)
        .then(
          (file) =>
            file === null
              ? null
              : ({
                  mediaType: mediaTypeOf(file.mediaType, one.path),
                  source: { kind: "data", base64: base64Of(file.bytes) },
                  label: one.name,
                } satisfies ImageRef),
          () => null,
        )
        .then((image) => {
          if (gone) return;
          setRead((before) => new Map(before).set(one.path, image));
        });
    }
    return () => {
      gone = true;
    };
  }, [attachments]);
  if (attachments.length === 0) return null;
  return (
    <div
      className="conversation-images orchestrator-attachments"
      role="group"
      aria-label="添付"
    >
      {attachments.map((one) => {
        const image = read.get(one.path);
        if (image === undefined)
          return (
            <span
              key={one.path}
              className="conversation-image-pending"
              aria-busy="true"
              title={one.caption ?? one.name}
            />
          );
        if (image === null)
          return (
            <div
              key={one.path}
              className="conversation-image-missing"
              title={one.path}
            >
              Image not shown here: {one.name}
            </div>
          );
        return <ImageView key={one.path} image={image} caption={one.caption} />;
      })}
    </div>
  );
}

/** A picture's type, from what main read, else its name. */
function mediaTypeOf(read: string, path: string): string {
  if (read.startsWith("image/")) return read;
  const extension = /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}
