// THROWAWAY public-API Bridge sink for the real Workbench native-input gate.
//
// The extension is the only producer of Workbench state. This server never
// evaluates page JavaScript and never inspects a WebView DOM. It accepts the
// small subset of the Bridge envelope needed for readiness and diagnostics.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

const MAX_MESSAGE_BYTES = 256 * 1024;

function frame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

class Peer extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => { this.closed = true; this.emit('close'); });
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wide = this.buffer.readBigUInt64BE(2);
        if (wide > BigInt(MAX_MESSAGE_BYTES)) { this.close(1009); return; }
        length = Number(wide);
        offset = 10;
      }
      const maskOffset = masked ? 4 : 0;
      if (this.buffer.length < offset + maskOffset + length) return;
      let payload = this.buffer.subarray(offset + maskOffset, offset + maskOffset + length);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      this.buffer = this.buffer.subarray(offset + maskOffset + length);
      if (opcode === 0x8) { this.close(1000); return; }
      if (opcode === 0x9) { this.socket.write(frame(payload, 0xa)); continue; }
      if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    }
  }

  send(value) {
    if (!this.closed) this.socket.write(frame(JSON.stringify(value)));
  }

  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.socket.write(frame(payload, 0x8));
    this.socket.end();
    // A misbehaving extension must not keep the finite harness alive. The
    // normal close handshake gets a short grace period, then the TCP socket
    // is destroyed by the timer below.
    setTimeout(() => this.socket.destroy(), 250).unref();
  }
}

export class NativeInputBridge extends EventEmitter {
  constructor({ token, surfaceId, logFile }) {
    super();
    this.token = token;
    this.surfaceId = surfaceId;
    this.logFile = logFile;
    this.server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      } else {
        response.writeHead(404).end();
      }
    });
    this.peers = new Set();
    this.generation = 0;
  }

  log(kind, fields = {}) {
    const event = { at: new Date().toISOString(), kind, ...fields };
    const line = `${JSON.stringify(event)}\n`;
    if (this.logFile) {
      mkdirSync(new URL('.', `file://${this.logFile}`).pathname, { recursive: true });
      appendFileSync(this.logFile, line);
    }
    this.emit('event', event);
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.port = this.server.address().port;
      this.log('bridge_listening', { port: this.port, surface_id: this.surfaceId });
      resolve(this.port);
    }));
  }

  endpoint() { return `ws://127.0.0.1:${this.port}/bridge`; }

  upgrade(request, socket) {
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      this.log('upgrade_rejected');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer = new Peer(socket);
    this.peers.add(peer);
    peer.phase = 'hello';
    peer.connectionId = null;
    peer.expectedSequence = 1;
    peer.on('message', (raw) => this.onMessage(peer, raw));
    peer.on('error', (error) => this.log('bridge_peer_error', { summary: String(error.message).slice(0, 256) }));
    peer.on('close', () => {
      this.peers.delete(peer);
      this.log('connection_closed', {
        surface_id: peer.surfaceId || null,
        workbench_instance_id: peer.workbenchInstanceId || null,
      });
    });
  }

  onMessage(peer, raw) {
    if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
      peer.close(1009);
      this.log('protocol_error', { code: 'payload_too_large' });
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch {
      this.log('protocol_error', { code: 'invalid_json' });
      peer.close(1002);
      return;
    }
    if (!message || message.version !== 1 || !Number.isSafeInteger(message.sequence) ||
        typeof message.message_id !== 'string' || typeof message.kind !== 'string') {
      this.log('protocol_error', { code: 'invalid_envelope' });
      peer.close(1002);
      return;
    }
    if (peer.phase === 'hello') {
      if (message.kind !== 'hello' || message.sequence !== 1 || message.connection_id !== null ||
          message.payload?.surface_id !== this.surfaceId) {
        this.log('protocol_error', { code: 'invalid_hello' });
        peer.close(1002);
        return;
      }
      peer.surfaceId = message.payload.surface_id;
      peer.workbenchInstanceId = message.payload.workbench_instance_id;
      peer.connectionId = randomUUID();
      peer.phase = 'active';
      peer.expectedSequence = 2;
      this.generation += 1;
      peer.send({
        version: 1,
        connection_id: peer.connectionId,
        sequence: 1,
        message_id: randomUUID(),
        kind: 'hello_accepted',
        payload: { accepted_version: 1, surface_id: peer.surfaceId, connection_generation: this.generation },
      });
      this.log('hello_accepted', {
        surface_id: peer.surfaceId,
        workbench_instance_id: peer.workbenchInstanceId,
        connection_generation: this.generation,
      });
      return;
    }
    if (message.connection_id !== peer.connectionId || message.sequence !== peer.expectedSequence) {
      this.log('protocol_error', { code: 'sequence_or_identity_error', sequence: message.sequence });
      peer.close(1002);
      return;
    }
    peer.expectedSequence += 1;
    if (message.kind === 'state_snapshot') {
      this.log('snapshot_applied', {
        surface_id: peer.surfaceId,
        readiness: message.payload?.readiness || null,
        dirty: Boolean(message.payload?.dirty),
        context: message.payload?.context || null,
      });
      return;
    }
    if (message.kind === 'diagnostic') {
      const payload = message.payload || {};
      this.log('workbench_public_api_state', {
        surface_id: peer.surfaceId,
        stage: payload.stage || null,
        text: typeof payload.text === 'string' ? payload.text : null,
        dirty: typeof payload.dirty === 'boolean' ? payload.dirty : null,
        command: payload.command || null,
        result: payload.result || null,
        public_api: payload.public_api || null,
        content_source: payload.content_source || null,
        selection: payload.selection || null,
        uri: payload.uri || null,
      });
      return;
    }
    this.log('protocol_error', { code: 'unsupported_kind', kind: message.kind });
    peer.close(1002);
  }

  close() {
    for (const peer of this.peers) peer.close(1001);
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      const timer = setTimeout(() => {
        this.server.closeAllConnections?.();
        finish();
      }, 1_000);
      timer.unref();
      this.server.close(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }
}

export function attachUpgrade(bridge) {
  bridge.server.on('upgrade', (request, socket) => bridge.upgrade(request, socket));
}
