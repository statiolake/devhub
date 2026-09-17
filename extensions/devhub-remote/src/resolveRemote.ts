/**
 * Resolving `ssh-remote+<host>` and `dev-container+<hex>` by asking DevHub.
 *
 * This is the whole extension. It opens no SSH connection, reads no ssh
 * client configuration, publishes no server and forwards no port: DevHub already
 * owns every one of those, and a second answer to a question that has one is
 * how the two answers start to disagree. What is left here is a translation —
 * an authority into the machine DevHub spells, and DevHub's sentence into the
 * error VS Code understands.
 *
 * The vocabulary is DevHub's as well. Every message a person sees is the
 * sentence main sent, verbatim; the one sentence this file writes itself is
 * for the case where main said nothing because it could not be reached.
 *
 * The VS Code API arrives as {@link ResolverApi} rather than by importing
 * `vscode`: the real module exists only inside an extension host, and the
 * resolver's decisions — which error, with which message — are exactly what the
 * tests are for.
 */

import type { ResolveRemoteAnswer } from "./control";

/** The `vscode` surface the resolver needs, and nothing else. */
export interface ResolverApi {
  /** `new vscode.ResolvedAuthority(host, port, connectionToken)`. */
  resolved(host: string, port: number, connectionToken: string): object;
  /** `vscode.RemoteAuthorityResolverError.NotAvailable(message)`. */
  notAvailable(message: string): Error;
  /** `vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(message)`. */
  temporarilyNotAvailable(message: string): Error;
}

/** Asks the running DevHub; rejects when DevHub cannot be reached at all. */
export type AskDevHub = (
  socketPath: string,
  machine: string,
  attempt: number,
) => Promise<ResolveRemoteAnswer>;

export const SSH_PREFIX = "ssh-remote+";
export const CONTAINER_PREFIX = "dev-container+";

/**
 * The hex payload of a `dev-container+` authority, back into the host folder.
 *
 * DevHub wrote it (`encodeContainerAuthority` in `model/domain.ts`), so this is
 * one half of a round trip and not a guess at somebody else's format — the
 * closed Dev Containers extension's payload is not exchanged with and not
 * read. It stays a copy rather than an import for the reason the whole of
 * `control.ts` is a copy: an extension is bundled on its own and cannot import
 * from `apps/desktop`.
 */
function hostFolderFromPayload(payload: string): string | null {
  if (payload.length === 0 || payload.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(payload)) return null;
  const bytes = new Uint8Array(payload.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(payload.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return null;
    const hostPath = (parsed as { hostPath?: unknown }).hostPath;
    return typeof hostPath === "string" && hostPath.length > 0
      ? hostPath
      : null;
  } catch {
    return null;
  }
}

/**
 * An authority into the machine DevHub spells, or `null` when it is not one
 * this resolver was registered for.
 *
 * Two prefixes and one answer shape, which is the point of the whole design:
 * main produces a local TCP port that speaks the remote extension host's
 * protocol, whichever transport got it there, and this extension returns a
 * `ResolvedAuthority` pointing at it. Adding dev containers added a prefix
 * here and a runtime in main, and nothing in between.
 *
 * The ssh host is taken whole — it is an alias as DevHub spells it, not
 * something to parse further. The container's payload is decoded because it is
 * hex that DevHub itself wrote, and what comes out is the folder on this Mac,
 * which is what `container:` machine ids are keyed on.
 */
export function machineFromAuthority(authority: string): string | null {
  if (authority.startsWith(SSH_PREFIX)) {
    const host = authority.slice(SSH_PREFIX.length);
    return host.length === 0 ? null : `ssh:${host}`;
  }
  if (authority.startsWith(CONTAINER_PREFIX)) {
    const folder = hostFolderFromPayload(
      authority.slice(CONTAINER_PREFIX.length),
    );
    return folder === null ? null : `container:${folder}`;
  }
  return null;
}

function endpointOf(answer: ResolveRemoteAnswer): {
  port: number;
  connectionToken: string;
  extensionHostEnv?: Record<string, string | null>;
} | null {
  const remote = answer.remote;
  if (!remote || typeof remote !== "object") return null;
  if (typeof remote.port !== "number" || !Number.isFinite(remote.port)) {
    return null;
  }
  if (typeof remote.connectionToken !== "string") return null;
  return remote;
}

export async function resolveRemote(
  api: ResolverApi,
  ask: AskDevHub,
  socketPath: string | null,
  authority: string,
  attempt: number,
): Promise<object> {
  const machine = machineFromAuthority(authority);
  if (!machine) {
    throw api.notAvailable(
      `"${authority}" is not a remote DevHub knows how to open.`,
    );
  }
  if (!socketPath) {
    throw api.notAvailable(
      "This workbench is not running inside DevHub, so there is no DevHub to ask for a remote.",
    );
  }

  let answer: ResolveRemoteAnswer;
  try {
    answer = await ask(socketPath, machine, attempt);
  } catch {
    // Not reaching the socket is not the same as being refused: DevHub may
    // still be starting, and both of VS Code's retry loops will come back.
    throw api.temporarilyNotAvailable("DevHub is not answering yet. Retrying.");
  }

  if (!answer.ok) {
    const message = answer.message;
    // `handled` stays off: DevHub has shown no alert of its own for these, so
    // this error is the only place the sentence appears.
    throw answer.retry === true
      ? api.temporarilyNotAvailable(message)
      : api.notAvailable(message);
  }

  const endpoint = endpointOf(answer);
  if (!endpoint) {
    throw api.notAvailable(
      `DevHub answered without an endpoint for "${machine}": ${answer.message}`,
    );
  }

  const resolved = api.resolved(
    "127.0.0.1",
    endpoint.port,
    endpoint.connectionToken,
  );
  // `ResolverResult` is the authority instance with the optional fields set on
  // it. `extensionHostEnv` is where `SSH_AUTH_SOCK` arrives when the host has
  // an agent forwarded; this extension does not decide it, it carries it.
  if (endpoint.extensionHostEnv) {
    Object.assign(resolved, { extensionHostEnv: endpoint.extensionHostEnv });
  }
  return resolved;
}
