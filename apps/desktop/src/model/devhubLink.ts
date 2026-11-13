/**
 * `devhub:` links: a place inside DevHub, written the way a URL is.
 *
 * The orchestrator (and any agent) links to an agent, a workspace, a file, a
 * task, an escalation, the Orchestrator screen or a session the same way it links to
 * a web page — in an escalation's `--link`, in a Markdown body, in a chat
 * answer — and DevHub draws it as a chip that goes there. This module is the
 * one place the syntax is read and written; the CLI checks a link against
 * what is open (`main/cli/tell/service.ts`), and the pages resolve one
 * against the snapshot they draw (`resolveDevhubLink`).
 *
 * The syntax (`DEVHUB_LINK_FORMS`), every segment percent-encoded as a URI
 * component (`/` in a file path excepted):
 *
 * | link                                   | the place                              |
 * | -------------------------------------- | -------------------------------------- |
 * | `devhub:agent/<id or unique prefix>`   | an agent (≥ 4 characters of its id)    |
 * | `devhub:workspace/<id or name>`        | a workspace                            |
 * | `devhub:file/<absolute path>[:L[:C]]`  | a file, at line L, column C            |
 * | `devhub:task/<id>`                     | a task on the board                    |
 * | `devhub:escalation/<id>`               | an escalation: its task, on the board  |
 * | `devhub:orchestrator`                  | the Orchestrator screen                |
 * | `devhub:session/<session id>`          | the agent running that session         |
 *
 * A file's path is written without its leading `/` (the one after `file` is
 * it): `/Users/me/app/src/a b.ts` at line 12 is
 * `devhub:file/Users/me/app/src/a%20b.ts:12`. A `:` in the path is `%3A`,
 * so a trailing `:12` or `:12:3` is always the position. `?` and `#` are not
 * part of any link and must be encoded too.
 *
 * Pure: no DOM, no Node. See `docs/orchestrator.md` (devhub: links).
 */

export const DEVHUB_SCHEME = "devhub:";

export type DevhubLinkKind =
  | "agent"
  | "workspace"
  | "file"
  | "task"
  | "escalation"
  | "orchestrator"
  | "session";

export type DevhubLink =
  | { readonly kind: "agent"; readonly agent: string }
  | { readonly kind: "workspace"; readonly workspace: string }
  | {
      readonly kind: "file";
      /** Absolute and normalised: no `.`/`..` segment, no `//`. */
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    }
  | { readonly kind: "task"; readonly id: number }
  | { readonly kind: "escalation"; readonly id: number }
  | { readonly kind: "orchestrator" }
  | { readonly kind: "session"; readonly session: string };

export type DevhubLinkParse =
  | { readonly ok: true; readonly link: DevhubLink }
  | { readonly ok: false; readonly problem: string };

/** What is valid, one form a line: for a refusal to list. */
export const DEVHUB_LINK_FORMS: readonly string[] = [
  "devhub:agent/<agent id, or a unique prefix of 4+ characters>",
  "devhub:workspace/<workspace id or name>",
  "devhub:file/<absolute path, without its leading />[:line[:column]]",
  "devhub:task/<id>",
  "devhub:escalation/<id>",
  "devhub:orchestrator",
  "devhub:session/<session id>",
];

const AGENT = /^[A-Za-z0-9-]{4,64}$/u;
const SESSION = /^[A-Za-z0-9._-]{1,128}$/u;
const POSITION = /^(.*?):(\d{1,7})(?::(\d{1,7}))?$/su;
const MAX_LINK = 4096;

/** Whether `text` is written as a `devhub:` link at all (valid or not). */
export function isDevhubLink(text: string): boolean {
  return text.slice(0, DEVHUB_SCHEME.length).toLowerCase() === DEVHUB_SCHEME;
}

function decode(segment: string, what: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new LinkProblem(`${what} is not percent-encoded properly.`);
  }
}

class LinkProblem extends Error {}

function hasControl(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/u.test(text);
}

function positive(
  digits: string | undefined,
  what: string,
): number | undefined {
  if (digits === undefined) return undefined;
  const value = Number(digits);
  if (value < 1) throw new LinkProblem(`${what} starts at 1.`);
  return value;
}

function parseFile(rest: string): DevhubLink {
  const position = POSITION.exec(rest);
  const rawPath = position === null ? rest : position[1]!;
  const line = positive(position?.[2], "a line");
  const column = positive(position?.[3], "a column");
  if (rawPath.startsWith("/"))
    throw new LinkProblem(
      "a file's path is written without its leading / (devhub:file/Users/…).",
    );
  const segments = rawPath.split("/").map((one) => decode(one, "the path"));
  const path = `/${segments.join("/")}`;
  if (rawPath === "" || segments.some((one) => one === ""))
    throw new LinkProblem("a file's path has an empty segment.");
  if (segments.some((one) => one === "." || one === ".."))
    throw new LinkProblem("a file's path has a . or .. segment.");
  if (segments.some((one) => one.includes("/") || hasControl(one)))
    throw new LinkProblem("a file's path has a character it cannot have.");
  return {
    kind: "file",
    path,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}

function parseOrThrow(text: string): DevhubLink {
  if (!isDevhubLink(text))
    throw new LinkProblem(`${JSON.stringify(text)} is not a devhub: link.`);
  if (text.length > MAX_LINK) throw new LinkProblem("the link is too long.");
  const body = text.slice(DEVHUB_SCHEME.length);
  if (body.startsWith("/"))
    throw new LinkProblem("a devhub: link has no //: devhub:agent/<id>.");
  if (/[?#\s]/u.test(body))
    throw new LinkProblem(
      "a devhub: link has no query, fragment or space: percent-encode them.",
    );
  const slash = body.indexOf("/");
  const kind = (slash < 0 ? body : body.slice(0, slash)).toLowerCase();
  const rest = slash < 0 ? undefined : body.slice(slash + 1);
  if (kind === "orchestrator") {
    if (rest !== undefined && rest !== "")
      throw new LinkProblem("devhub:orchestrator takes nothing after it.");
    return { kind: "orchestrator" };
  }
  if (rest === undefined || rest === "") {
    if (
      ["agent", "workspace", "file", "task", "escalation", "session"].includes(
        kind,
      )
    )
      throw new LinkProblem(`devhub:${kind}/ needs what it names after the /.`);
    throw new LinkProblem(`devhub:${kind} is not a kind of devhub: link.`);
  }
  switch (kind) {
    case "agent": {
      const agent = decode(rest, "the agent");
      if (!AGENT.test(agent))
        throw new LinkProblem(
          "devhub:agent/ takes an agent id, or 4+ characters of one.",
        );
      return { kind: "agent", agent: agent.toLowerCase() };
    }
    case "workspace": {
      const workspace = decode(rest, "the workspace");
      if (workspace.trim() === "" || hasControl(workspace))
        throw new LinkProblem(
          "devhub:workspace/ takes a workspace id or name.",
        );
      if (workspace.length > 256)
        throw new LinkProblem("the workspace's name is too long.");
      return { kind: "workspace", workspace };
    }
    case "file":
      return parseFile(rest);
    case "task": {
      const match = /^(?:%23|#|t|T)?(\d{1,9})$/u.exec(rest);
      const id = match === null ? 0 : Number(match[1]);
      if (id < 1) throw new LinkProblem("devhub:task/ takes a task id (12).");
      return { kind: "task", id };
    }
    case "escalation": {
      const match = /^(?:%23|#|e|E)?(\d{1,9})$/u.exec(rest);
      const id = match === null ? 0 : Number(match[1]);
      if (id < 1)
        throw new LinkProblem(
          "devhub:escalation/ takes an escalation id (12).",
        );
      return { kind: "escalation", id };
    }
    case "session": {
      const session = decode(rest, "the session");
      if (!SESSION.test(session))
        throw new LinkProblem("devhub:session/ takes a session id.");
      return { kind: "session", session };
    }
    default:
      throw new LinkProblem(`devhub:${kind} is not a kind of devhub: link.`);
  }
}

/** Read a `devhub:` link, or say what is wrong with it. */
export function parseDevhubLink(text: string): DevhubLinkParse {
  try {
    return { ok: true, link: parseOrThrow(text.trim()) };
  } catch (error: unknown) {
    if (error instanceof LinkProblem)
      return { ok: false, problem: error.message };
    throw error;
  }
}

/**
 * A link as the system hands it to DevHub from outside — a click in Slack,
 * Notes or a browser (`main/shell/openFromUrl.ts`) — read as the link it is.
 *
 * The canonical spelling has no `//` (`devhub:agent/<id>`), and that is the
 * only spelling `parseDevhubLink` reads: inside DevHub a link is written by
 * DevHub or by `devhub --tell link`. Outside it, a person may have typed
 * `devhub://agent/<id>` — the shape a URL "usually" has, and the one some
 * apps only make clickable — and an app may add a slash at the end. Both are
 * the same place, so here, and only here, the slashes after the scheme and
 * the trailing ones are let go of before it is read; what is not a link
 * after that is refused the way any other is.
 */
export function parseExternalDevhubUrl(url: string): DevhubLinkParse {
  const text = url.trim();
  if (!isDevhubLink(text)) return parseDevhubLink(text);
  let body = text.slice(DEVHUB_SCHEME.length).replace(/^\/+/u, "");
  // A file's path keeps its slashes: `file/` is what follows, and a trailing
  // slash there is a folder, which the link refuses for itself.
  if (!/^file\//iu.test(body)) body = body.replace(/\/+$/u, "");
  return parseDevhubLink(`${DEVHUB_SCHEME}${body}`);
}

/**
 * The link as Markdown, `[name](devhub:…)`: what Copy Markdown Link
 * puts on the clipboard, for a task's body, a note, a chat. The name is the
 * place's own (an agent's display name), with Markdown's brackets and
 * backslash escaped and its whitespace one space, so a name cannot end the
 * link early; an empty one is the link itself.
 */
export function markdownDevhubLink(name: string, link: DevhubLink): string {
  const href = formatDevhubLink(link);
  const text = name
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\\[\]]/gu, (mark) => `\\${mark}`);
  return `[${text === "" ? href : text}](${href})`;
}

/** A path segment: a URI component, with `:` (the position's mark) encoded too. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/:/gu, "%3A");
}

/** The canonical spelling of a link: what `parseDevhubLink` reads back as `link`. */
export function formatDevhubLink(link: DevhubLink): string {
  switch (link.kind) {
    case "agent":
      return `${DEVHUB_SCHEME}agent/${encodeSegment(link.agent)}`;
    case "workspace":
      return `${DEVHUB_SCHEME}workspace/${encodeSegment(link.workspace)}`;
    case "file": {
      const path = link.path
        .replace(/^\/+/u, "")
        .split("/")
        .map(encodeSegment)
        .join("/");
      const at =
        link.line === undefined
          ? ""
          : `:${String(link.line)}${link.column === undefined ? "" : `:${String(link.column)}`}`;
      return `${DEVHUB_SCHEME}file/${path}${at}`;
    }
    case "task":
      return `${DEVHUB_SCHEME}task/${String(link.id)}`;
    case "escalation":
      return `${DEVHUB_SCHEME}escalation/${String(link.id)}`;
    case "orchestrator":
      return `${DEVHUB_SCHEME}orchestrator`;
    case "session":
      return `${DEVHUB_SCHEME}session/${encodeSegment(link.session)}`;
  }
}

/** The last segment of a path: what a file chip is called. */
export function baseName(path: string): string {
  const parts = path.split("/").filter((one) => one !== "");
  return parts[parts.length - 1] ?? path;
}

/** `:12` or `:12:3`, or nothing. */
export function positionSuffix(line?: number, column?: number): string {
  if (line === undefined) return "";
  return `:${String(line)}${column === undefined ? "" : `:${String(column)}`}`;
}

// --- resolving against what is open -------------------------------------------

/** What a link is resolved against: the snapshot's facts, structurally. */
export interface LinkableAgent {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
}

export interface LinkableWorkspace {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  /** `local`, or a host: a file is looked for on this Mac's first. */
  readonly local: boolean;
  readonly agents: readonly LinkableAgent[];
}

export interface LinkableTask {
  readonly id: number;
  readonly title: string;
  readonly status: string;
}

export interface LinkableEscalation {
  readonly id: number;
  readonly taskId: number;
  readonly title: string;
  readonly state: string;
}

export interface LinkPlaces {
  readonly workspaces: readonly LinkableWorkspace[];
  readonly tasks: readonly LinkableTask[];
  readonly escalations: readonly LinkableEscalation[];
  /** Whether there is an Orchestrator row to go to. */
  readonly orchestrator: boolean;
}

export type ResolvedLink =
  | {
      readonly kind: "agent";
      readonly agent: LinkableAgent;
      readonly workspace: LinkableWorkspace;
    }
  | { readonly kind: "workspace"; readonly workspace: LinkableWorkspace }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
      /** The open Workspace whose root is the file's nearest ancestor. */
      readonly workspace: LinkableWorkspace;
    }
  | { readonly kind: "task"; readonly task: LinkableTask }
  | {
      readonly kind: "escalation";
      readonly escalation: LinkableEscalation;
      /** Its task: where it is read. */
      readonly task: LinkableTask;
    }
  | { readonly kind: "orchestrator" }
  /** Resolved later, by asking main which agent runs it. */
  | { readonly kind: "session"; readonly session: string };

export type LinkResolution =
  | { readonly found: true; readonly target: ResolvedLink }
  | { readonly found: false; readonly why: string };

function contains(root: string, path: string): boolean {
  const base = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(base);
}

/**
 * The open Workspace a file belongs to: the one whose root is its nearest
 * ancestor, this Mac's before a host's at the same depth.
 */
export function owningWorkspace<W extends LinkableWorkspace>(
  path: string,
  workspaces: readonly W[],
): W | undefined {
  let best: W | undefined;
  for (const one of workspaces) {
    if (!contains(one.root, path)) continue;
    if (
      best === undefined ||
      one.root.length > best.root.length ||
      (one.root.length === best.root.length && one.local && !best.local)
    )
      best = one;
  }
  return best;
}

/** One agent named by an id or a unique prefix of one (≥ 4 characters). */
export function agentByIdOrPrefix<A extends { readonly id: string }>(
  name: string,
  agents: readonly A[],
): A | undefined {
  const lower = name.toLowerCase();
  const exact = agents.find((agent) => agent.id.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  if (lower.length < 4) return undefined;
  const prefixed = agents.filter((agent) =>
    agent.id.toLowerCase().startsWith(lower),
  );
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** One workspace named by its id, its unique name, or a unique id prefix. */
export function workspaceByIdOrName<W extends LinkableWorkspace>(
  name: string,
  workspaces: readonly W[],
): W | undefined {
  const byId = workspaces.find((one) => one.id === name);
  if (byId !== undefined) return byId;
  const named = workspaces.filter((one) => one.label === name);
  if (named.length === 1) return named[0];
  if (named.length > 1 || name.length < 4) return undefined;
  const prefixed = workspaces.filter((one) => one.id.startsWith(name));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** Where a link leads in what is open now, or why it leads nowhere. */
export function resolveDevhubLink(
  link: DevhubLink,
  places: LinkPlaces,
): LinkResolution {
  switch (link.kind) {
    case "agent": {
      // A prefix shared by agents of two workspaces names neither.
      const all = places.workspaces.flatMap((workspace) =>
        workspace.agents.map((agent) => ({ id: agent.id, agent, workspace })),
      );
      const one = agentByIdOrPrefix(link.agent, all);
      return one === undefined
        ? { found: false, why: "no such agent is open" }
        : {
            found: true,
            target: {
              kind: "agent",
              agent: one.agent,
              workspace: one.workspace,
            },
          };
    }
    case "workspace": {
      const workspace = workspaceByIdOrName(link.workspace, places.workspaces);
      return workspace === undefined
        ? { found: false, why: "no such workspace is open" }
        : { found: true, target: { kind: "workspace", workspace } };
    }
    case "file": {
      const workspace = owningWorkspace(link.path, places.workspaces);
      return workspace === undefined
        ? { found: false, why: "no open workspace holds this file" }
        : { found: true, target: { ...link, workspace } };
    }
    case "task": {
      const task = places.tasks.find((one) => one.id === link.id);
      return task === undefined
        ? { found: false, why: "there is no such task" }
        : { found: true, target: { kind: "task", task } };
    }
    case "escalation": {
      const escalation = places.escalations.find((one) => one.id === link.id);
      const task =
        escalation === undefined
          ? undefined
          : places.tasks.find((one) => one.id === escalation.taskId);
      return escalation === undefined || task === undefined
        ? { found: false, why: "there is no such escalation" }
        : { found: true, target: { kind: "escalation", escalation, task } };
    }
    case "orchestrator":
      return places.orchestrator
        ? { found: true, target: { kind: "orchestrator" } }
        : { found: false, why: "there is no Orchestrator row" };
    case "session":
      return { found: true, target: link };
  }
}

/**
 * The canonical link to a place that was found — by its id, whatever the
 * link that found it said (a prefix, a workspace's name): what Copy Link
 * copies, so a copied link goes on naming the same thing.
 */
export function linkToTarget(target: ResolvedLink): DevhubLink {
  switch (target.kind) {
    case "agent":
      return { kind: "agent", agent: target.agent.id };
    case "workspace":
      return { kind: "workspace", workspace: target.workspace.id };
    case "file":
      return {
        kind: "file",
        path: target.path,
        ...(target.line === undefined ? {} : { line: target.line }),
        ...(target.column === undefined ? {} : { column: target.column }),
      };
    case "task":
      return { kind: "task", id: target.task.id };
    case "escalation":
      return { kind: "escalation", id: target.escalation.id };
    case "orchestrator":
      return { kind: "orchestrator" };
    case "session":
      return { kind: "session", session: target.session };
  }
}

/** What a place is called, as its chip names it: a Markdown link's text. */
export function targetName(target: ResolvedLink): string {
  switch (target.kind) {
    case "agent":
      return target.agent.displayName;
    case "workspace":
      return target.workspace.label;
    case "file":
      return `${baseName(target.path)}${positionSuffix(target.line, target.column)}`;
    case "task":
      return `#${String(target.task.id)} ${target.task.title}`;
    case "escalation":
      return `#${String(target.escalation.id)} ${target.escalation.title}`;
    case "orchestrator":
      return "Orchestrator";
    case "session":
      return target.session.slice(0, 8);
  }
}
