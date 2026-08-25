// THROWAWAY F0.2/F0.3 extension.
//
// This file deliberately uses only public vscode APIs. It reports Workbench
// editor state over a tiny authenticated loopback WebSocket so the native host
// can assert Monaco/Workbench results without injecting a page observer or
// evaluating JavaScript in the child WebView.

const vscode = require('vscode');
const net = require('node:net');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const MAX_MESSAGE_BYTES = 256 * 1024;

function log(kind, extra = {}) {
  console.log(`[DEVHUB-REAL-NATIVE-INPUT] ${JSON.stringify({ kind, ...extra })}`);
}

function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > MAX_MESSAGE_BYTES) throw new Error('diagnostic payload too large');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

class LoopbackBridge {
  constructor(endpoint, token, onReady) {
    this.endpoint = new URL(endpoint);
    this.token = token;
    this.onReady = onReady;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.httpDone = false;
    this.closed = false;
    this.connectionId = null;
    this.sequence = 1;
  }

  connect() {
    if (this.endpoint.protocol !== 'ws:') throw new Error('bridge endpoint must be ws://');
    if (this.endpoint.hostname !== '127.0.0.1' && this.endpoint.hostname !== 'localhost') {
      throw new Error('bridge endpoint must be loopback');
    }
    const port = Number(this.endpoint.port || 80);
    const key = crypto.randomBytes(16).toString('base64');
    this.socket = net.connect({ host: this.endpoint.hostname, port }, () => {
      const path = `${this.endpoint.pathname || '/'}${this.endpoint.search || ''}`;
      this.socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${this.endpoint.hostname}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        `Authorization: Bearer ${this.token}`,
        '\r\n',
      ].join('\r\n'));
    });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => log('bridge_error', { summary: String(error.message).slice(0, 256) }));
    this.socket.on('close', () => log('bridge_closed'));
  }

  send(kind, payload) {
    if (!this.socket || !this.httpDone || !this.connectionId && kind !== 'hello') return false;
    const message = {
      version: 1,
      connection_id: kind === 'hello' ? null : this.connectionId,
      sequence: this.sequence,
      message_id: crypto.randomUUID(),
      kind,
      payload,
    };
    this.sequence += 1;
    this.socket.write(frame(JSON.stringify(message)));
    return true;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.httpDone) {
      const marker = this.buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const headers = this.buffer.subarray(0, marker).toString('latin1');
      this.buffer = this.buffer.subarray(marker + 4);
      if (!/^HTTP\/1\.1 101 /m.test(headers)) {
        log('bridge_upgrade_rejected');
        this.close();
        return;
      }
      this.httpDone = true;
      this.send('hello', {
        extension_version: '0.0.1',
        surface_id: process.env.DEVHUB_NATIVE_INPUT_SURFACE_ID,
        workbench_instance_id: crypto.randomUUID(),
      });
    }
    this.parseFrames();
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wide = this.buffer.readBigUInt64BE(2);
        if (wide > BigInt(MAX_MESSAGE_BYTES)) throw new Error('bridge message too large');
        length = Number(wide);
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        this.socket.write(pong);
        continue;
      }
      if (opcode !== 0x1) continue;
      let message;
      try { message = JSON.parse(payload.toString('utf8')); } catch { continue; }
      if (message.kind === 'hello_accepted') {
        this.connectionId = message.connection_id;
        this.sequence = 2;
        this.onReady();
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
  }
}

function contextPayload() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return { kind: 'global' };
  return {
    kind: 'workspace',
    canonical_root: folders[0].uri.fsPath,
  };
}

function activate(context) {
  const endpoint = process.env.DEVHUB_NATIVE_INPUT_ENDPOINT;
  const token = process.env.DEVHUB_NATIVE_INPUT_BRIDGE_TOKEN;
  const surfaceId = process.env.DEVHUB_NATIVE_INPUT_SURFACE_ID;
  const fixturePath = process.env.DEVHUB_NATIVE_INPUT_FIXTURE;
  if (!endpoint || !token || !surfaceId || !fixturePath) {
    log('inactive_missing_configuration');
    return;
  }

  let bridge;
  let editor;
  let lastText;
  let lastDirty;

  const sendDiagnostic = (stage, extra = {}) => {
    const document = editor?.document || vscode.window.activeTextEditor?.document;
    const text = document?.getText() ?? '';
    const dirty = document?.isDirty ?? false;
    lastText = text;
    lastDirty = dirty;
    bridge?.send('diagnostic', {
      stage,
      text,
      dirty,
      uri: document?.uri.toString() ?? null,
      context: contextPayload(),
      public_api: 'vscode.workspace/vscode.window/vscode.commands',
      content_source: 'public-vscode-api',
      selection: editor?.selection
        ? {
            start: [editor.selection.start.line, editor.selection.start.character],
            end: [editor.selection.end.line, editor.selection.end.character],
          }
        : null,
      ...extra,
    });
    log(stage, { dirty, text_length: [...text].length });
  };

  const openFixture = async () => {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixturePath));
      editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One, false);
      const end = document.lineAt(document.lineCount - 1).range.end;
      editor.selection = new vscode.Selection(0, 0, end.line, end.character);
      // Keep focus ownership in the public Workbench model before the native
      // host posts CGEvents. This is a real command invocation, not a DOM or
      // page-script focus shim.
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      editor.selection = new vscode.Selection(0, 0, end.line, end.character);
      editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('editor.action.selectAll');
      log('editor_focus_requested', { public_api: 'vscode.commands/vscode.window' });
      sendDiagnostic('editor_focus_requested', {
        command: 'workbench.action.focusActiveEditorGroup',
      });
      sendDiagnostic('editor_ready', { selection: 'all' });
    } catch (error) {
      log('editor_open_failed', { summary: String(error.message).slice(0, 256) });
    }
  };

  bridge = new LoopbackBridge(endpoint, token, () => {
    bridge.send('state_snapshot', {
      readiness: 'ready',
      context: contextPayload(),
      dirty: editor?.document?.isDirty ?? false,
    });
    sendDiagnostic('bridge_ready');
  });

  context.subscriptions.push(vscode.commands.registerCommand('devhub.realNativeInput.q', () => {
    sendDiagnostic('public_command_q_result', {
      command: 'devhub.realNativeInput.q',
      result: 'executed_by_workbench_keybinding',
    });
    return 'native-q-observed';
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (editor && event.document.uri.toString() === editor.document.uri.toString()) {
      setTimeout(() => sendDiagnostic('document_changed'), 0);
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    if (editor && document.uri.toString() === editor.document.uri.toString()) {
      sendDiagnostic('document_saved', { save_event: true });
    }
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    setTimeout(() => sendDiagnostic('active_editor_changed'), 0);
  }));

  bridge.connect();
  void openFixture();
  log('activated', { api: 'public-vscode-only', no_dom_observer: true });
}

function deactivate() {
  log('deactivated');
}

module.exports = { activate, deactivate };
