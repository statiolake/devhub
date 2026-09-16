/**
 * Resolving `ssh-remote+<host>` by asking DevHub.
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

const AUTHORITY_PREFIX = "ssh-remote+";

/**
 * `ssh-remote+<host>` into the machine DevHub spells, or `null` when the
 * authority is not one this resolver was registered for. The host is taken
 * whole — it is an ssh host alias as DevHub spells it, not something to be
 * parsed further here.
 */
export function machineFromAuthority(authority: string): string | null {
  if (!authority.startsWith(AUTHORITY_PREFIX)) return null;
  const host = authority.slice(AUTHORITY_PREFIX.length);
  if (host.length === 0) return null;
  return `ssh:${host}`;
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
