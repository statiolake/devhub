// A minimal Chrome DevTools Protocol client over Node's own WebSocket.
//
// The stability harness talks to each of the window's pages (each a
// WebContentsView with its own CDP target) through one of these. Nothing here
// knows about DevHub: `connect` picks a target by a substring of its URL.

export async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  return response.json();
}

/** Wait until a page whose URL contains `match` is listed, and connect to it. */
export async function connect(port, match, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let target;
  for (;;) {
    try {
      target = (await targets(port)).find(
        (t) => t.type === "page" && t.url.includes(match),
      );
    } catch {
      target = undefined;
    }
    if (target) break;
    if (Date.now() > deadline) throw new Error(`no CDP page matching ${match}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}`));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) ?? []) {
      listener(message.params);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, {
        resolve,
        reject: (error) => reject(new Error(`${method}: ${error.message}`)),
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const client = {
    url: target.url,
    send,
    on(method, listener) {
      const list = listeners.get(method) ?? [];
      list.push(listener);
      listeners.set(method, list);
      return () =>
        listeners.set(
          method,
          list.filter((l) => l !== listener),
        );
    },
    /** Evaluate an expression in the page, awaiting a promise, by value. */
    async eval(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails;
        throw new Error(
          `in ${target.url}: ${detail.exception?.description ?? detail.text}`,
        );
      }
      return result.result.value;
    },
    close() {
      ws.close();
    },
  };
  return client;
}
