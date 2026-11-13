#!/usr/bin/env node
// A stand-in Claude CLI in stream-json mode, for the stability suite's
// conversation scenario. Never a model: it answers the handshake, and each
// message it is sent is answered with one streamed paragraph — the message
// opened, its text grown by a delta every STEP ms (a word or two each, some
// of them starting a new line or a list item), then the whole message and the
// turn's result. The shapes are those of
// src/main/agent/conversation/fixtures/claude-permission-turn.ndjson.
import { createInterface } from "node:readline";

const SESSION = "00000000-0000-4000-8000-00000000057a";
const STEP = Number(process.env.FAKE_STEP_MS ?? "60");
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const event = (e) =>
  out({
    type: "stream_event",
    event: e,
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: uuid(),
  });

const ANSWER = [
  "The ",
  "workspace ",
  "has ",
  "three ",
  "folders ",
  "under ",
  "`src`. ",
  "Each ",
  "one ",
  "holds ",
  "six ",
  "modules.\n\n",
  "- ",
  "`core` ",
  "doubles ",
  "and ",
  "shifts\n",
  "- ",
  "`ui` ",
  "does ",
  "the ",
  "same\n",
  "- ",
  "`util` ",
  "too\n\n",
  "Nothing ",
  "else ",
  "needs ",
  "doing.",
];

let turnNo = 0;
async function turn() {
  const id = `msg_${++turnNo}`;
  await sleep(STEP);
  event({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model: "fake",
    },
  });
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (const piece of ANSWER) {
    await sleep(STEP);
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: piece },
    });
  }
  event({ type: "content_block_stop", index: 0 });
  out({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "fake",
      content: [{ type: "text", text: ANSWER.join("") }],
    },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: uuid(),
  });
  event({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 40 },
  });
  event({ type: "message_stop" });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 900,
    num_turns: 1,
    result: ANSWER.join(""),
    session_id: SESSION,
    total_cost_usd: 0,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 40,
    },
    permission_denials: [],
    uuid: uuid(),
  });
}

let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (value.type === "control_request") {
    const subtype = value.request?.subtype;
    let response = {};
    if (subtype === "initialize") {
      response = {
        commands: [],
        models: [{ value: "default", displayName: "Default", description: "" }],
      };
    } else if (subtype === "mcp_status") {
      response = { mcpServers: [] };
    }
    out({
      type: "control_response",
      response: { subtype: "success", request_id: value.request_id, response },
    });
    if (subtype === "initialize") {
      out({
        type: "system",
        subtype: "init",
        session_id: SESSION,
        cwd: process.cwd(),
        model: "fake",
        permissionMode: "default",
        slash_commands: [],
        claude_code_version: "2.1.0",
        tools: [],
        uuid: uuid(),
      });
    }
    return;
  }
  if (value.type === "user") {
    const content = value.message?.content;
    const text =
      typeof content === "string"
        ? content
        : (content ?? []).map((part) => part.text ?? "").join("");
    out({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: uuid(),
      isReplay: true,
    });
    queue = queue.then(turn);
  }
});
