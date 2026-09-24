/**
 * Pure DevHub domain values and lifecycle rules.
 *
 * A port of `crates/devhub-app-core/src/domain.rs`. It has no Electron, no
 * filesystem and no process dependency: adapters hand validated values across
 * this seam, and identity, ownership and lifecycle invariants live here.
 *
 * Rust's newtypes become branded strings. The brand is what makes a
 * `WorkspaceId` refuse to be an `AgentId` at compile time; the runtime value
 * stays a plain string, so it is still a `Map` key and still serialises to the
 * wire without a conversion step.
 */

export enum DomainErrorCode {
  InvalidId = "INVALID_ID",
  InvalidPath = "INVALID_PATH",
  InvalidHost = "INVALID_HOST",
  InvalidRemote = "INVALID_REMOTE",
  InvalidDisplayName = "INVALID_DISPLAY_NAME",
  InvalidOrdinal = "INVALID_ORDINAL",
  OrdinalExhausted = "ORDINAL_EXHAUSTED",
  InvalidBusyCount = "INVALID_BUSY_COUNT",
  DuplicateWorkspace = "DUPLICATE_WORKSPACE",
  DuplicateWorkspaceRoot = "DUPLICATE_WORKSPACE_ROOT",
  DuplicateAgent = "DUPLICATE_AGENT",
  UnknownRepository = "UNKNOWN_REPOSITORY",
  RepositoryIdentityConflict = "REPOSITORY_IDENTITY_CONFLICT",
  RepositoryRemoteConflict = "REPOSITORY_REMOTE_CONFLICT",
  UnknownWorkspace = "UNKNOWN_WORKSPACE",
  UnknownAgent = "UNKNOWN_AGENT",
  WorkspaceUnavailable = "WORKSPACE_UNAVAILABLE",
  WorkspaceNotClean = "WORKSPACE_NOT_CLEAN",
  ScratchCannotClose = "SCRATCH_CANNOT_CLOSE",
  InvalidProfile = "INVALID_PROFILE",
  AgentWorkspaceMismatch = "AGENT_WORKSPACE_MISMATCH",
  WorkspaceNotUnavailable = "WORKSPACE_NOT_UNAVAILABLE",
  InvalidAgentControlTransition = "INVALID_AGENT_CONTROL_TRANSITION",
  WorkspaceHasLiveAgents = "WORKSPACE_HAS_LIVE_AGENTS",
  WorkspaceClosing = "WORKSPACE_CLOSING",
  WorkspaceClosingFailed = "WORKSPACE_CLOSING_FAILED",
  InvalidSidebarWidth = "INVALID_SIDEBAR_WIDTH",
  InvalidSplitRatio = "INVALID_SPLIT_RATIO",
  InvalidTerminalZoom = "INVALID_TERMINAL_ZOOM",
}

/**
 * A domain operation failure. The code is stable; no provider or user content
 * is ever stored on it.
 */
export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode) {
    super(code);
    this.name = "DomainError";
  }
}

function invalid(code: DomainErrorCode): DomainError {
  return new DomainError(code);
}

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type AgentId = Brand<string, "AgentId">;
export type AgentProfileId = Brand<string, "AgentProfileId">;
export type WorkspaceRoot = Brand<string, "WorkspaceRoot">;
export type DisplayPath = Brand<string, "DisplayPath">;
export type RemoteIdentity = Brand<string, "RemoteIdentity">;
export type SshHost = Brand<string, "SshHost">;

export function isCanonicalUuid(raw: string): boolean {
  return (
    raw.length === 36 &&
    raw === raw.toLowerCase() &&
    [...raw].every((character, index) =>
      index === 8 || index === 13 || index === 18 || index === 23
        ? character === "-"
        : /[0-9a-f]/.test(character),
    )
  );
}

function uuidId<T extends string>(raw: string): Brand<string, T> {
  if (!isCanonicalUuid(raw)) {
    throw invalid(DomainErrorCode.InvalidId);
  }
  return raw as Brand<string, T>;
}

export const workspaceId = (raw: string): WorkspaceId =>
  uuidId<"WorkspaceId">(raw);
export const repositoryId = (raw: string): RepositoryId =>
  uuidId<"RepositoryId">(raw);
export const agentId = (raw: string): AgentId => uuidId<"AgentId">(raw);

export function isSlug(raw: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(raw);
}

/** A validated configuration identifier, distinct from a runtime UUID. */
export function agentProfileId(raw: string): AgentProfileId {
  if (!isSlug(raw)) {
    throw invalid(DomainErrorCode.InvalidId);
  }
  return raw as AgentProfileId;
}

/**
 * Lexical normalisation, exactly as the Rust did it: `.` drops out, `..` pops,
 * and a `..` that would escape the root is rejected rather than clamped.
 */
function normalizeAbsolutePath(path: string): string {
  if (path.length === 0 || path.includes("\0") || !path.startsWith("/")) {
    throw invalid(DomainErrorCode.InvalidPath);
  }
  const parts: string[] = [];
  for (const component of path.split("/")) {
    if (component === "" || component === ".") {
      continue;
    }
    if (component === "..") {
      if (parts.pop() === undefined) {
        throw invalid(DomainErrorCode.InvalidPath);
      }
      continue;
    }
    parts.push(component);
  }
  return `/${parts.join("/")}`;
}

/** Canonical Workspace Root: the duplicate-prevention key. */
export function workspaceRoot(path: string): WorkspaceRoot {
  return normalizeAbsolutePath(path) as WorkspaceRoot;
}

/** A path the user picked, expanded and canonicalised by the adapter first. */
export function displayPath(path: string): DisplayPath {
  return normalizeAbsolutePath(path) as DisplayPath;
}

export function rootBasename(root: WorkspaceRoot): string {
  const name = root.split("/").filter(Boolean).at(-1);
  return name && name.length > 0 ? name : "/";
}

/**
 * A path as a person writes it: under their home directory, `~`.
 *
 * It is a rendering and never an identity. The canonical root is what tells two
 * Workspaces apart, what keys a session, what git is run in and what the CLI is
 * given; this is what a row shows a person who already knows where they live.
 * Nothing reads it back — there is no inverse here — because a `~` that came
 * back the other way would be this machine's home standing in for whichever
 * machine's home wrote it.
 *
 * Which home, is the whole reason this takes one rather than reading it. A
 * Workspace on another machine has its folder under *that* machine's home, and
 * a NAS whose `$HOME` is `/volume1/home/x` shares no prefix with this Mac's.
 * So the caller — main, which is the only thing that can ask a machine anything
 * — says whose home it is, and a page never guesses.
 *
 * `/` is not a home. A machine that answered it would otherwise turn every
 * absolute path on it into `~`-something, which is the one wrong answer that
 * looks like a right one.
 */
export function abbreviateHome(path: string, home: string | undefined): string {
  if (home === undefined || home === "/" || !home.startsWith("/")) return path;
  const trimmed = home.endsWith("/") ? home.slice(0, -1) : home;
  if (path === trimmed) return "~";
  return path.startsWith(`${trimmed}/`)
    ? `~${path.slice(trimmed.length)}`
    : path;
}

/** Parent directory names, nearest first — the disambiguation source. */
export function rootParentComponents(root: WorkspaceRoot): string[] {
  return root.split("/").filter(Boolean).slice(0, -1).reverse();
}

/**
 * The machine an SSH Workspace's folder is on, named the way `ssh` names it.
 *
 * Either a `Host` alias out of `~/.ssh/config` or `user@hostname`, optionally
 * with `:port` — which is the whole of what `ssh` itself accepts as a
 * destination, and therefore the whole of what Open Remote - SSH can resolve.
 * DevHub does not resolve it, look it up, or check that it is reachable: the
 * alias is the person's word for the machine, and expanding it here would mean
 * DevHub and `ssh` could disagree about which machine that is.
 *
 * What is rejected is only what cannot survive being an authority in
 * `vscode-remote://ssh-remote+<host>/<path>`: a slash, whitespace, or a control
 * character would silently re-parse into a different URI.
 */
export function sshHost(raw: string): SshHost {
  const trimmed = raw.trim();
  if (
    !/^[A-Za-z0-9._~%-]+(?:@[A-Za-z0-9._~%[\]-]+)?(?::[0-9]+)?$/.test(trimmed)
  ) {
    throw invalid(DomainErrorCode.InvalidHost);
  }
  return trimmed as SshHost;
}

/**
 * Where a Workspace's folder is.
 *
 * A Workspace used to be a local directory and nothing else, so its root was
 * both "the folder" and "which folder, out of all the folders there are". Once
 * a folder can be on another machine those are two different facts: `/src/api`
 * on two hosts is two Workspaces, and `/src/api` here is a third.
 *
 * So the place is one value with the machine in it, and identity is
 * `locationKey`, not the path. Every question that used to be asked of the path
 * — is it a duplicate, which window is showing it, which group does it order
 * into — is asked of the key instead, and gets the same answer as before for a
 * local folder because a local folder's key *is* its path.
 *
 * There is a third kind, and it is the last one this shape can absorb without
 * a rethink: a Dev Container. It is not "ssh with a different transport" — the
 * folder is on *this* machine and bind-mounted into a container, so the place
 * has two paths in it, the one here and the one in there, and neither is
 * redundant. `path` is the path a workbench opens, inside the container;
 * `workspaceFolder` is the folder on this Mac that holds the `.devcontainer/`
 * and that git runs in. Identity is the host folder, because a container is
 * rebuilt routinely and a Workspace must survive that — see `locationKey`.
 *
 * There is still no `kind: "unknown"`.
 */
export type WorkspaceLocation =
  | { readonly kind: "local"; readonly path: WorkspaceRoot }
  | {
      readonly kind: "ssh";
      readonly host: SshHost;
      readonly path: WorkspaceRoot;
    }
  | {
      readonly kind: "container";
      /**
       * The folder on this Mac that holds the dev container definition, and
       * that is bind-mounted into it. This is the Workspace's identity.
       */
      readonly workspaceFolder: WorkspaceRoot;
      /**
       * The `devcontainer.json` this folder was opened with, when it is not the
       * one the CLI would find by itself. Carried so that a folder with more
       * than one definition opens the same one twice running; deliberately
       * *not* part of the identity or the authority, so that the key a window
       * is filed under does not change when it is set.
       */
      readonly configPath?: string;
      /** Where the folder is mounted inside the container. */
      readonly path: WorkspaceRoot;
    };

/**
 * Which machine, as a key.
 *
 * `local`, or `ssh:<host>`. It is what a per-host cache is filed under, what a
 * metrics reading is named by, and what a terminal target carries — so it is a
 * string rather than an object: two runtimes with the same id are the same
 * machine, and that has to be a comparison rather than a convention.
 *
 * It is in the model and not beside `Runtime` because the model is where a
 * location is, and this is a location with everything but the machine taken
 * off. `main/runtime/runtime.ts` re-exports it, beside the implementations
 * that answer for a machine.
 */
export type RuntimeId = "local" | `ssh:${string}` | `container:${string}`;

/**
 * The machine a dev container Workspace's folder is on, as an id.
 *
 * Keyed on the **host folder** and not on the container id, for the reason
 * `locationKey` is: `devcontainer up` after an image change hands back a new
 * container, and a machine id that carried the old one would make the rebuilt
 * container a different machine — a second runtime, a second tmux install, a
 * second everything, while the first went on being cached under a name nothing
 * would ever ask for again. The runtime behind this id is what notices the
 * container changed underneath it, and it is disposed and rebuilt when it does.
 */
export function containerMachine(workspaceFolder: WorkspaceRoot): RuntimeId {
  return `container:${workspaceFolder}`;
}

/** What a caller says about a place, before any of it has been validated. */
export type RequestedLocation =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "ssh"; readonly host: string; readonly path: string }
  | {
      readonly kind: "container";
      readonly workspaceFolder: string;
      readonly configPath?: string;
      readonly path: string;
    };

/**
 * The one way a `WorkspaceLocation` is made.
 *
 * One constructor rather than one per kind, because the thing that must not
 * drift is the *set* of kinds: a second constructor is a second place to forget
 * when a third kind arrives, and the exhaustive switch that would have caught
 * it is in here.
 */
export function workspaceLocation(
  requested: RequestedLocation,
): WorkspaceLocation {
  switch (requested.kind) {
    case "local":
      return { kind: "local", path: workspaceRoot(requested.path) };
    case "ssh":
      return {
        kind: "ssh",
        host: sshHost(requested.host),
        path: workspaceRoot(requested.path),
      };
    case "container":
      return {
        kind: "container",
        workspaceFolder: workspaceRoot(requested.workspaceFolder),
        // Absent rather than empty when there is nothing to say: a
        // `configPath: ""` would be a second spelling of "the CLI decides",
        // and two spellings of one fact are two things to compare against.
        ...(requested.configPath === undefined || requested.configPath === ""
          ? {}
          : { configPath: requested.configPath }),
        path: workspaceRoot(requested.path),
      };
  }
}

/**
 * The same machine, a different folder on it.
 *
 * Re-pointing a Workspace at another folder cannot move it to another
 * computer, so every field that says *which machine* is carried over and only
 * the path changes. It is a switch here rather than a ternary at the call site
 * because "which machine" is one field for ssh and two for a container, and a
 * call site that spelled that itself is a call site that would keep compiling
 * while quietly dropping one of them.
 */
export function relocatedOnSameMachine(
  location: WorkspaceLocation,
  path: string,
): RequestedLocation {
  switch (location.kind) {
    case "local":
      return { kind: "local", path };
    case "ssh":
      return { kind: "ssh", host: location.host, path };
    case "container":
      return {
        kind: "container",
        workspaceFolder: location.workspaceFolder,
        ...(location.configPath === undefined
          ? {}
          : { configPath: location.configPath }),
        path,
      };
  }
}

/**
 * Where git can run: this Mac, or a host. Never a container — that is the
 * invariant `gitPlaceOf` enforces, stated as a type so that a caller which
 * one day forwards a container place to git does not compile rather than
 * quietly running `git` where no `.git` may be.
 */
/**
 * Where this Workspace's git runs, which is not always where its terminals do.
 *
 * For a folder on this Mac and a folder on a host these are the same place and
 * always were, which is why there was no such function. A dev container is the
 * first location where they part: the folder is bind-mounted, so it exists on
 * both sides, and the two candidates are not equivalent.
 *
 * **Git runs on this Mac.** Three reasons, in order. Watching a directory here
 * is a real `fs.watch`, not the `cksum`-over-`refs` polling a far machine has
 * to be asked for — a fidelity win, not a cost one. A Workspace's branch,
 * worktrees and pull request rows are DevHub's own panel, and a container that
 * is stopped would otherwise take all of it with it, when a stopped container
 * is meant to be a state and not a failure. And the container may not have
 * been built yet when the row is first drawn.
 *
 * Terminals and Agents go the other way — into the container, unconditionally.
 * That is the whole point of a dev container, and it is what "an Agent launches
 * on its Workspace's machine" has always meant.
 *
 * The rule holds with no probe because of where these locations come from:
 * DevHub makes one out of a folder on this Mac, so the host folder is a path
 * that exists here by construction. A `devcontainer.json` that clones into a
 * volume instead of bind-mounting is not something DevHub offers to open, and
 * if it ever is, this is the one function that has to learn about it.
 */
export type GitPlace =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "ssh"; readonly host: string; readonly path: string };

export function gitPlaceOf(location: WorkspaceLocation): GitPlace {
  switch (location.kind) {
    case "local":
      return { kind: "local", path: location.path };
    case "ssh":
      return { kind: "ssh", host: location.host, path: location.path };
    case "container":
      return { kind: "local", path: location.workspaceFolder };
  }
}

/**
 * What makes two Workspaces the same Workspace.
 *
 * A local folder's key is its canonical path, unchanged, so every comparison
 * that predates SSH keeps the answer it had — including the ones that compare a
 * key against a path git handed over, such as a main worktree.
 */
export function locationKey(location: WorkspaceLocation): string {
  switch (location.kind) {
    case "local":
      return location.path;
    case "ssh":
      return `ssh://${location.host}${location.path}`;
    // The folder on this Mac, not the container and not the path inside it.
    // A dev container is rebuilt whenever its image changes — that is the
    // point of one — and a key that moved with it would make every rebuild a
    // brand-new Workspace, losing the row, its Agents and its history to an
    // event the person thinks of as a refresh. The host folder is the thing
    // that does not move.
    case "container":
      return `dev-container://${location.workspaceFolder}`;
  }
}

/**
 * The place, spelled out for a person: the path, with the machine in front of
 * it when the machine is not this one.
 *
 * `host:path` rather than the key's `ssh://host/path`, because this is read and
 * the key is compared. It is what `scp` writes and what the person typed.
 */
export function locationLabel(location: WorkspaceLocation): string {
  switch (location.kind) {
    case "local":
      return location.path;
    case "ssh":
      return `${location.host}:${location.path}`;
    // The host folder, which is the name the person chose and the one they
    // will recognise; the path inside the container is an implementation of
    // the mount and says nothing they picked.
    case "container":
      return `${location.workspaceFolder} (dev container)`;
  }
}

/**
 * The authority a workbench is opened on, or nothing for a folder on this
 * machine.
 *
 * `ssh-remote+<host>` is Open Remote - SSH's, declared by its
 * `onResolveRemoteAuthority:ssh-remote` and its `ssh-remote+*` resource label
 * formatter. Composed here, once, so that the URI the window is opened with and
 * the authority the extension is asked to resolve cannot come to disagree.
 */
export function remoteAuthorityOf(
  location: WorkspaceLocation,
): string | undefined {
  switch (location.kind) {
    case "local":
      return undefined;
    case "ssh":
      return `ssh-remote+${location.host}`;
    case "container":
      return `${DEV_CONTAINER_PREFIX}${encodeContainerAuthority(location.workspaceFolder)}`;
  }
}

/**
 * The authority prefix DevHub's own resolver registers for dev containers.
 *
 * Declared three times and they have to agree: here, the extension's
 * `onResolveRemoteAuthority:dev-container`, and its resource label formatter.
 * If they drift the window opens on an authority nobody resolves and sits on
 * "Opening Remote…" forever, which is the failure with no message.
 *
 * `dev-container` is the name Microsoft's closed extension uses, and DevHub
 * uses it too. Not for compatibility — nothing is exchanged with it, and the
 * hex payload below is DevHub's own shape — but because it is the name that
 * appears in a person's window title and in every piece of writing about dev
 * containers there is, and inventing a second word for the same idea would
 * only mean explaining which one this is.
 */
export const DEV_CONTAINER_PREFIX = "dev-container+";

/**
 * The host folder, carried in the authority.
 *
 * Hex of JSON, which is the shape the ecosystem already writes, and it holds
 * the host folder and nothing else. Not the container id: the authority is a
 * window's identity and a rebuilt container must not change it. Not
 * `configPath` either — it is not part of `locationKey`, so an authority that
 * carried it would be a second identity for one Workspace, and the two would
 * disagree the moment somebody set it.
 *
 * Hex rather than base64url because a URI authority is case-insensitive in
 * some hands and base64 is not, and a payload that survived being lowercased
 * is a payload that cannot be corrupted by one.
 */
export function encodeContainerAuthority(workspaceFolder: string): string {
  const json = JSON.stringify({ hostPath: workspaceFolder });
  let hex = "";
  for (const byte of new TextEncoder().encode(json)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * The inverse, or `undefined` for a payload this DevHub did not write.
 *
 * Undefined rather than a throw: the authority arrives from a URI VS Code
 * handed over, which is not a value DevHub validated, and a window on an
 * authority that does not decode is a window DevHub has no Workspace for —
 * the same answer as a window on somebody else's authority.
 */
export function decodeContainerAuthority(payload: string): string | undefined {
  if (payload.length === 0 || payload.length % 2 !== 0) return undefined;
  if (!/^[0-9a-fA-F]+$/.test(payload)) return undefined;
  const bytes = new Uint8Array(payload.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(payload.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const hostPath = (parsed as { hostPath?: unknown }).hostPath;
    return typeof hostPath === "string" && hostPath.length > 0
      ? hostPath
      : undefined;
  } catch {
    return undefined;
  }
}

type RemoteScheme = "bare" | "scp" | "http" | "https" | "ssh";

const DEFAULT_PORTS: Readonly<Record<RemoteScheme, number | undefined>> = {
  bare: undefined,
  scp: undefined,
  http: 80,
  https: 443,
  ssh: 22,
};

function normalizeAuthority(authority: string): [string, number | undefined] {
  const trimmed = authority.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const host = trimmed.slice(0, colon);
    const port = trimmed.slice(colon + 1);
    if (host.length > 0 && port.length > 0 && /^[0-9]+$/.test(port)) {
      return [host, Number.parseInt(port, 10)];
    }
  }
  if (trimmed.length === 0) {
    throw invalid(DomainErrorCode.InvalidRemote);
  }
  return [trimmed, undefined];
}

/**
 * A normalised remote identity. Credentials, scheme, leading slash and a
 * trailing `.git` are deliberately absent, so HTTPS and SSH aliases compare
 * equal without touching Git or the network.
 */
export function remoteIdentity(input: string): RemoteIdentity {
  const raw = input.trim();
  if (raw.length === 0 || raw.includes("\0")) {
    throw invalid(DomainErrorCode.InvalidRemote);
  }
  const withoutQuery = raw.split(/[?#]/)[0] ?? "";

  let authority: string;
  let path: string;
  let scheme: RemoteScheme;
  const schemeMatch = /^(https|http|ssh):\/\/(.*)$/.exec(withoutQuery);
  if (!withoutQuery.includes("://")) {
    const colon = withoutQuery.indexOf(":");
    if (colon >= 0) {
      const at = withoutQuery.slice(0, colon).lastIndexOf("@");
      if (at < 0) {
        throw invalid(DomainErrorCode.InvalidRemote);
      }
      authority = withoutQuery.slice(at + 1, colon);
      path = withoutQuery.slice(colon + 1);
      scheme = "scp";
    } else {
      const slash = withoutQuery.indexOf("/");
      if (slash < 0) {
        throw invalid(DomainErrorCode.InvalidRemote);
      }
      authority = withoutQuery.slice(0, slash);
      path = withoutQuery.slice(slash + 1);
      scheme = "bare";
    }
  } else if (schemeMatch) {
    scheme = schemeMatch[1] as RemoteScheme;
    const rest = schemeMatch[2] ?? "";
    const slash = rest.indexOf("/");
    if (slash < 0) {
      throw invalid(DomainErrorCode.InvalidRemote);
    }
    const rawAuthority = rest.slice(0, slash);
    const at = rawAuthority.lastIndexOf("@");
    authority = at >= 0 ? rawAuthority.slice(at + 1) : rawAuthority;
    path = rest.slice(slash + 1);
  } else {
    throw invalid(DomainErrorCode.InvalidRemote);
  }

  const [rawHost, rawPort] = normalizeAuthority(authority);
  const defaultPort = DEFAULT_PORTS[scheme];
  const port =
    defaultPort !== undefined && rawPort === defaultPort ? undefined : rawPort;

  let normalizedPath = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  normalizedPath = normalizedPath.replace(/\.git$/, "");
  const host = rawHost.trim();
  if (
    host.length === 0 ||
    normalizedPath.length === 0 ||
    /\s/.test(host) ||
    /\s/.test(normalizedPath) ||
    normalizedPath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw invalid(DomainErrorCode.InvalidRemote);
  }

  const lowerHost = host.toLowerCase();
  const finalPath =
    lowerHost === "github.com" ? normalizedPath.toLowerCase() : normalizedPath;
  const finalAuthority =
    port === undefined ? lowerHost : `${lowerHost}:${port}`;
  return `${finalAuthority}/${finalPath}` as RemoteIdentity;
}

/** A Git remote identity and its normalised aliases. */
export class Repository {
  readonly aliases: readonly RemoteIdentity[];

  constructor(
    readonly id: RepositoryId,
    readonly primaryRemote: RemoteIdentity,
    aliases: Iterable<RemoteIdentity> = [],
  ) {
    this.aliases = [
      ...new Set<RemoteIdentity>([primaryRemote, ...aliases]),
    ].sort();
  }

  matchesRemote(remote: RemoteIdentity): boolean {
    return this.aliases.includes(remote);
  }

  equals(other: Repository): boolean {
    return (
      this.id === other.id &&
      this.primaryRemote === other.primaryRemote &&
      this.aliases.length === other.aliases.length &&
      this.aliases.every((alias, index) => alias === other.aliases[index])
    );
  }
}

/**
 * Whose screen an Agent's program draws.
 *
 * It is not "which program to run" — that is the profile's `command`. It is the
 * only thing status detection can be keyed on, so `custom` is a real member
 * rather than an absence: it says, permanently, that DevHub has no manifest for
 * this screen and will not guess at one. An Agent on a `custom` profile is a
 * live pane with a `?` for a status, which is exactly what attaching an editor
 * or a plain command should get you.
 */
export const AGENT_PROFILE_KINDS = [
  "codex",
  "claude",
  "cursor",
  "custom",
] as const;
export type AgentProfileKind = (typeof AGENT_PROFILE_KINDS)[number];

export function validDisplayName(value: string): boolean {
  return value.trim().length > 0 && !value.includes("\0");
}

export function isEnvironmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/**
 * A user-configured profile snapshot. An Agent keeps a copy at launch so later
 * profile edits do not mutate an already-running session.
 *
 * `args` and `env` can carry credentials, so nothing here has a `toString` or
 * an inspection that would print them.
 */
export class AgentProfile {
  private constructor(
    readonly id: AgentProfileId,
    readonly displayName: string,
    readonly kind: AgentProfileKind,
    /**
     * The program to run. It is what makes the Agent an Agent; `kind` only
     * says whose screen it is, so that a detector knows how to read it.
     */
    readonly command: string,
    readonly args: readonly string[],
    readonly env: ReadonlyMap<string, string>,
  ) {}

  static create(
    id: AgentProfileId,
    displayName: string,
    kind: AgentProfileKind,
    command: string,
    args: readonly string[] = [],
    env: ReadonlyMap<string, string> = new Map(),
  ): AgentProfile {
    if (!validDisplayName(displayName)) {
      throw invalid(DomainErrorCode.InvalidDisplayName);
    }
    if (command.trim().length === 0 || command.includes("\0")) {
      throw invalid(DomainErrorCode.InvalidProfile);
    }
    if (
      args.some((argument) => argument.includes("\0")) ||
      [...env].some(
        ([key, value]) =>
          key.length === 0 || key.includes("\0") || value.includes("\0"),
      )
    ) {
      throw invalid(DomainErrorCode.InvalidProfile);
    }
    return new AgentProfile(
      id,
      displayName,
      kind,
      command,
      [...args],
      new Map([...env].sort(([left], [right]) => (left < right ? -1 : 1))),
    );
  }

  equals(other: AgentProfile): boolean {
    if (
      this.id !== other.id ||
      this.displayName !== other.displayName ||
      this.kind !== other.kind ||
      this.command !== other.command ||
      this.args.length !== other.args.length ||
      this.env.size !== other.env.size
    ) {
      return false;
    }
    return (
      this.args.every((argument, index) => argument === other.args[index]) &&
      [...this.env].every(([key, value]) => other.env.get(key) === value)
    );
  }
}

/**
 * What an Agent is doing.
 *
 * `unknown` is not a failure and not a transient. It is the permanent answer
 * for an Agent whose screen DevHub has no detector for — a profile with a
 * command and no manifest — and it is what every Agent reports until a
 * detector for its kind says otherwise. Folding it into `error` would tell
 * somebody who deliberately attached a plain command that something is wrong;
 * folding it into `idle` would claim a reading nobody took.
 */
export const AGENT_STATUSES = [
  "working",
  "waiting",
  "idle",
  "error",
  "unknown",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * Why an Agent is owed a look, expressed as the status that earned it.
 *
 * Unread is a fact about the person, not about the Agent — which is why it is
 * not a sixth status — but it always has a reason, and the reason is always a
 * status the Agent went into while nobody was watching. Carrying that status
 * rather than a vocabulary of its own is what lets the unread dot be drawn in
 * the same colour as the status mark that caused it, without anything having
 * to translate between two lists that could drift apart.
 */
export type UnreadReason = AgentStatus;

/**
 * Whether stopping this Agent would interrupt anything.
 *
 * **One predicate, and this is it.** It decides whether `Cmd+Q X` on an Agent
 * asks "Stop this agent?" before stopping it, and it decides whether closing a
 * workspace asks about the Agents in it. A question whose answer is always yes
 * is what teaches people to dismiss the ones that matter, so an Agent sitting
 * at its prompt with nothing to lose is stopped without one.
 *
 * The reading is the reconciler's — the screen detectors' `AgentStatus` — and
 * only `idle` counts:
 *
 * - `working`: it is mid-task. Stopping it throws that away.
 * - `waiting`: it asked the person something and is holding for the answer.
 * - `error`: something is on its screen that says what went wrong, and the
 *   only copy of it is the screen.
 * - `unknown`: nobody has read this Agent — a profile with no detector, or one
 *   that has not been reconciled yet. Not knowing is not idle, and the
 *   question is the safe branch. See `AgentStatus`.
 */
export function agentIsIdle(status: AgentStatus): boolean {
  return status === "idle";
}
/**
 * Why an operation on one Agent was refused.
 *
 * A closed set, mirrored by `AgentFailureWire`, and deliberately separate from
 * the app-wide alert vocabulary: these are failures with a *subject*. They are
 * drawn where that subject is drawn — in the Agent's own pane and on its own
 * row — so the sentence sits next to the thing it is about, and the person is
 * not shown an application-wide banner about one pane.
 *
 * The tmux codes are distinct because reading them as one was the bug. Every
 * refusal of the Agent port used to arrive as "the agent runtime is
 * unavailable", which sent the reader to look at a tmux that was working
 * perfectly: a command that failed, a command that ran out of time and a
 * session somebody else already holds are three different things to do next.
 */
export const AGENT_FAILURE_CODES = [
  /** tmux itself cannot be reached — the binary, or the socket. */
  "agent_runtime_unavailable",
  /** tmux ran DevHub's command and refused it. */
  "tmux_command_failed",
  /** tmux did not answer DevHub's command inside its bound. */
  "tmux_command_timed_out",
  /** The session this Agent needs is not the session that is there. */
  "tmux_session_conflict",
  /** The profile this Agent would start from is not usable. */
  "agent_profile_unavailable",
  /** The Workspace this Agent belongs to is not open any more. */
  "workspace_unavailable",
] as const;
export type AgentFailureCode = (typeof AGENT_FAILURE_CODES)[number];

/**
 * The last refusal this Agent is still showing, and the tool's own words.
 *
 * `detail` is only ever something DevHub composed about its **own**
 * configuration, never provider output — the rule `PortFailure.detail` states
 * and the reason nothing here can leak a foreign tmux server's inventory.
 */
export interface AgentFailure {
  readonly code: AgentFailureCode;
  readonly detail?: string;
}

export const RUNTIME_HEALTHS = [
  "starting",
  "healthy",
  "degraded",
  "unavailable",
  "failed",
] as const;
export type RuntimeHealth = (typeof RUNTIME_HEALTHS)[number];

/**
 * Why a Workspace is unavailable, or cannot finish cleanup. These are the only
 * diagnostics the UI ever renders.
 */
export const DIAGNOSTIC_CODES = [
  "root_missing",
  "root_inaccessible",
  /**
   * Scratch while DevHub runs on no settings: there is no `[scratch] daily`,
   * so there is no folder. See `main/shell/scratchDay.ts`.
   */
  "settings_refused",
  "close_agents_unknown",
  "close_terminal_unknown",
  "close_editor_unknown",
  "close_editor_starting",
  "close_editor_unresponsive",
  "close_editor_vetoed",
  "cleanup_failed",
  "runtime_unavailable",
  /**
   * The workspace's workbench kept stopping, so DevHub stopped building it.
   *
   * A workspace diagnostic and not an app-wide notice, because the workbench
   * that gave up belongs to exactly one workspace: every other row still has
   * its editor, and saying "the native app shell is unavailable" about one
   * dead workbench was a false sentence on the one surface errors are read
   * from. It is terminal — only a person's Retry leaves it.
   */
  "editor_restart_exhausted",
  /** The workspace's workbench could not be started at all. */
  "editor_unavailable",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/**
 * The steps a close is made of, in the order they run.
 *
 * `editor` is the question — VS Code's own unsaved-work dialog, through its
 * `unload` — and it comes first because every question is resolved before the
 * first destructive step. The rest are destructive and idempotent: each treats
 * "already gone" as success, so the next attempt simply repeats them.
 *
 * A step names a failure: which one stopped, and that is all a failed close
 * has to remember, because there is nothing to resume.
 */
export const CLOSE_STEPS = [
  "editor",
  "agents",
  "terminal",
  "view",
  "worktree",
  "state",
] as const;
export type CloseStep = (typeof CLOSE_STEPS)[number];

/** Product-level control lifecycle, independent of status and health. */
export type AgentControlState =
  | { readonly kind: "running" }
  | { readonly kind: "stopping" }
  | { readonly kind: "stop-failed"; readonly diagnostic: DiagnosticCode };

export const RUNNING: AgentControlState = { kind: "running" };
export const STOPPING: AgentControlState = { kind: "stopping" };

export function isInteractive(state: AgentControlState): boolean {
  return state.kind === "running";
}
export function canRetryStop(state: AgentControlState): boolean {
  return state.kind === "stop-failed";
}

/** Provider-free observation used for one atomic Agent reconciliation. */
export interface AgentObservation {
  readonly agentId: AgentId;
  readonly status: AgentStatus;
  readonly runtimeHealth: RuntimeHealth;
  /**
   * What the Agent says it is doing, or nothing if it has not said.
   *
   * A reading, exactly like `status`: the round that took it carries it, and a
   * round that could not read the Agent's pane repeats the last one rather
   * than clearing it. `main/agent/activity.ts` decides what counts as having
   * said something.
   */
  readonly activity: string | undefined;
  /** What DevHub is holding for this Agent, and why it has not gone yet. */
  readonly injection: AgentInjection;
}

/**
 * Why text DevHub means to send an Agent has not been sent.
 *
 * Held here so a row can say it. A queue that waits without saying what it is
 * waiting for is indistinguishable from a queue that has forgotten, and the
 * reason is always known — see `main/agent/injection.ts` for the rule.
 */
export type AgentInjectionWait =
  | "nothing_queued"
  /**
   * Composed, but nobody has agreed to the wording yet.
   *
   * Not a property of the Agent's screen at all, which is why it leads this
   * list: however free the prompt is, DevHub is not entitled to type a sentence
   * the person has not looked at. See `main/agent/injection.ts`.
   */
  | "awaiting_review"
  /** The prompt is free; the queue is making sure it stays that way. */
  | "settling"
  | "agent_busy"
  /** Stopped on a question. That screen wants a keypress, never a sentence. */
  | "agent_asking"
  /** A screen no manifest describes, so no keystroke has a known meaning. */
  | "agent_unreadable";

/**
 * What became of the last thing DevHub meant to say to this Agent.
 *
 * One vocabulary for all four endings, so a row never has to work out which of
 * two fields to believe. `sent` is kept and not merely inferred from an empty
 * queue: "nothing is waiting" and "it went" are different sentences, and the
 * second is the one a person who just pressed a button is asking about.
 */
export type AgentInjectionResult =
  | { readonly kind: "sent" }
  /** The person closed the review sheet. The Agent keeps running. */
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };

export interface AgentInjection {
  readonly queued: number;
  readonly waitingFor: AgentInjectionWait;
  /** How the last one ended, until the next one ends differently. */
  readonly lastResult: AgentInjectionResult | undefined;
}

function sameResult(
  a: AgentInjectionResult | undefined,
  b: AgentInjectionResult | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind !== "failed" || a.reason === (b as { reason: string }).reason;
}

export const NO_INJECTION: AgentInjection = {
  queued: 0,
  waitingFor: "nothing_queued",
  lastResult: undefined,
};

/**
 * A complete provider reconciliation. Missing provider Agents are represented
 * by `exited`; both lists are applied atomically once every identity is known.
 */
export interface AgentReconciliation {
  readonly observations: readonly AgentObservation[];
  readonly exited: readonly AgentId[];
}

/** Validated, provider-free restoration record for an existing Agent. */
export interface AgentRestoreRecord {
  readonly id: AgentId;
  readonly workspaceId: WorkspaceId;
  readonly profile: AgentProfile;
  readonly ordinal: number;
  readonly temporaryName?: string;
  readonly status: AgentStatus;
  readonly runtimeHealth: RuntimeHealth;
  readonly controlState: AgentControlState;
  /** Why this Agent is unread, or nothing if it has been read. */
  readonly unread?: UnreadReason;
}

export function agentRestoreRecord(
  record: AgentRestoreRecord,
): AgentRestoreRecord {
  if (!Number.isInteger(record.ordinal) || record.ordinal === 0) {
    throw invalid(DomainErrorCode.InvalidOrdinal);
  }
  if (
    record.temporaryName !== undefined &&
    !validDisplayName(record.temporaryName)
  ) {
    throw invalid(DomainErrorCode.InvalidDisplayName);
  }
  return record;
}

/** Agent resource owned by exactly one Workspace. */
export class Agent {
  private nameOverride: string | undefined;
  /**
   * What this Agent last said it was doing.
   *
   * Deliberately not part of `AgentRestoreRecord`. It is a reading of a pane
   * that is being taken again 300ms from now, so a value restored from disk
   * would be a sentence the Agent said before DevHub last closed, shown as
   * though it had just said it. The row is wordless until the reconciler reads
   * one, which is the same thing `status` does with `unknown`.
   */
  private activityValue: string | undefined;
  private injectionValue: AgentInjection = NO_INJECTION;

  /**
   * The refusal this Agent's pane is still showing, or nothing.
   *
   * There is no dismiss, and there is deliberately no timer. It is retired by
   * the one event that makes it untrue — the next reconcile that actually read
   * this Agent — so a pane that says the runtime would not answer stops saying
   * it the moment the runtime answers, and goes on saying it until then. A
   * failure a person could dismiss while the condition held would be a failure
   * they could hide from themselves.
   */
  private failureValue: AgentFailure | undefined;

  private constructor(
    readonly id: AgentId,
    readonly workspaceId: WorkspaceId,
    readonly profile: AgentProfile,
    readonly ordinal: number,
    nameOverride: string | undefined,
    private statusValue: AgentStatus,
    private runtimeHealthValue: RuntimeHealth,
    private controlStateValue: AgentControlState,
    /**
     * The Agent wanted you and nobody has looked yet, and why.
     *
     * It is a fact about the *person*, not about the Agent, which is why it is
     * a field of its own rather than a fifth status: an Agent can be waiting and
     * read (you are looking at it now), or idle and unread (it finished, you
     * never came). Collapsing the two would lose the second, which is the one
     * worth a glow. The value is the reason — see `UnreadReason` — and
     * `undefined` is read.
     */
    private unreadValue: UnreadReason | undefined,
  ) {
    this.nameOverride = nameOverride;
  }

  static create(
    id: AgentId,
    owner: WorkspaceId,
    profile: AgentProfile,
    ordinal: number,
  ): Agent {
    return Agent.restore(
      agentRestoreRecord({
        id,
        workspaceId: owner,
        profile,
        ordinal,
        // Nothing has read this Agent's screen yet, and "idle" would be a
        // reading. The first reconcile replaces it.
        status: "unknown",
        runtimeHealth: "starting",
        controlState: RUNNING,
      }),
    );
  }

  static restore(record: AgentRestoreRecord): Agent {
    const validated = agentRestoreRecord(record);
    return new Agent(
      validated.id,
      validated.workspaceId,
      validated.profile,
      validated.ordinal,
      validated.temporaryName,
      validated.status,
      validated.runtimeHealth,
      validated.controlState,
      validated.unread,
    );
  }

  clone(): Agent {
    const copy = new Agent(
      this.id,
      this.workspaceId,
      this.profile,
      this.ordinal,
      this.nameOverride,
      this.statusValue,
      this.runtimeHealthValue,
      this.controlStateValue,
      this.unreadValue,
    );
    copy.activityValue = this.activityValue;
    copy.injectionValue = this.injectionValue;
    copy.failureValue = this.failureValue;
    return copy;
  }

  get displayName(): string {
    return (
      this.nameOverride ?? `${this.profile.displayName} ${String(this.ordinal)}`
    );
  }

  get temporaryName(): string | undefined {
    return this.nameOverride;
  }

  get status(): AgentStatus {
    return this.statusValue;
  }

  /** What the Agent says it is doing, in its own words, or nothing. */
  get activity(): string | undefined {
    return this.activityValue;
  }

  /** What DevHub is holding for this Agent, and why. */
  get injection(): AgentInjection {
    return this.injectionValue;
  }

  get runtimeHealth(): RuntimeHealth {
    return this.runtimeHealthValue;
  }

  /** The refusal this Agent is still showing, or nothing. */
  get failure(): AgentFailure | undefined {
    return this.failureValue;
  }

  /** An operation on this Agent was refused. Shown until a reconcile succeeds. */
  fail(failure: AgentFailure): boolean {
    if (
      this.failureValue?.code === failure.code &&
      this.failureValue.detail === failure.detail
    ) {
      return false;
    }
    this.failureValue = failure;
    return true;
  }

  /**
   * A reconcile read this Agent, so whatever it last refused is no longer news.
   *
   * The whole lifetime rule, in one place. Nothing else clears a failure,
   * because a rule applied at each raising site is a rule the next raising
   * site forgets.
   */
  clearFailure(): boolean {
    if (this.failureValue === undefined) return false;
    this.failureValue = undefined;
    return true;
  }

  get controlState(): AgentControlState {
    return this.controlStateValue;
  }

  get unread(): UnreadReason | undefined {
    return this.unreadValue;
  }

  setUnread(unread: UnreadReason | undefined): boolean {
    if (this.unreadValue === unread) return false;
    this.unreadValue = unread;
    return true;
  }

  get isInteractive(): boolean {
    return isInteractive(this.controlStateValue);
  }

  get canRetryStop(): boolean {
    return canRetryStop(this.controlStateValue);
  }

  rename(displayName: string): boolean {
    if (!validDisplayName(displayName)) {
      throw invalid(DomainErrorCode.InvalidDisplayName);
    }
    if (this.nameOverride === displayName) {
      return false;
    }
    this.nameOverride = displayName;
    return true;
  }

  resetName(): boolean {
    if (this.nameOverride === undefined) {
      return false;
    }
    this.nameOverride = undefined;
    return true;
  }

  setStatus(status: AgentStatus): boolean {
    if (this.statusValue === status) {
      return false;
    }
    this.statusValue = status;
    return true;
  }

  setInjection(injection: AgentInjection): boolean {
    const current = this.injectionValue;
    if (
      current.queued === injection.queued &&
      current.waitingFor === injection.waitingFor &&
      sameResult(current.lastResult, injection.lastResult)
    ) {
      return false;
    }
    this.injectionValue = injection;
    return true;
  }

  setActivity(activity: string | undefined): boolean {
    if (this.activityValue === activity) {
      return false;
    }
    this.activityValue = activity;
    return true;
  }

  setRuntimeHealth(health: RuntimeHealth): boolean {
    if (this.runtimeHealthValue === health) {
      return false;
    }
    this.runtimeHealthValue = health;
    return true;
  }

  requestStop(): boolean {
    if (this.controlStateValue.kind === "stopping") {
      return false;
    }
    this.controlStateValue = STOPPING;
    return true;
  }

  markStopFailed(diagnostic: DiagnosticCode): boolean {
    if (this.controlStateValue.kind === "running") {
      throw invalid(DomainErrorCode.InvalidAgentControlTransition);
    }
    if (
      this.controlStateValue.kind === "stop-failed" &&
      this.controlStateValue.diagnostic === diagnostic
    ) {
      return false;
    }
    this.controlStateValue = { kind: "stop-failed", diagnostic };
    return true;
  }

  returnToRunning(): boolean {
    if (this.controlStateValue.kind === "running") {
      return false;
    }
    this.controlStateValue = RUNNING;
    return true;
  }
}

/**
 * What this Workspace's close has to say — the one it is running, or the last
 * one that stopped.
 *
 * Never persisted, and deliberately not a progress record. A close is a fixed
 * sequence of idempotent steps run in one go (`Coordinator.closeWorkspace`);
 * there is no midpoint worth writing down, because repeating a step that
 * already ran finds it already done. What survives a failure is *what to say*:
 * which step stopped, and why.
 */
export type WorkspaceClose =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | {
      readonly kind: "failed";
      readonly step: CloseStep;
      readonly diagnostic: DiagnosticCode;
      /**
       * What the tool that refused actually said — git's last line, an errno.
       *
       * The diagnostic is a closed set, so it can only ever say which *kind*
       * of thing went wrong; "A cleanup step did not finish" is true of every
       * `git worktree remove` failure there is. The one sentence that tells a
       * person what to do next is the one git wrote, so it travels instead of
       * being replaced by a category. Nothing is invented here: this is only
       * ever the tool's own words, never a sentence DevHub composed at the
       * raising site.
       */
      readonly detail?: string;
    };

export const CLOSE_IDLE: WorkspaceClose = { kind: "idle" };

function sameClose(left: WorkspaceClose, right: WorkspaceClose): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "failed" && right.kind === "failed") {
    return (
      left.step === right.step &&
      left.diagnostic === right.diagnostic &&
      left.detail === right.detail
    );
  }
  return true;
}

/**
 * Workspace availability: whether its folder is there.
 *
 * It does not say anything about a close. It used to carry `closing` and
 * `closing-failed` too, so a workspace whose root vanished mid-close had one
 * fact overwrite the other, and a state file could name a close no launch was
 * running any more. The close lives beside this, in `Workspace.close`.
 */
export type WorkspaceState =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: DiagnosticCode };

export const AVAILABLE: WorkspaceState = { kind: "available" };

export function isWorkspaceAvailable(state: WorkspaceState): boolean {
  return state.kind === "available";
}

/**
 * Why today's Scratch has no folder: it could not be made, or there is no
 * `[scratch] daily` to make it from because DevHub runs on no settings.
 */
export type ScratchUnavailable = Extract<
  DiagnosticCode,
  "root_inaccessible" | "settings_refused"
>;

/**
 * Whether a Workspace that stops being Scratch has anything to come back to.
 *
 * Yesterday's Scratch stays as an ordinary row because it holds work: its
 * Agents, or a folder with a workbench on it. One that is unavailable and has
 * no Agents holds neither — the stand-in DevHub puts in Scratch's place while
 * it runs on no settings is one, and so is a day whose folder could not be
 * made — and it does not outlive being Scratch: not as a row when the next
 * Scratch is adopted, and not in the state file, since the next launch works
 * Scratch out again anyway. Structural, so the live model and the snapshot the
 * state file is written from ask the one question.
 */
export function scratchHoldsNothing(workspace: {
  readonly state: WorkspaceState;
  readonly agents: readonly unknown[];
}): boolean {
  return (
    !isWorkspaceAvailable(workspace.state) && workspace.agents.length === 0
  );
}

function sameWorkspaceState(
  left: WorkspaceState,
  right: WorkspaceState,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "unavailable" && right.kind === "unavailable") {
    return left.reason === right.reason;
  }
  return true;
}

/**
 * A Workspace is an open context rooted at one canonical folder. Repository
 * identity is optional and never replaces Workspace identity.
 *
 * It does not know which Issue it is about, and deliberately no longer does.
 * DevHub used to write that down when the person assigned an Issue, on the
 * reasoning that a record is the only thing that stays true — but the thing it
 * has to stay true *about* is what is checked out right now, and a record
 * cannot follow a checkout. A workspace assigned Issue 128 and then switched to
 * `master` went on claiming 128, which is the wrong answer at the moment
 * somebody most needs the right one. The branch is the fact; see
 * `issueNumberFromBranch`, which is now the only way a workspace is linked to
 * an Issue.
 */
export class Workspace {
  private readonly agentList: Agent[] = [];

  constructor(
    readonly id: WorkspaceId,
    private locationValue: WorkspaceLocation,
    private selectedPathValue: DisplayPath,
    private repositoryIdValue: RepositoryId | undefined = undefined,
    private stateValue: WorkspaceState = AVAILABLE,
  ) {}

  /** See `WorkspaceClose`. In memory only; a launch starts every close idle. */
  private closeValue: WorkspaceClose = CLOSE_IDLE;

  clone(): Workspace {
    const copy = new Workspace(
      this.id,
      this.locationValue,
      this.selectedPathValue,
      this.repositoryIdValue,
      this.stateValue,
    );
    copy.closeValue = this.closeValue;
    for (const agent of this.agentList) {
      copy.agentList.push(agent.clone());
    }
    return copy;
  }

  get location(): WorkspaceLocation {
    return this.locationValue;
  }

  /**
   * The folder's path, wherever the folder is.
   *
   * Still here, and still the path and nothing else, because every reader that
   * wants a *name* wants this: the label, the tooltip, the basename, the
   * disambiguation. What used to also use it — "is this the same Workspace" —
   * asks `key` now, which is the only question a path stopped being able to
   * answer once a folder could be on another machine.
   */
  get root(): WorkspaceRoot {
    return this.locationValue.path;
  }

  /** What makes this Workspace this one. See `locationKey`. */
  get key(): string {
    return locationKey(this.locationValue);
  }

  get selectedPath(): DisplayPath {
    return this.selectedPathValue;
  }

  get repositoryId(): RepositoryId | undefined {
    return this.repositoryIdValue;
  }

  get state(): WorkspaceState {
    return this.stateValue;
  }

  get close(): WorkspaceClose {
    return this.closeValue;
  }

  get agents(): readonly Agent[] {
    return this.agentList;
  }

  /**
   * An Agent is a process, and a process runs where the folder is.
   *
   * Which machine that is is no longer one of the terms. It used to be: an
   * Agent needed tmux and a PTY, and both of those were this Mac. They are the
   * Workspace's `Runtime` now (`main/runtime/`), so a Workspace on a host DevHub
   * can reach runs its Agents there, and a host it cannot reach reports *that*,
   * as a failure naming the host, rather than as a button that was never
   * offered. The two terms left are about the Workspace itself: whether it is
   * available, and whether it is on its way out.
   */
  get canCreateAgent(): boolean {
    return (
      isWorkspaceAvailable(this.stateValue) &&
      this.closeValue.kind !== "running"
    );
  }

  setRepositoryId(next: RepositoryId | undefined): boolean {
    if (this.repositoryIdValue === next) {
      return false;
    }
    this.repositoryIdValue = next;
    return true;
  }

  /**
   * Rebind an unavailable Workspace to a newly located canonical root while
   * preserving its WorkspaceId and its live Agents.
   */
  relocate(location: WorkspaceLocation, selectedPath: DisplayPath): void {
    this.locationValue = location;
    this.selectedPathValue = selectedPath;
    this.stateValue = AVAILABLE;
  }

  markUnavailable(reason: DiagnosticCode): boolean {
    const next: WorkspaceState = { kind: "unavailable", reason };
    if (sameWorkspaceState(this.stateValue, next)) {
      return false;
    }
    this.stateValue = next;
    return true;
  }

  markAvailable(): boolean {
    if (this.stateValue.kind === "available") {
      return false;
    }
    this.stateValue = AVAILABLE;
    return true;
  }

  /**
   * A close is starting. Whatever the last one said is no longer the news.
   *
   * A Workspace whose folder is gone can still be closed — closing is exactly
   * what a person does with a folder that is not coming back, and every step
   * of the close treats "already gone" as success.
   */
  beginClose(): boolean {
    if (this.closeValue.kind === "running") {
      throw invalid(DomainErrorCode.WorkspaceClosing);
    }
    return this.setClose({ kind: "running" });
  }

  /** A close stopped at this step, for this reason. Final for that attempt. */
  closeFailed(
    step: CloseStep,
    diagnostic: DiagnosticCode,
    detail?: string,
  ): boolean {
    return this.setClose({
      kind: "failed",
      step,
      diagnostic,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  private setClose(next: WorkspaceClose): boolean {
    if (sameClose(this.closeValue, next)) return false;
    this.closeValue = next;
    return true;
  }

  agent(id: AgentId): Agent | undefined {
    return this.agentList.find((candidate) => candidate.id === id);
  }

  addAgent(agent: Agent): void {
    if (!this.canCreateAgent) {
      throw invalid(DomainErrorCode.WorkspaceUnavailable);
    }
    this.restoreAgent(agent);
  }

  restoreAgent(agent: Agent): void {
    if (agent.workspaceId !== this.id) {
      throw invalid(DomainErrorCode.AgentWorkspaceMismatch);
    }
    if (this.agent(agent.id)) {
      throw invalid(DomainErrorCode.DuplicateAgent);
    }
    this.agentList.push(agent);
  }

  removeAgent(id: AgentId): Agent | undefined {
    const index = this.agentList.findIndex((agent) => agent.id === id);
    return index < 0 ? undefined : this.agentList.splice(index, 1)[0];
  }

  /**
   * Put the Agents in the order a person arranged them.
   *
   * The list *is* the order — it is what the sidebar draws, what the Agent
   * cycles step, and what the state file writes out — so arranging Agents is
   * this and nothing else. There is no separate order to keep in step with the
   * list, and therefore no way for the two to disagree.
   *
   * The order given has to name exactly the Agents this workspace has. A
   * caller that computed it from a stale snapshot is a caller working from a
   * list that no longer exists, and quietly rearranging whatever overlaps
   * would put Agents somewhere nobody asked for.
   */
  reorderAgents(order: readonly AgentId[]): void {
    if (order.length !== this.agentList.length) {
      throw invalid(DomainErrorCode.UnknownAgent);
    }
    const moved: Agent[] = [];
    for (const id of order) {
      const agent = this.agent(id);
      if (!agent || moved.includes(agent)) {
        throw invalid(DomainErrorCode.UnknownAgent);
      }
      moved.push(agent);
    }
    this.agentList.length = 0;
    this.agentList.push(...moved);
  }
}

/**
 * The left-pane Navigation Context, and the whole of the selection.
 *
 * Scratch is not a kind of its own. It is a Workspace — today's daily folder —
 * and selecting it is selecting that Workspace; `AppModel.scratchWorkspaceId`
 * says which one it is.
 */
export type NavigationContext =
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "agent"; readonly agentId: AgentId };

export function sameContext(
  left: NavigationContext,
  right: NavigationContext,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "workspace" && right.kind === "workspace") {
    return left.workspaceId === right.workspaceId;
  }
  if (left.kind === "agent" && right.kind === "agent") {
    return left.agentId === right.agentId;
  }
  return false;
}

/**
 * Semantic DevHub surface identity. Provider and editor identifiers do not
 * cross this seam.
 *
 * There are two kinds, and there used to be five. A terminal is no longer a
 * DevHub Surface — it is the workbench's integrated terminal, on the same tmux
 * session it always was — so `workspace-terminal` names nothing the shell page
 * can put on screen. The tmux runtime still owns those sessions and still
 * spells their keys that way on the wire it shares with the Agents; what is
 * gone is the idea that a person could *select* one. Scratch's editor was the
 * third, `global-editor`, until Scratch became a Workspace with a workbench
 * like any other.
 */
export type SurfaceKey =
  | { readonly kind: "workspace-editor"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "agent"; readonly agentId: AgentId };

export function surfaceKeyName(key: SurfaceKey): string {
  switch (key.kind) {
    case "workspace-editor":
      return `workspace-editor:${key.workspaceId}`;
    case "agent":
      return `agent:${key.agentId}`;
  }
}

/**
 * What the content area holds for the selected context.
 *
 * This is what the Activity ring became, and it is smaller than one on
 * purpose. A context no longer offers a choice of things to look at: a
 * Workspace *is* its workbench, full width, and an Agent is that same workbench
 * with the Agent's pane beside it. Nothing chooses, so nothing can be disabled,
 * and there is no state in which the selection and what is on screen disagree.
 *
 * `unavailable` carries no reason. The Workspace's own state is the reason and
 * is already in the snapshot beside this; a second copy would be a second
 * answer to "why can I not see it".
 */
export type SurfaceLayout =
  | { readonly kind: "workbench"; readonly editor: SurfaceKey }
  | { readonly kind: "agent"; readonly agent: SurfaceKey }
  | {
      readonly kind: "split";
      readonly editor: SurfaceKey;
      readonly agent: SurfaceKey;
    }
  | { readonly kind: "unavailable" };

/**
 * How much of the content area the thing you selected takes.
 *
 * Selecting an Agent used to mean one arrangement — the workbench, with the
 * Agent's pane beside it — so the layout could be read off the context alone.
 * It cannot any more: the same Agent is either the whole content area or half
 * of it, and which one is what the person asked for when they selected it.
 * Plain click, Return: `full`. Command-click, Command-Return: `beside`.
 *
 * It is a property of the *selection*, not of the Agent. Opening an Agent
 * beside the workbench and later opening the same Agent on its own are two
 * selections of one Agent, so nothing about the Agent itself changes and
 * nothing has to be stored on it or remembered between launches.
 *
 * A split has two halves, and either can be the one in front, so a Workspace
 * carries this too: `beside` on a Workspace is the same two panes as `beside`
 * on its Agent, with the keyboard in the editor rather than in the Agent. That
 * is how "which half of the split am I in" is written down — as what is
 * selected, not as a second notion of focus.
 *
 * A Workspace with no Agents has no other half, so `full` is the only
 * presentation it is ever recorded with — which
 * `AppModel.selectContext` enforces rather than leaving a second value lying
 * around that nothing reads.
 */
export type SurfacePresentation = "full" | "beside";

/** One input to the consolidated Workspace close inspection. */
export type ResourceInspection =
  | { readonly kind: "clean" }
  | { readonly kind: "busy"; readonly count: number }
  | {
      readonly kind: "unknown";
      readonly diagnostic: DiagnosticCode;
      /**
       * The one sentence that says *why*, when the diagnostic's stock words
       * leave the reader nowhere to go.
       *
       * A Workspace on another machine made this necessary. "Could not verify
       * terminal state", said three times about one unreachable host, names
       * neither the host nor the reason, and the person reading it cannot tell
       * a tmux that refused a command from a machine that is simply not there.
       * The diagnostic stays the category; this is the fact.
       */
      readonly reason?: string;
    };

export const CLEAN: ResourceInspection = { kind: "clean" };

export function busy(count: number): ResourceInspection {
  if (count === 0) {
    throw invalid(DomainErrorCode.InvalidBusyCount);
  }
  return { kind: "busy", count };
}

/**
 * What the Agents in a Workspace amount to, for a close.
 *
 * Only the ones stopping would interrupt are counted — `agentIsIdle` says
 * which, and it is the same predicate `Cmd+Q X` on a single Agent reads, so a
 * workspace full of idle Agents closes with no question and stops them on the
 * way out. Counting every Agent is what made "close this workspace" ask about
 * three Agents that were all sitting at a prompt.
 */
export function agentsInspection(
  statuses: readonly AgentStatus[],
): ResourceInspection {
  const busyCount = statuses.filter((status) => !agentIsIdle(status)).length;
  return busyCount === 0 ? CLEAN : busy(busyCount);
}

export function unknownResource(
  diagnostic: DiagnosticCode,
  reason?: string,
): ResourceInspection {
  return reason === undefined || reason.length === 0
    ? { kind: "unknown", diagnostic }
    : { kind: "unknown", diagnostic, reason };
}

/**
 * What a Workspace's workbench holds that a close would throw away.
 *
 * Its own type rather than a `ResourceInspection`, because the confirmation
 * says *which* — the tabs by name — and a count is not that. `unsaved` is
 * never empty: a workbench with nothing modified is `clean`. `unknown` is a
 * workbench whose answer could not be had, and is asked about, never read as
 * clean.
 */
export type UnsavedEditorsInspection =
  | { readonly kind: "clean" }
  | { readonly kind: "unsaved"; readonly tabs: readonly string[] }
  | {
      readonly kind: "unknown";
      readonly diagnostic: DiagnosticCode;
      readonly reason?: string;
    };

export function unsavedEditors(
  tabs: readonly string[],
): UnsavedEditorsInspection {
  return tabs.length === 0 ? { kind: "clean" } : { kind: "unsaved", tabs };
}

/**
 * The unsaved editors as one more resource the close counts, so that
 * consolidating them is the same rule as every other resource.
 */
function unsavedEditorsResource(
  inspection: UnsavedEditorsInspection,
): ResourceInspection {
  return inspection.kind === "unsaved"
    ? busy(inspection.tabs.length)
    : inspection;
}

/** Resource counts collected before a Workspace close confirmation. */
export interface CloseInspectionInputs {
  readonly agents: ResourceInspection;
  readonly terminalProcesses: ResourceInspection;
  readonly terminalPanes: ResourceInspection;
  readonly terminalWindows: ResourceInspection;
  readonly unsavedEditors: UnsavedEditorsInspection;
}

export const CLEAN_INSPECTION: CloseInspectionInputs = {
  agents: CLEAN,
  terminalProcesses: CLEAN,
  terminalPanes: CLEAN,
  terminalWindows: CLEAN,
  unsavedEditors: CLEAN,
};

/** Counted reasons shown in one destructive Workspace confirmation. */
export interface BusyReasons {
  readonly agents: number;
  readonly terminalProcesses: number;
  readonly terminalPanes: number;
  readonly terminalWindows: number;
  readonly unsavedEditors: number;
}

/** The only three consolidated close outcomes. */
export type CloseInspection =
  | { readonly kind: "clean" }
  | {
      readonly kind: "requires-confirmation";
      readonly reasons: BusyReasons;
      readonly unknownDiagnostics: readonly DiagnosticCode[];
    };

export const CLEAN_CLOSE_INSPECTION: CloseInspection = { kind: "clean" };

const INSPECTION_FIELDS = [
  "agents",
  "terminalProcesses",
  "terminalPanes",
  "terminalWindows",
  "unsavedEditors",
] as const;

export function consolidateCloseInspection(
  inputs: CloseInspectionInputs,
): CloseInspection {
  const resources: Record<
    (typeof INSPECTION_FIELDS)[number],
    ResourceInspection
  > = {
    ...inputs,
    unsavedEditors: unsavedEditorsResource(inputs.unsavedEditors),
  };
  const unknownDiagnostics: DiagnosticCode[] = [];
  for (const field of INSPECTION_FIELDS) {
    const check = resources[field];
    if (
      check.kind === "unknown" &&
      !unknownDiagnostics.includes(check.diagnostic)
    ) {
      unknownDiagnostics.push(check.diagnostic);
    }
  }
  const reasons: Record<(typeof INSPECTION_FIELDS)[number], number> = {
    agents: 0,
    terminalProcesses: 0,
    terminalPanes: 0,
    terminalWindows: 0,
    unsavedEditors: 0,
  };
  let anyBusy = false;
  for (const field of INSPECTION_FIELDS) {
    const check = resources[field];
    if (check.kind === "busy") {
      reasons[field] = check.count;
      anyBusy = true;
    }
  }
  if (!anyBusy && unknownDiagnostics.length === 0) {
    return CLEAN_CLOSE_INSPECTION;
  }
  return { kind: "requires-confirmation", reasons, unknownDiagnostics };
}

/**
 * The content-free projection the close confirmation renders. The UI shows
 * these states but never recomputes them.
 */
export interface CloseInspectionProjection extends CloseInspectionInputs {
  readonly workspaceId: WorkspaceId;
  readonly workspaceLabel: string;
}

export function closeInspectionProjection(
  workspace: WorkspaceId,
  workspaceLabel: string,
  inputs: CloseInspectionInputs,
): CloseInspectionProjection {
  return { workspaceId: workspace, workspaceLabel, ...inputs };
}
