#!/usr/bin/env node
// THROWAWAY F0.4 loopback Bridge host.
//
// This is deliberately dependency-free. It implements only the WebSocket
// framing and strict v1 envelope checks needed to exercise the frozen wire
// contract. It is not a production WebSocket implementation.

import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';

export const MAX_MESSAGE_BYTES = 256 * 1024;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = new Set([
  'hello', 'hello_accepted', 'state_snapshot', 'ready_changed', 'identity_changed',
  'dirty_changed', 'open_workspace_requested', 'new_window_requested',
  'request_state_snapshot', 'focus', 'response', 'error',
]);

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be object`);
  const actual = Object.keys(value).sort().join(',');
  const expected = [...keys].sort().join(',');
  if (actual !== expected) throw new Error(`${name} fields are not exact`);
}

function canonicalPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('invalid absolute path');
  if (value !== '/' && /\/\.?(?:\/|$)/.test(value)) throw new Error('path is not lexically normalized');
  return value;
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('invalid context');
  if (context.kind === 'global') {
    exactKeys(context, ['kind'], 'global context');
    return context;
  }
  exactKeys(context, ['kind', 'workspace_id', 'canonical_root'], 'workspace context');
  if (context.kind !== 'workspace' || !UUID_RE.test(context.workspace_id)) throw new Error('invalid workspace context');
  canonicalPath(context.canonical_root);
  return context;
}

function validatePayload(kind, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be object');
  switch (kind) {
    case 'hello':
      exactKeys(payload, ['extension_version', 'surface_id', 'workbench_instance_id'], 'hello');
      if (typeof payload.extension_version !== 'string' || !UUID_RE.test(payload.surface_id) || !UUID_RE.test(payload.workbench_instance_id)) throw new Error('invalid hello');
      break;
    case 'state_snapshot':
      exactKeys(payload, ['surface_id', 'readiness', 'context', 'dirty'], 'state_snapshot');
      if (!UUID_RE.test(payload.surface_id) || !['starting', 'ready', 'unavailable'].includes(payload.readiness) || typeof payload.dirty !== 'boolean') throw new Error('invalid snapshot');
      validateContext(payload.context);
      break;
    case 'ready_changed':
      exactKeys(payload, ['readiness'], 'ready_changed');
      if (!['starting', 'ready', 'unavailable'].includes(payload.readiness)) throw new Error('invalid readiness');
      break;
    case 'identity_changed':
      exactKeys(payload, ['context'], 'identity_changed');
      validateContext(payload.context);
      break;
    case 'dirty_changed':
      exactKeys(payload, ['dirty'], 'dirty_changed');
      if (typeof payload.dirty !== 'boolean') throw new Error('invalid dirty');
      break;
    case 'open_workspace_requested':
      exactKeys(payload, ['absolute_path', 'source'], 'open_workspace_requested');
      canonicalPath(payload.absolute_path);
      if (!['open_folder', 'open_workspace', 'external_uri'].includes(payload.source)) throw new Error('invalid open source');
      break;
    case 'new_window_requested':
      exactKeys(payload, ['absolute_path', 'source'], 'new_window_requested');
      if (payload.absolute_path !== null) canonicalPath(payload.absolute_path);
      if (!['command', 'external_uri', 'unknown'].includes(payload.source)) throw new Error('invalid new-window source');
      break;
    case 'request_state_snapshot':
      exactKeys(payload, ['reason'], 'request_state_snapshot');
      if (!['host_reconcile', 'manual_test'].includes(payload.reason)) throw new Error('invalid snapshot reason');
      break;
    case 'focus':
      exactKeys(payload, ['reason'], 'focus');
      if (!['navigation', 'window_restore'].includes(payload.reason)) throw new Error('invalid focus reason');
      break;
    case 'response':
      exactKeys(payload, ['request_message_id', 'result'], 'response');
      if (!UUID_RE.test(payload.request_message_id) || !payload.result || typeof payload.result.kind !== 'string') throw new Error('invalid response');
      break;
    case 'error':
      exactKeys(payload, ['request_message_id', 'code', 'summary'], 'error');
      if (payload.request_message_id !== null && !UUID_RE.test(payload.request_message_id)) throw new Error('invalid error request ID');
      if (!['unsupported_version', 'invalid_identity', 'invalid_message', 'sequence_error', 'payload_too_large', 'surface_unavailable', 'request_failed', 'request_cancelled', 'bridge_timeout', 'connection_lost'].includes(payload.code)) throw new Error('invalid error code');
      if (typeof payload.summary !== 'string' || [...payload.summary].length > 256) throw new Error('invalid error summary');
      break;
    case 'hello_accepted':
      exactKeys(payload, ['accepted_version', 'surface_id', 'connection_generation'], 'hello_accepted');
      break;
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

function validateEnvelope(message, bytes) {
  if (bytes > MAX_MESSAGE_BYTES) throw Object.assign(new Error('payload too large'), { code: 'payload_too_large' });
  exactKeys(message, ['version', 'connection_id', 'sequence', 'message_id', 'kind', 'payload'], 'envelope');
  if (message.version !== 1 || !Number.isSafeInteger(message.sequence) || message.sequence < 1 || !UUID_RE.test(message.message_id) || !KINDS.has(message.kind)) {
    throw Object.assign(new Error('invalid envelope'), { code: 'invalid_message' });
  }
  validatePayload(message.kind, message.payload);
  return message;
}

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
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.emit('socket_error', error));
    socket.on('close', () => { this.closed = true; this.emit('close'); });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      if (length === 127) {
        if (this.buffer.length < 10) return;
        const wide = this.buffer.readBigUInt64BE(2);
        if (wide > BigInt(MAX_MESSAGE_BYTES)) { this.emit('oversize'); return; }
        length = Number(wide); offset = 10;
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
      if (opcode === 0x8) { this.emit('close_frame'); this.close(); return; }
      if (opcode === 0x9) { this.socket.write(frame(payload, 0xa)); continue; }
      if (opcode === 0x1) this.emit('message', payload.toString('utf8'), payload.length);
    }
  }

  send(value) {
    if (!this.closed) this.socket.write(frame(JSON.stringify(value)));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.socket.write(frame(payload, 0x8));
    this.socket.end();
  }
}

export class BridgeHost extends EventEmitter {
  constructor({ token, expectedSurfaces = [], logFile, closeFirstAfterSnapshot = false } = {}) {
    super();
    this.token = token;
    this.expectedSurfaces = new Set(expectedSurfaces);
    this.logFile = logFile;
    this.closeFirstAfterSnapshot = closeFirstAfterSnapshot;
    this.server = createServer((req, res) => this.handleHttp(req, res));
    this.peers = new Set();
    this.surfaceState = new Map();
    this.generations = new Map();
    this.ledger = new Map();
    this.requestPending = new Map();
    this.serverSequence = new Map();
    this.firstSnapshotClosed = false;
  }

  log(kind, data = {}) {
    const event = { at: new Date().toISOString(), kind, ...data };
    const line = `${JSON.stringify(event)}\n`;
    if (this.logFile) { mkdirSync(new URL('.', `file://${this.logFile}`).pathname, { recursive: true }); appendFileSync(this.logFile, line); }
    this.emit('event', event);
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      const address = this.server.address();
      this.port = address.port;
      this.log('host_listening', { port: this.port });
      resolve(this.port);
    }));
  }

  endpoint() { return `ws://127.0.0.1:${this.port}/bridge`; }

  close() {
    for (const peer of this.peers) peer.close(1001);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  handleHttp(req, res) {
    if (req.method === 'POST' && req.url === '/boundary') {
      const chunks = [];
      let bytes = 0;
      req.on('data', (chunk) => { bytes += chunk.length; if (bytes <= MAX_MESSAGE_BYTES) chunks.push(chunk); });
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body.kind !== 'folder_navigation_intercepted' && body.kind !== 'new_window_intercepted') throw new Error('invalid boundary kind');
          this.log(body.kind, { path: body.path || null, url: body.url || null });
          res.writeHead(204).end();
        } catch (error) {
          res.writeHead(400).end();
          this.log('boundary_error', { summary: String(error.message).slice(0, 256) });
        }
      });
      return;
    }
    res.writeHead(404).end();
  }

  upgrade(req, socket) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${this.token}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      this.log('upgrade_rejected');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer = new Peer(socket);
    this.peers.add(peer);
    this.attachPeer(peer);
    peer.on('close', () => { this.peers.delete(peer); this.onPeerClose(peer); });
  }

  attachPeer(peer) {
    peer.phase = 'hello';
    peer.expectedSequence = 1;
    peer.lastMessage = null;
    peer.surfaceId = null;
    peer.connectionId = null;
    peer.serverSequence = 0;
    peer.on('message', (raw, bytes) => this.onPeerMessage(peer, raw, bytes));
    peer.on('oversize', () => this.protocolError(peer, 'payload_too_large', 'message exceeds 256 KiB'));
  }

  send(peer, kind, payload) {
    peer.serverSequence += 1;
    const message = {
      version: 1,
      connection_id: peer.connectionId,
      sequence: peer.serverSequence,
      message_id: randomUUID(),
      kind,
      payload,
    };
    peer.send(message);
    return message;
  }

  errorPayload(requestMessageId, code, summary) {
    return { request_message_id: requestMessageId ?? null, code, summary: [...summary].slice(0, 256).join('') };
  }

  protocolError(peer, code, summary, requestMessageId = null) {
    this.log('protocol_error', { code, summary });
    if (!peer.closed) this.send(peer, 'error', this.errorPayload(requestMessageId, code, summary));
    setTimeout(() => peer.close(1002), 5);
  }

  onPeerMessage(peer, raw, bytes) {
    let message;
    try { message = validateEnvelope(JSON.parse(raw), bytes); }
    catch (error) { this.protocolError(peer, error.code || 'invalid_message', error.message); return; }
    if (peer.phase === 'hello') {
      if (message.sequence !== 1 || message.connection_id !== null || message.kind !== 'hello') {
        this.protocolError(peer, 'sequence_error', 'first message must be hello sequence 1'); return;
      }
      const surfaceId = message.payload.surface_id;
      if (this.expectedSurfaces.size && !this.expectedSurfaces.has(surfaceId)) {
        this.protocolError(peer, 'invalid_identity', 'surface identity is not registered'); return;
      }
      peer.surfaceId = surfaceId;
      peer.workbenchInstanceId = message.payload.workbench_instance_id;
      const generation = (this.generations.get(surfaceId) || 0) + 1;
      this.generations.set(surfaceId, generation);
      peer.connectionId = randomUUID();
      peer.phase = 'snapshot';
      peer.expectedSequence = 2;
      this.send(peer, 'hello_accepted', { accepted_version: 1, surface_id: surfaceId, connection_generation: generation });
      this.log('hello_accepted', { surface_id: surfaceId, workbench_instance_id: peer.workbenchInstanceId, connection_generation: generation });
      return;
    }
    if (message.connection_id !== peer.connectionId) { this.protocolError(peer, 'invalid_identity', 'connection identity mismatch'); return; }
    if (message.sequence < peer.expectedSequence) {
      if (peer.lastMessage && peer.lastMessage.sequence === message.sequence && peer.lastMessage.message_id === message.message_id) {
        this.log('duplicate_ignored', { surface_id: peer.surfaceId, sequence: message.sequence, message_id: message.message_id });
        if (peer.lastResult) this.send(peer, 'response', peer.lastResult);
        return;
      }
      this.protocolError(peer, 'sequence_error', 'sequence reused with a different message ID'); return;
    }
    if (message.sequence !== peer.expectedSequence) { this.protocolError(peer, 'sequence_error', 'sequence gap or decrease'); return; }
    peer.lastMessage = message;
    peer.expectedSequence += 1;
    if (peer.phase === 'snapshot') {
      if (message.kind !== 'state_snapshot' || message.payload.surface_id !== peer.surfaceId) { this.protocolError(peer, 'invalid_identity', 'snapshot must bind to hello surface'); return; }
      peer.phase = 'active';
      this.applySnapshot(peer, message.payload);
      if (this.closeFirstAfterSnapshot && !this.firstSnapshotClosed) {
        this.firstSnapshotClosed = true;
        this.log('endpoint_loss_injected', { surface_id: peer.surfaceId });
        setTimeout(() => peer.close(1001), 50);
      }
      return;
    }
    if (message.kind === 'state_snapshot') this.applySnapshot(peer, message.payload);
    if (message.kind === 'dirty_changed') {
      const previous = this.surfaceState.get(peer.surfaceId) || {};
      this.applySurface(peer.surfaceId, { ...previous, dirty: message.payload.dirty });
      this.log('dirty_changed', { surface_id: peer.surfaceId, dirty: message.payload.dirty, aggregate_dirty: this.aggregateDirty() });
    }
    if (message.kind === 'identity_changed') {
      const previous = this.surfaceState.get(peer.surfaceId) || {};
      this.applySurface(peer.surfaceId, { ...previous, context: message.payload.context });
      this.log('identity_changed', { surface_id: peer.surfaceId, context: message.payload.context });
    }
    if (message.kind === 'ready_changed') this.log('ready_changed', { surface_id: peer.surfaceId, readiness: message.payload.readiness });
    if (message.kind === 'open_workspace_requested' || message.kind === 'new_window_requested') this.handleRequest(peer, message);
    if (message.kind === 'response') this.handleResponse(peer, message);
  }

  applySurface(surfaceId, state) {
    this.surfaceState.set(surfaceId, state);
    this.log('surface_state', { surface_id: surfaceId, readiness: state.readiness || null, dirty: state.dirty ?? null, aggregate_dirty: this.aggregateDirty() });
  }

  applySnapshot(peer, snapshot) {
    this.applySurface(peer.surfaceId, { readiness: snapshot.readiness, context: snapshot.context, dirty: snapshot.dirty });
    this.log('snapshot_applied', { surface_id: peer.surfaceId, readiness: snapshot.readiness, dirty: snapshot.dirty, context: snapshot.context, aggregate_dirty: this.aggregateDirty() });
  }

  aggregateDirty() {
    for (const state of this.surfaceState.values()) if (state.dirty === true) return true;
    return false;
  }

  handleRequest(peer, message) {
    const existing = this.ledger.get(message.message_id);
    if (existing) {
      peer.lastResult = existing;
      this.send(peer, 'response', existing);
      this.log('request_deduplicated', { surface_id: peer.surfaceId, message_id: message.message_id, result: existing.result });
      return;
    }
    const context = message.payload.absolute_path === null ? { kind: 'global' } : {
      kind: 'workspace', workspace_id: randomUUID(), canonical_root: message.payload.absolute_path,
    };
    const result = { request_message_id: message.message_id, result: context.kind === 'global' ? { kind: 'global_routed', context } : { kind: 'workspace_routed', context } };
    this.ledger.set(message.message_id, result);
    if (this.ledger.size > 1024) this.ledger.delete(this.ledger.keys().next().value);
    peer.lastResult = result;
    this.send(peer, 'response', result);
    this.log(message.kind, { surface_id: peer.surfaceId, message_id: message.message_id, path: message.payload.absolute_path, source: message.payload.source, result: result.result });
  }

  handleResponse(peer, message) {
    const request = this.requestPending.get(message.payload.request_message_id);
    if (!request) { this.protocolError(peer, 'invalid_message', 'response has no pending request', message.payload.request_message_id); return; }
    this.requestPending.delete(message.payload.request_message_id);
    this.log('host_request_response', { surface_id: peer.surfaceId, request_message_id: message.payload.request_message_id, result: message.payload.result });
  }

  request(peer, kind, payload) {
    const message = this.send(peer, kind, payload);
    this.requestPending.set(message.message_id, message);
    this.log('host_request', { surface_id: peer.surfaceId, kind, request_message_id: message.message_id });
    return message.message_id;
  }

  onPeerClose(peer) {
    if (!peer.surfaceId) return;
    const state = this.surfaceState.get(peer.surfaceId);
    if (state) this.applySurface(peer.surfaceId, { ...state, readiness: 'unavailable', dirty: false });
    this.log('connection_closed', { surface_id: peer.surfaceId, workbench_instance_id: peer.workbenchInstanceId || null });
  }
}

export function attachUpgrade(host) {
  host.server.on('upgrade', (req, socket) => host.upgrade(req, socket));
}

export function parseArgs(argv) {
  const values = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replaceAll('-', '_');
    values[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  const token = args.token || randomBytes(32).toString('hex');
  const host = new BridgeHost({ token, logFile: args.log, closeFirstAfterSnapshot: Boolean(args.close_first_after_snapshot) });
  attachUpgrade(host);
  await host.listen();
  console.log(JSON.stringify({ kind: 'ready', endpoint: host.endpoint(), port: host.port }));
  process.on('SIGTERM', async () => { await host.close(); process.exit(0); });
}
