/**
 * Transcripts made the way a GUI Agent's are: the adapters' own fixtures fed
 * through the real Claude and Codex adapters, which fold their events with
 * `applyEvent`. What the page is tested against is then what main would hand
 * it, not a shape a test wrote to look like it.
 *
 * Only the fixtures' text is taken here, so the same functions serve a test
 * (reading the files with `node:fs`) and a page in a browser (importing them
 * as raw text).
 */

import type { Transcript } from "../../model/conversation";
import type { ProtocolAdapter } from "../../main/agent/conversation/protocolAdapter";
import { ClaudeAdapter } from "../../main/agent/conversation/claude/adapter";
import { CodexAdapter } from "../../main/agent/conversation/codex/adapter";

/** One line of a Claude fixture: what DevHub wrote (`>`) or the CLI printed (`<`). */
export interface ClaudeLine {
  readonly side: "sent" | "received";
  readonly line: string;
}

export function claudeLines(fixture: string): readonly ClaudeLine[] {
  return fixture
    .split("\n")
    .filter((text) => text !== "" && !text.startsWith("#"))
    .map((text) => {
      if (text.startsWith("> ")) return { side: "sent", line: text.slice(2) };
      if (text.startsWith("< "))
        return { side: "received", line: text.slice(2) };
      throw new Error(
        `a Claude fixture line is neither "> " nor "< ": ${text}`,
      );
    });
}

/** Lines written back at once by the protocol are written, as the caller does. */
function feed(adapter: ProtocolAdapter, step: { replies: readonly string[] }) {
  for (const reply of step.replies) feed(adapter, adapter.sent(reply));
}

export function claudeTranscript(lines: readonly ClaudeLine[]): Transcript {
  const adapter = new ClaudeAdapter("boot");
  for (const { side, line } of lines) {
    feed(
      adapter,
      side === "sent" ? adapter.sent(line) : adapter.received(line),
    );
  }
  return adapter.transcript;
}

export function codexLines(fixture: string): readonly string[] {
  return fixture.split("\n").filter((line) => line !== "");
}

/**
 * A Codex conversation past its handshake, one person's message sent, and
 * `turn` received: the order the adapter's own tests play them in.
 */
export function codexTranscript(
  handshake: readonly string[],
  message: string,
  turn: readonly string[],
): Transcript {
  const adapter = new CodexAdapter({
    clientVersion: "0.1.0",
    cwd: "/home/testuser/project",
    resumeThreadId: undefined,
  });
  for (const line of adapter.opening()) feed(adapter, adapter.sent(line));
  for (const line of handshake) feed(adapter, adapter.received(line));
  for (const line of adapter.encode({
    kind: "send",
    text: message,
    origin: "person",
  })) {
    feed(adapter, adapter.sent(line));
  }
  for (const line of turn) feed(adapter, adapter.received(line));
  return adapter.transcript;
}
