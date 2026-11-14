// A language server for the pointer scenario's go to definition (pointer.mjs,
// "definition link"): over stdio, JSON-RPC with Content-Length headers. A
// word is defined where `local <word>` or `function <word>` first appears in
// the document; anything else has no definition. Deterministic and instant,
// so what is timed is DevHub and Neovim, not a real server.
import process from "node:process";

const docs = new Map();
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write(`Content-Length: ${String(body.length)}\r\n\r\n`);
  process.stdout.write(body);
}

function definition(params) {
  const text = docs.get(params.textDocument.uri);
  if (text === undefined) return null;
  const lines = text.split("\n");
  const line = lines[params.position.line] ?? "";
  let s = params.position.character;
  let e = s;
  const word = /[A-Za-z0-9_]/;
  if (!word.test(line[s] ?? "")) return null;
  while (s > 0 && word.test(line[s - 1])) s -= 1;
  while (e < line.length && word.test(line[e])) e += 1;
  const name = line.slice(s, e);
  const decl = new RegExp(`\\b(?:local|function)\\s+(${name})\\b`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = decl.exec(lines[i]);
    if (m) {
      const at = m.index + m[0].length - name.length;
      return {
        uri: params.textDocument.uri,
        range: {
          start: { line: i, character: at },
          end: { line: i, character: at + name.length },
        },
      };
    }
  }
  return null;
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      id,
      result: {
        capabilities: {
          definitionProvider: true,
          textDocumentSync: 1,
          positionEncoding: "utf-16",
        },
      },
    });
  } else if (method === "textDocument/didOpen") {
    docs.set(params.textDocument.uri, params.textDocument.text);
  } else if (method === "textDocument/didChange") {
    const change = params.contentChanges.at(-1);
    if (change) docs.set(params.textDocument.uri, change.text);
  } else if (method === "textDocument/definition") {
    send({ id, result: definition(params) });
  } else if (method === "shutdown") {
    send({ id, result: null });
  } else if (method === "exit") {
    process.exit(0);
  } else if (id !== undefined) {
    send({ id, result: null });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const head = buffer.indexOf("\r\n\r\n");
    if (head < 0) return;
    const match = /Content-Length: (\d+)/i.exec(
      buffer.subarray(0, head).toString(),
    );
    if (!match) {
      buffer = buffer.subarray(head + 4);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < head + 4 + length) return;
    const body = buffer.subarray(head + 4, head + 4 + length).toString();
    buffer = buffer.subarray(head + 4 + length);
    handle(JSON.parse(body));
  }
});
