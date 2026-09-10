/**
 * Everything that can go wrong in the Bridge, as one value.
 *
 * There were nine ways for the transport to fail and seven for the
 * configuration to be refused, and all sixteen ended the same way: a nullary
 * `onError()` or a `console.log` line, in a packaged app where nobody is
 * looking at a console. The presentation was "the editor integration just does
 * not work", with the reason computed and thrown away. This extension is the
 * part that breaks whenever VS Code moves, so it is the part where an
 * invisible failure costs the most.
 *
 * So every failure site produces a `BridgeFault` instead. One union, one
 * `describe`, one place that decides what a person is told — which is what
 * stops the next failure mode from being added as another silent branch.
 *
 * **Diagnostics stay content-free.** A fault carries enumerated reasons,
 * counts and byte sizes; never an endpoint, a bearer token, a workspace path,
 * editor text, or a query value. That was the old `log()`'s intent, but it
 * enforced it by filtering field *names* against a fixed allowlist, which
 * silently dropped any diagnostic a later caller added — a trap for exactly
 * the person trying to make this visible. A closed union enforces the same
 * rule by construction, and adding a field that should not be there is now a
 * thing a reader can see.
 */

/** Why a configuration DevHub injected could not be used. */
export type ConfigRefusal =
  /** Present but not a loopback `ws:` URL, or the port is out of range. */
  | "endpoint_not_loopback"
  /** Present but not a bearer token this transport will put in a header. */
  | "token_unsafe"
  /** Present but not an absolute path, or it contains a NUL. */
  | "registry_path_unsafe"
  /** Some of the three variables were injected and some were not. */
  | "partially_injected";

/** Why the handshake did not produce a websocket. */
export type HandshakeRefusal =
  /** Not `101`, or the `Upgrade`/`Connection`/`Accept` headers did not agree. */
  | "upgrade_rejected"
  /** The response headers alone exceeded what a handshake may be. */
  | "headers_too_large";

/** Which rule of the frame grammar the host broke. */
export type ProtocolViolation =
  /** `FIN` clear or a reserved bit set: this Bridge speaks no extension. */
  | "reserved_bits_set"
  /** A server frame was masked, which RFC6455 forbids. */
  | "server_frame_masked"
  /** A frame, or the bytes buffered towards one, exceeded the message limit. */
  | "frame_too_large"
  /** A control frame that was fragmented or carried more than 125 bytes. */
  | "control_frame_invalid"
  /** An opcode outside text, close, ping and pong. */
  | "unsupported_opcode";

/** Why the session could no longer trust what the host was saying. */
export type SessionBreak =
  /** A frame that the generated v1 contract refused. */
  | "frame_unparsable"
  /** A first frame that was not an acceptable `hello_accepted`. */
  | "handshake_frame_rejected"
  /** A connection id, sequence or replay that did not match the ledger. */
  | "sequence_broken"
  /** A message kind this Bridge does not answer. */
  | "unexpected_message";

export type BridgeFault =
  /**
   * DevHub injected a configuration the extension will not use.
   *
   * Note what is *not* here: a configuration that is simply absent. The
   * desktop app does not inject one at all, and a Bridge that is not asked to
   * connect is inactive by design, not broken. Announcing that as a failure
   * would put a notification on every workbench DevHub opens, which is the
   * fastest way to teach somebody to ignore this channel.
   */
  | {
      readonly kind: "config";
      readonly variable: string;
      readonly refusal: ConfigRefusal;
    }
  /** The EditorHost-owned surface registry could not be read or parsed. */
  | { readonly kind: "registry"; readonly refusal: "unreadable" | "unparsable" }
  /** The registry named no surface for this window's folder. */
  | { readonly kind: "surface"; readonly folders: number }
  | { readonly kind: "handshake"; readonly refusal: HandshakeRefusal }
  | {
      readonly kind: "protocol";
      readonly violation: ProtocolViolation;
      readonly bytes?: number;
    }
  /** The socket itself failed. `errno` is Node's code, or `"unknown"`. */
  | { readonly kind: "transport"; readonly errno: string }
  | { readonly kind: "session"; readonly reason: SessionBreak }
  /** Activation threw. The message is the extension's own, never a host value. */
  | { readonly kind: "startup"; readonly reason: string };

/**
 * The sentence a person reads, and the only one.
 *
 * A `switch` with no `default`, so a fault added to the union without a
 * sentence fails the typecheck rather than reaching somebody as a tag.
 */
export function describeFault(fault: BridgeFault): string {
  switch (fault.kind) {
    case "config":
      return `DevHub Bridge: ${fault.variable} was rejected (${configSentence(fault.refusal)}). The editor integration is off for this window.`;
    case "registry":
      return fault.refusal === "unreadable"
        ? "DevHub Bridge: DevHub's surface registry could not be read, so this window cannot be matched to a Workspace."
        : "DevHub Bridge: DevHub's surface registry is not valid, so this window cannot be matched to a Workspace.";
    case "surface":
      return fault.folders > 1
        ? "DevHub Bridge: this window has more than one workspace folder, which DevHub does not bridge."
        : "DevHub Bridge: DevHub does not have a surface for this window's folder, so the integration is off.";
    case "handshake":
      return fault.refusal === "upgrade_rejected"
        ? "DevHub Bridge: DevHub refused the connection handshake. The two are probably different versions."
        : "DevHub Bridge: DevHub's handshake response was too large to be one. Reconnecting.";
    case "protocol":
      return `DevHub Bridge: DevHub sent a frame this Bridge will not accept (${protocolSentence(fault.violation)}). Reconnecting.`;
    case "transport":
      return `DevHub Bridge: the connection to DevHub failed (${fault.errno}). Reconnecting.`;
    case "session":
      return `DevHub Bridge: the conversation with DevHub went out of step (${sessionSentence(fault.reason)}). Reconnecting.`;
    case "startup":
      return `DevHub Bridge: the integration could not start (${fault.reason}).`;
  }
}

/**
 * Whether a fault will fix itself.
 *
 * A transport or protocol fault is followed by a reconnect, so it is worth
 * saying on a status item and not worth a modal on every retry. A refused
 * configuration or a missing surface will still be refused after a reconnect
 * and needs a person, so it is said out loud once.
 */
export function faultIsTransient(fault: BridgeFault): boolean {
  switch (fault.kind) {
    case "handshake":
    case "protocol":
    case "transport":
    case "session":
      return true;
    case "config":
    case "registry":
    case "surface":
    case "startup":
      return false;
  }
}

/**
 * What makes two faults the same fault.
 *
 * A reconnect loop raises the same transport fault every few seconds, and a
 * report that repeats is a report nobody reads. The tag and its enumerated
 * reason are the identity; a byte count is detail on the same fault.
 */
export function faultIdentity(fault: BridgeFault): string {
  switch (fault.kind) {
    case "config":
      return `config:${fault.variable}:${fault.refusal}`;
    case "registry":
      return `registry:${fault.refusal}`;
    case "surface":
      return `surface:${String(fault.folders)}`;
    case "handshake":
      return `handshake:${fault.refusal}`;
    case "protocol":
      return `protocol:${fault.violation}`;
    case "transport":
      return `transport:${fault.errno}`;
    case "session":
      return `session:${fault.reason}`;
    case "startup":
      return `startup:${fault.reason}`;
  }
}

function configSentence(refusal: ConfigRefusal): string {
  switch (refusal) {
    case "endpoint_not_loopback":
      return "not a loopback websocket address";
    case "token_unsafe":
      return "not a token that can be sent as a header";
    case "registry_path_unsafe":
      return "not an absolute path";
    case "partially_injected":
      return "some of the Bridge's variables were set and some were not";
  }
}

function protocolSentence(violation: ProtocolViolation): string {
  switch (violation) {
    case "reserved_bits_set":
      return "a reserved bit was set";
    case "server_frame_masked":
      return "a server frame was masked";
    case "frame_too_large":
      return "the frame was over the message limit";
    case "control_frame_invalid":
      return "a control frame was fragmented or oversize";
    case "unsupported_opcode":
      return "an opcode this Bridge does not speak";
  }
}

function sessionSentence(reason: SessionBreak): string {
  switch (reason) {
    case "frame_unparsable":
      return "a frame the v1 contract refused";
    case "handshake_frame_rejected":
      return "the first frame was not an acceptable hello";
    case "sequence_broken":
      return "a sequence or connection id that did not match";
    case "unexpected_message":
      return "a message kind this Bridge does not answer";
  }
}
