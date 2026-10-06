/**
 * Ports in a dev container, forwarded to this Mac.
 *
 * VS Code already knows how to notice a process listening in the remote
 * (`remote.autoForwardPortsSource: "process"`), list it in the Ports view and
 * offer "Open in Browser". What it needs from a resolver is a way to make the
 * forward — `RemoteAuthorityResolver.tunnelFactory` — and without one it keeps
 * the whole Ports feature switched off for the window. This is that factory,
 * and like the resolver it decides nothing itself: DevHub opens the listener
 * here and relays each connection into the container (see
 * `apps/desktop/src/main/runtime/portForward.ts`); the extension carries the
 * question there and the answer back.
 *
 * **A forward is a held connection.** The `forward-port` request's socket stays
 * open for as long as the forward does: disposing the tunnel closes it, and an
 * extension host that goes away — the window closed, or crashed — closes it
 * too, which is how DevHub knows to stop listening. Nothing has to remember to
 * clean up.
 *
 * Also here: the definition's `forwardPorts` / `appPort`, opened when the
 * window starts, and its `portsAttributes`, read for each port VS Code is
 * about to forward on its own.
 */

import { connect, type Socket } from "node:net";

/** `vscode.TunnelOptions`, as far as the factory reads it. */
export interface TunnelRequest {
  remoteAddress: { host: string; port: number };
  localAddressPort?: number;
  label?: string;
  protocol?: string;
  privacy?: string;
}

/** `vscode.Tunnel`, as this file builds it. */
export interface ForwardedTunnel {
  remoteAddress: { host: string; port: number };
  localAddress: { host: string; port: number };
  protocol?: string;
  privacy?: string;
  onDidDispose: unknown;
  dispose(): void;
}

/** The part of `vscode` the factory needs. */
export interface TunnelApi {
  /** A `vscode.EventEmitter<void>`'s `event` and `fire`. */
  emitter(): { event: unknown; fire(): void; dispose(): void };
}

/** A forward DevHub holds open for as long as `socket` is. */
export interface HeldForward {
  localPort: number;
  /** Closing it ends the forward. */
  close(): void;
  /** Called once when DevHub ends the forward (or the socket breaks). */
  onClosed(listener: () => void): void;
}

/** Ask DevHub for a forward, keeping the connection that holds it. */
export function requestForwardPort(
  socketPath: string,
  machine: string,
  host: string,
  port: number,
  localPort: number | undefined,
  requireLocalPort: boolean,
  connectTo: (path: string) => Socket = connect,
): Promise<HeldForward> {
  return new Promise<HeldForward>((resolve, reject) => {
    const socket = connectTo(socketPath);
    let buffer = "";
    let answered = false;
    const listeners: (() => void)[] = [];
    let closed = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          kind: "forward-port",
          machine,
          host,
          port,
          ...(localPort === undefined ? {} : { localPort }),
          ...(requireLocalPort ? { requireLocalPort } : {}),
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      if (answered) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      answered = true;
      let answer: {
        ok?: boolean;
        message?: string;
        forward?: { localPort?: unknown };
      };
      try {
        answer = JSON.parse(buffer.slice(0, newline)) as typeof answer;
      } catch (failure) {
        socket.destroy();
        reject(failure instanceof Error ? failure : new Error(String(failure)));
        return;
      }
      const local = answer.forward?.localPort;
      if (answer.ok !== true || typeof local !== "number") {
        socket.destroy();
        reject(new Error(answer.message ?? "DevHub did not forward the port."));
        return;
      }
      resolve({
        localPort: local,
        close: () => socket.destroy(),
        onClosed: (listener) => {
          if (closed) listener();
          else listeners.push(listener);
        },
      });
    });
    socket.on("error", (failure) => {
      if (!answered) {
        answered = true;
        reject(failure);
      }
    });
    socket.on("close", () => {
      closed = true;
      if (!answered) {
        answered = true;
        reject(new Error("DevHub closed the connection without answering."));
      }
      for (const listener of listeners.splice(0)) listener();
    });
  });
}

/** Ask DevHub for a forward, as `requestForwardPort` does. */
export type ForwardPort = (
  host: string,
  port: number,
  localPort: number | undefined,
  requireLocalPort: boolean,
) => Promise<HeldForward>;

/**
 * The resolver's `tunnelFactory`: a `vscode.Tunnel` for each forward DevHub
 * makes.
 *
 * `localAddress` is `{ host, port }` rather than a string because that is what
 * turns on the Ports view's "Change Local Port". The host is `localhost`:
 * DevHub listens on both loopbacks, so whichever one a browser picks reaches
 * the forward, and it is the address a dev server's own redirect URLs expect.
 */
export function makeTunnelFactory(
  api: TunnelApi,
  forward: ForwardPort,
  requiresLocalPort: (port: number) => boolean = () => false,
): (options: TunnelRequest) => Promise<ForwardedTunnel> {
  return async (options) => {
    const { host, port } = options.remoteAddress;
    const held = await forward(
      host,
      port,
      options.localAddressPort,
      requiresLocalPort(port),
    );
    const disposed = api.emitter();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      disposed.fire();
      disposed.dispose();
    };
    held.onClosed(finish);
    return {
      remoteAddress: { host, port },
      localAddress: { host: "localhost", port: held.localPort },
      ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
      ...(options.privacy === undefined ? {} : { privacy: options.privacy }),
      onDidDispose: disposed.event,
      dispose: () => {
        held.close();
        finish();
      },
    };
  };
}

/** What DevHub read out of the definition. Mirrors `PortsConfiguration`. */
export interface PortsConfiguration {
  forwardPorts: { host: string; port: number }[];
  portsAttributes: Record<string, unknown>;
  otherPortsAttributes?: Record<string, unknown>;
}

/** The attributes the definition gives one port, if any. */
export function attributesFor(
  config: PortsConfiguration,
  port: number,
  commandLine?: string,
): Record<string, unknown> | undefined {
  for (const [key, value] of Object.entries(config.portsAttributes)) {
    if (typeof value !== "object" || value === null) continue;
    const attributes = value as Record<string, unknown>;
    const single = /^\s*(\d+)\s*$/u.exec(key);
    if (single !== null) {
      if (Number(single[1]) === port) return attributes;
      continue;
    }
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/u.exec(key);
    if (range !== null) {
      if (port >= Number(range[1]) && port <= Number(range[2])) {
        return attributes;
      }
      continue;
    }
    // Anything else is a pattern for the listening process's command line,
    // as in VS Code's own `remote.portsAttributes`.
    if (commandLine === undefined) continue;
    try {
      if (new RegExp(key, "u").test(commandLine)) return attributes;
    } catch {
      // Not a pattern either: nothing it could match.
    }
  }
  return config.otherPortsAttributes;
}

/**
 * `onAutoForward` as `vscode.PortAutoForwardAction`'s numbers: notify 1,
 * openBrowser 2, openPreview 3, silent 4, ignore 5.
 */
export function autoForwardAction(
  attributes: Record<string, unknown> | undefined,
): number | undefined {
  switch (attributes?.["onAutoForward"]) {
    case "notify":
      return 1;
    case "openBrowser":
    case "openBrowserOnce":
      return 2;
    case "openPreview":
      return 3;
    case "silent":
      return 4;
    case "ignore":
      return 5;
    default:
      return undefined;
  }
}

/** `label` from a port's attributes, when it has one. */
export function labelFor(
  config: PortsConfiguration,
  port: number,
): string | undefined {
  const label = attributesFor(config, port)?.["label"];
  return typeof label === "string" && label.length > 0 ? label : undefined;
}

/** `requireLocalPort` from a port's attributes. */
export function requiresLocalPort(
  config: PortsConfiguration | undefined,
  port: number,
): boolean {
  if (config === undefined) return false;
  return attributesFor(config, port)?.["requireLocalPort"] === true;
}
