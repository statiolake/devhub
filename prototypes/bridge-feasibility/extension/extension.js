// THROWAWAY F0.4 Bridge extension.
//
// The Workbench-facing part intentionally uses only public vscode APIs. The
// loopback transport is a tiny RFC6455 client so the prototype has no runtime
// dependency on an extension-host package that is not part of OpenVSCode.

const vscode = require('vscode');
const net = require('node:net');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const MAX_MESSAGE_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function log(kind, extra = {}) {
  // Never include the endpoint or token in extension-host diagnostics.
  console.log(`[DEVHUB-BRIDGE] ${JSON.stringify({ kind, ...extra })}`);
}

function absolutePath(uri) {
  if (!uri || uri.scheme !== 'file') {
    throw new Error('test path must be a file URI');
  }
  const path = uri.fsPath;
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new Error('test path must be absolute and NUL-free');
  }
  return path;
}

function contextFromWorkspace(workspaceId) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { kind: 'global' };
  }
  const root = absolutePath(folders[0].uri);
  return {
    kind: 'workspace',
    workspace_id: workspaceId,
    canonical_root: root,
  };
}

function makeMaskedFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > MAX_MESSAGE_BYTES) {
    throw new Error('payload too large');
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x81;
  return Buffer.concat([header, mask, masked]);
}

class LoopbackWebSocket {
  constructor(endpoint, token, handlers) {
    this.endpoint = new URL(endpoint);
    this.token = token;
    this.handlers = handlers;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.httpDone = false;
    this.closed = false;
    this.key = crypto.randomBytes(16).toString('base64');
  }

  connect() {
    if (this.closed) return;
    if (this.endpoint.protocol !== 'ws:') {
      throw new Error('F0.4 prototype accepts only ws:// loopback endpoints');
    }
    const host = this.endpoint.hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new Error('Bridge endpoint must be loopback');
    }
    const port = Number(this.endpoint.port || 80);
    this.socket = net.connect({ host, port }, () => {
      const path = `${this.endpoint.pathname || '/'}${this.endpoint.search || ''}`;
      const request = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${this.key}`,
        `Authorization: Bearer ${this.token}`,
        '\r\n',
      ].join('\r\n');
      this.socket.write(request);
    });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => {
      if (!this.closed) this.handlers.onError(error);
    });
    this.socket.on('close', () => {
      if (!this.closed) this.handlers.onClose();
    });
  }

  send(text) {
    if (!this.socket || !this.httpDone || this.closed) return false;
    this.socket.write(makeMaskedFrame(text));
    return true;
  }

  close() {
    this.closed = true;
    if (this.socket) this.socket.destroy();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.httpDone) {
      const marker = this.buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const headers = this.buffer.subarray(0, marker).toString('latin1');
      this.buffer = this.buffer.subarray(marker + 4);
      if (!/^HTTP\/1\.1 101 /m.test(headers)) {
        this.handlers.onError(new Error('Bridge upgrade was not accepted'));
        this.close();
        return;
      }
      this.httpDone = true;
      this.handlers.onOpen();
    }
    this.parseFrames();
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const longLength = this.buffer.readBigUInt64BE(offset);
        if (longLength > BigInt(MAX_MESSAGE_BYTES)) {
          this.handlers.onError(new Error('Bridge message too large'));
          this.close();
          return;
        }
        length = Number(longLength);
        offset += 8;
      }
      const maskOffset = masked ? 4 : 0;
      if (this.buffer.length < offset + maskOffset + length) return;
      let payload = this.buffer.subarray(offset + maskOffset, offset + maskOffset + length);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + maskOffset + length);
      if (opcode === 0x8) {
        this.handlers.onClose();
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendPong(payload);
        continue;
      }
      if (opcode !== 0x1) continue;
      this.handlers.onMessage(payload.toString('utf8'));
    }
  }

  sendPong(payload) {
    if (!this.socket || !this.httpDone || this.closed) return;
    const frame = Buffer.alloc(2 + payload.length);
    frame[0] = 0x8a;
    frame[1] = payload.length;
    payload.copy(frame, 2);
    this.socket.write(frame);
  }
}

function strictKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort().join(',');
  const expected = [...keys].sort().join(',');
  if (actual !== expected) throw new Error(`${label} has unknown or missing fields`);
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('invalid context');
  if (context.kind === 'global') {
    strictKeys(context, ['kind'], 'global context');
    return;
  }
  strictKeys(context, ['kind', 'workspace_id', 'canonical_root'], 'workspace context');
  if (context.kind !== 'workspace' || !UUID_RE.test(context.workspace_id)) throw new Error('invalid workspace context');
  if (typeof context.canonical_root !== 'string' || !context.canonical_root.startsWith('/') || context.canonical_root.includes('\0')) {
    throw new Error('invalid workspace path');
  }
}

function makeBridgeExtension(context) {
  const endpoint = process.env.DEVHUB_BRIDGE_ENDPOINT;
  const token = process.env.DEVHUB_BRIDGE_TOKEN;
  const surfaceId = process.env.DEVHUB_BRIDGE_SURFACE_ID;
  const workspaceId = process.env.DEVHUB_BRIDGE_WORKSPACE_ID || crypto.randomUUID();
  const automation = process.env.DEVHUB_BRIDGE_AUTOMATION === 'real';
  const testFolder = process.env.DEVHUB_BRIDGE_TEST_FOLDER || '/tmp/devhub-bridge-folder';

  if (!endpoint || !token || !surfaceId || !UUID_RE.test(surfaceId)) {
    log('inactive_missing_configuration');
    return;
  }

  let socket = null;
  let connectionId = null;
  let sequence = 0;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let state = 'starting';
  let lastDirty = undefined;
  let lastContext = JSON.stringify(contextFromWorkspace(workspaceId));
  // Stable for this extension-host activation. A new value is therefore
  // evidence of a new extension instance, not merely endpoint reconnect.
  const workbenchInstanceId = crypto.randomUUID();
  const sentRequests = new Map();

  function snapshotPayload(readiness = state === 'ready' ? 'ready' : state) {
    return {
      surface_id: surfaceId,
      readiness,
      context: contextFromWorkspace(workspaceId),
      dirty: vscode.workspace.textDocuments.some((document) => document.isDirty),
    };
  }

  function envelope(kind, payload) {
    sequence += 1;
    return {
      version: 1,
      connection_id: connectionId,
      sequence,
      message_id: crypto.randomUUID(),
      kind,
      payload,
    };
  }

  function send(kind, payload) {
    if (!socket) return false;
    const message = envelope(kind, payload);
    return socket.send(JSON.stringify(message));
  }

  function emitDirtyIfChanged() {
    const dirty = vscode.workspace.textDocuments.some((document) => document.isDirty);
    if (dirty !== lastDirty) {
      lastDirty = dirty;
      send('dirty_changed', { dirty });
      log('dirty_changed', { dirty });
    }
  }

  function emitIdentityIfChanged() {
    const nextContext = contextFromWorkspace(workspaceId);
    const encoded = JSON.stringify(nextContext);
    if (encoded === lastContext) return;
    lastContext = encoded;
    send('identity_changed', { context: nextContext });
    log('identity_changed', { context: nextContext });
  }

  function sendSnapshot(readiness = state) {
    send('state_snapshot', snapshotPayload(readiness));
  }

  function respond(request, result) {
    send('response', {
      request_message_id: request.message_id,
      result,
    });
  }

  function handleMessage(raw) {
    if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
      log('host_message_too_large');
      return;
    }
    let message;
    try {
      message = JSON.parse(raw);
      strictKeys(message, ['version', 'connection_id', 'sequence', 'message_id', 'kind', 'payload'], 'envelope');
      if (message.version !== 1 || !Number.isSafeInteger(message.sequence) || message.sequence < 1 || !UUID_RE.test(message.message_id)) {
        throw new Error('invalid envelope');
      }
    } catch (error) {
      log('host_message_invalid', { summary: String(error.message).slice(0, 256) });
      return;
    }
    if (message.kind === 'hello_accepted') {
      if (message.connection_id !== connectionId) {
        log('host_identity_mismatch');
        return;
      }
      sequence = 1;
      sendSnapshot('ready');
      return;
    }
    if (message.kind === 'request_state_snapshot' || message.kind === 'focus') {
      respond(message, message.kind === 'focus' ? { kind: 'focused' } : { kind: 'snapshot_will_follow' });
      if (message.kind === 'request_state_snapshot') sendSnapshot('ready');
      return;
    }
    if (message.kind === 'error') {
      log('host_error', { code: message.payload && message.payload.code });
    }
  }

  function connect() {
    if (socket) return;
    socket = new LoopbackWebSocket(endpoint, token, {
      onOpen: () => {
        reconnectAttempt = 0;
        connectionId = null;
        sequence = 0;
        state = 'starting';
        const hello = envelope('hello', {
          extension_version: '0.0.1',
          surface_id: surfaceId,
          workbench_instance_id: workbenchInstanceId,
        });
        socket.send(JSON.stringify(hello));
        log('hello_sent', { surface_id: surfaceId });
      },
      onMessage: (raw) => {
        let message;
        try { message = JSON.parse(raw); } catch { log('host_message_invalid_json'); return; }
        if (message.kind === 'hello_accepted') {
          connectionId = message.connection_id;
          state = 'ready';
          sequence = 1;
          sendSnapshot('ready');
          lastDirty = snapshotPayload().dirty;
          log('snapshot_sent', { readiness: 'ready', dirty: lastDirty });
          return;
        }
        handleMessage(raw);
      },
      onError: (error) => log('endpoint_error', { summary: String(error.message).slice(0, 256) }),
      onClose: () => {
        if (socket) socket.close();
        socket = null;
        connectionId = null;
        sequence = 0;
        state = 'unavailable';
        log('endpoint_loss');
        scheduleReconnect();
      },
    });
    socket.connect();
  }

  function scheduleReconnect() {
    if (reconnectTimer || context.extensionMode === vscode.ExtensionMode.Test) return;
    reconnectAttempt += 1;
    const delay = Math.min(1000, 100 * reconnectAttempt);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function waitReady(timeoutMs = 10000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (state === 'ready' && socket) return resolve();
        if (Date.now() - started >= timeoutMs) return reject(new Error('Bridge readiness timeout'));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  function sendOpenRequest(kind, path, source) {
    const payload = kind === 'open_workspace_requested'
      ? { absolute_path: path, source }
      : { absolute_path: path, source };
    const id = crypto.randomUUID();
    sentRequests.set(id, payload);
    send(kind, payload);
    log(kind, { source, absolute_path: path });
  }

  async function dirtyAutomation() {
    await waitReady();
    const first = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'F0.4 first fixture\n' });
    const firstEditor = await vscode.window.showTextDocument(first);
    await firstEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'dirty-one\n'));
    emitDirtyIfChanged();
    const second = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'F0.4 second fixture\n' });
    const secondEditor = await vscode.window.showTextDocument(second);
    await secondEditor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'dirty-two\n'));
    emitDirtyIfChanged();
    // These are intentionally untitled content documents. Saving them would
    // open a native Save As prompt and make a finite headless smoke depend on
    // UI interaction. Keeping both edits dirty is the hot-exit fixture: the
    // public API state is observed after the genuine extension-host restart.
    log('dirty_automation_complete', { fixture: 'two-untitled-content-documents', dirty: true });
  }

  async function probePublicRestartCommands() {
    const commands = await vscode.commands.getCommands(true);
    const restartCommands = commands
      .filter((command) => /restart|extension.?host/i.test(command))
      .sort();
    log('public_restart_command_probe', { matches: restartCommands });
  }

  async function boundaryAutomation() {
    await waitReady();
    sendOpenRequest('open_workspace_requested', testFolder, 'open_folder');
    // A cancelled host navigation may leave the command promise pending. Fire
    // the public command without awaiting it so the second request can still
    // be exercised in the same Workbench session.
    void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(testFolder), { forceNewWindow: false })
      .then(() => log('public_open_folder_command_returned'))
      .catch((error) => log('public_open_folder_command_error', { summary: String(error.message).slice(0, 256) }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    sendOpenRequest('new_window_requested', testFolder, 'command');
    void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(testFolder), { forceNewWindow: true })
      .then(() => log('public_new_window_command_returned'))
      .catch((error) => log('public_new_window_command_error', { summary: String(error.message).slice(0, 256) }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    log('boundary_automation_complete');
  }

  function installCommands() {
    context.subscriptions.push(vscode.commands.registerCommand('devhub.bridge.test.openFolder', () => boundaryAutomation()));
    context.subscriptions.push(vscode.commands.registerCommand('devhub.bridge.test.newWindow', async () => {
      await waitReady();
      sendOpenRequest('new_window_requested', testFolder, 'command');
      return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(testFolder), { forceNewWindow: true });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('devhub.bridge.test.dirty', () => dirtyAutomation()));
  }

  function installObservers() {
    const update = () => setTimeout(() => { emitDirtyIfChanged(); emitIdentityIfChanged(); }, 0);
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(update));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(update));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(update));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(update));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(update));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(update));
  }

  installCommands();
  installObservers();
  connect();
  emitDirtyIfChanged();
  if (automation) {
    const stage = context.globalState.get('devhub.bridge.automation.stage', 0);
    if (stage === 0) {
      context.globalState.update('devhub.bridge.automation.stage', 1).then(async () => {
        try {
          await probePublicRestartCommands();
          await boundaryAutomation();
          log('extension_host_restart_ready', { dirty_fixture: 'deferred_until_after_restart' });
        } catch (error) {
          log('automation_error', { summary: String(error.message).slice(0, 256) });
        }
      });
    } else {
      context.globalState.update('devhub.bridge.automation.stage', 2).then(async () => {
        try {
          await waitReady();
          log('extension_host_restart_reconnected', { stage });
          await dirtyAutomation();
        } catch (error) {
          log('automation_error', { summary: String(error.message).slice(0, 256) });
        }
      });
    }
  }
}

function activate(context) {
  // Public API-only activation marker. It lives in the isolated extension
  // global storage and lets the finite harness distinguish discovery from
  // transport failure without inspecting Workbench internals.
  const marker = vscode.Uri.joinPath(context.globalStorageUri, 'f0-4-activated');
  vscode.workspace.fs.writeFile(marker, new TextEncoder().encode('activated\n')).then(
    () => log('activation_marker_written'),
    (error) => log('activation_marker_failed', { summary: String(error.message).slice(0, 256) }),
  );
  makeBridgeExtension(context);
  log('activated', { api: 'public-vscode-only' });
}

function deactivate() {
  log('deactivated');
}

module.exports = { activate, deactivate };
