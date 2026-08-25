#!/usr/bin/env node
// Finite F0.4 contract/harness tests. No network outside loopback is used.

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { BridgeHost, attachUpgrade } from '../host/bridge-host.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const EVIDENCE = `${ROOT}/evidence/protocol-tests.ndjson`;
mkdirSync(`${ROOT}/evidence`, { recursive: true });
writeFileSync(EVIDENCE, '');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN = randomBytes(32).toString('hex');

function evidence(kind, data = {}) {
  const row = { at: new Date().toISOString(), kind, ...data };
  writeFileSync(EVIDENCE, `${JSON.stringify(row)}\n`, { flag: 'a' });
  return row;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function frame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  else if (body.length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(body.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([header, mask, masked]);
}

class Client extends EventEmitter {
  constructor(endpoint, token) {
    super();
    const url = new URL(endpoint);
    this.host = url.hostname;
    this.port = Number(url.port);
    this.path = `${url.pathname}${url.search}`;
    this.token = token;
    this.buffer = Buffer.alloc(0);
    this.httpReady = false;
    this.closed = false;
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      this.socket = net.connect({ host: this.host, port: this.port }, () => {
        this.socket.write([
          `GET ${this.path} HTTP/1.1`, `Host: ${this.host}:${this.port}`,
          'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Key: ${key}`, `Authorization: Bearer ${this.token}`, '\r\n',
        ].join('\r\n'));
      });
      this.socket.once('error', reject);
      this.socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.httpReady) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const headers = this.buffer.subarray(0, end).toString('latin1');
          this.buffer = this.buffer.subarray(end + 4);
          this.httpReady = /^HTTP\/1\.1 101 /m.test(headers);
          if (!this.httpReady) {
            this.emit('upgrade_rejected', headers);
            reject(new Error('upgrade rejected'));
            this.socket.destroy();
            return;
          }
          resolve();
        }
        this.parse();
      });
      this.socket.on('close', () => { this.closed = true; this.emit('close'); });
    });
  }

  parse() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      const maskOffset = masked ? 4 : 0;
      if (this.buffer.length < offset + maskOffset + length) return;
      let payload = this.buffer.subarray(offset + maskOffset, offset + maskOffset + length);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + maskOffset + length);
      if (opcode === 0x8) { this.emit('close_frame', payload); this.close(); return; }
      if (opcode === 0x9) { this.socket.write(frame(payload, 0xa)); continue; }
      if (opcode === 0x1) {
        try { this.emit('message', JSON.parse(payload.toString('utf8'))); }
        catch { this.emit('raw', payload.toString('utf8')); }
      }
    }
  }

  send(message) { this.socket.write(frame(JSON.stringify(message))); }
  close() { if (this.socket && !this.closed) this.socket.end(); }

  next(kind, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.removeListener('message', onMessage); reject(new Error(`timeout waiting for ${kind}`)); }, timeoutMs);
      const onMessage = (message) => {
        if (message.kind !== kind) return;
        clearTimeout(timer); this.removeListener('message', onMessage); resolve(message);
      };
      this.on('message', onMessage);
    });
  }
}

function envelope(connectionId, sequence, kind, payload, messageId = randomUUID()) {
  return { version: 1, connection_id: connectionId, sequence, message_id: messageId, kind, payload };
}

async function validHandshake(client, surfaceId, workspaceId, dirty = false, contextKind = 'workspace') {
  client.send(envelope(null, 1, 'hello', {
    extension_version: '0.0.1', surface_id: surfaceId, workbench_instance_id: randomUUID(),
  }));
  const accepted = await client.next('hello_accepted');
  assert(accepted.payload.surface_id === surfaceId, 'hello accepted surface mismatch');
  assert(accepted.payload.connection_generation >= 1, 'generation missing');
  const context = contextKind === 'global'
    ? { kind: 'global' }
    : { kind: 'workspace', workspace_id: workspaceId, canonical_root: `/tmp/${surfaceId}` };
  client.send(envelope(accepted.connection_id, 2, 'state_snapshot', {
    surface_id: surfaceId, readiness: 'ready', context, dirty,
  }));
  return { accepted, connectionId: accepted.connection_id, nextSequence: 3 };
}

async function expectError(client, code) {
  const message = await client.next('error');
  assert(message.payload.code === code, `expected ${code}, got ${message.payload.code}`);
  evidence('error_observed', { code });
  return message;
}

async function run() {
  const host = new BridgeHost({ token: TOKEN, expectedSurfaces: [UUID_A, UUID_B], logFile: `${ROOT}/evidence/protocol-host.ndjson` });
  attachUpgrade(host);
  const port = await host.listen();
  const endpoint = host.endpoint();
  evidence('host_started', { port });

  // Bearer upgrade authentication is mandatory.
  const unauthorized = new Client(endpoint, 'wrong-token');
  let rejected = false;
  unauthorized.on('upgrade_rejected', () => { rejected = true; });
  try { await unauthorized.connect(); } catch { /* expected socket close */ }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(rejected, 'wrong Bearer token was not rejected');
  evidence('bearer_upgrade_auth', { result: 'PASS' });

  const a = new Client(endpoint, TOKEN);
  await a.connect();
  const aState = await validHandshake(a, UUID_A, WORKSPACE_A, false);
  evidence('hello_accepted_snapshot', { surface_id: UUID_A, generation: aState.accepted.payload.connection_generation });

  const requestId = '33333333-3333-4333-8333-333333333333';
  a.send(envelope(aState.connectionId, 3, 'open_workspace_requested', {
    absolute_path: '/tmp/requested-workspace', source: 'open_folder',
  }, requestId));
  const firstResponse = await a.next('response');
  assert(firstResponse.payload.request_message_id === requestId, 'request response ID mismatch');
  a.send(envelope(aState.connectionId, 3, 'open_workspace_requested', {
    absolute_path: '/tmp/requested-workspace', source: 'open_folder',
  }, requestId));
  const duplicateResponse = await a.next('response');
  assert(duplicateResponse.payload.result.kind === firstResponse.payload.result.kind, 'duplicate result changed');
  evidence('ordering_dedup', { result: 'PASS', message_id: requestId });

  const snapshotRequestId = host.request([...host.peers][0], 'request_state_snapshot', { reason: 'manual_test' });
  const hostRequest = await a.next('request_state_snapshot');
  a.send(envelope(aState.connectionId, 4, 'response', {
    request_message_id: hostRequest.message_id, result: { kind: 'snapshot_will_follow' },
  }));
  a.send(envelope(aState.connectionId, 5, 'state_snapshot', {
    surface_id: UUID_A, readiness: 'ready', context: { kind: 'workspace', workspace_id: WORKSPACE_A, canonical_root: '/tmp/requested-workspace' }, dirty: false,
  }));
  assert(snapshotRequestId === hostRequest.message_id, 'host request ledger mismatch');
  evidence('host_request_response', { result: 'PASS' });

  a.send(envelope(aState.connectionId, 6, 'dirty_changed', { dirty: true }));
  await sleep(20);
  const b = new Client(endpoint, TOKEN);
  await b.connect();
  const bState = await validHandshake(b, UUID_B, WORKSPACE_B, true);
  assert(host.aggregateDirty() === true, 'aggregate dirty did not become true');
  a.send(envelope(aState.connectionId, 7, 'dirty_changed', { dirty: false }));
  await sleep(20);
  assert(host.aggregateDirty() === true, 'aggregate dirty lost B dirty state');
  b.send(envelope(bState.connectionId, 3, 'dirty_changed', { dirty: false }));
  await sleep(20);
  assert(host.aggregateDirty() === false, 'aggregate dirty did not clear after both saves');
  evidence('aggregate_dirty', { result: 'PASS', surfaces: 2 });

  const identity = new Client(endpoint, TOKEN);
  await identity.connect();
  identity.send(envelope(null, 1, 'hello', {
    extension_version: '0.0.1', surface_id: UUID_A, workbench_instance_id: randomUUID(),
  }));
  const identityAccepted = await identity.next('hello_accepted');
  identity.send(envelope(identityAccepted.connection_id, 2, 'state_snapshot', {
    surface_id: UUID_B, readiness: 'ready', context: { kind: 'global' }, dirty: false,
  }));
  await expectError(identity, 'invalid_identity');
  evidence('surface_identity_binding', { result: 'PASS' });

  const gap = new Client(endpoint, TOKEN);
  await gap.connect();
  gap.send(envelope(null, 1, 'hello', {
    extension_version: '0.0.1', surface_id: UUID_B, workbench_instance_id: randomUUID(),
  }));
  const gapAccepted = await gap.next('hello_accepted');
  gap.send(envelope(gapAccepted.connection_id, 3, 'state_snapshot', {
    surface_id: UUID_B, readiness: 'ready', context: { kind: 'global' }, dirty: false,
  }));
  await expectError(gap, 'sequence_error');
  evidence('sequence_error', { result: 'PASS' });

  const reconnect = new Client(endpoint, TOKEN);
  await reconnect.connect();
  const first = await validHandshake(reconnect, UUID_A, WORKSPACE_A, false, 'global');
  reconnect.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const reconnect2 = new Client(endpoint, TOKEN);
  await reconnect2.connect();
  const second = await validHandshake(reconnect2, UUID_A, WORKSPACE_A, false, 'global');
  assert(second.accepted.payload.connection_generation > first.accepted.payload.connection_generation, 'reconnect generation did not increment');
  evidence('reconnect_generation', { result: 'PASS', before: first.accepted.payload.connection_generation, after: second.accepted.payload.connection_generation });

  for (const client of [a, b, identity, gap, reconnect2]) client.close();
  await host.close();
  evidence('suite_complete', { result: 'PASS' });
  console.log(JSON.stringify({ result: 'PASS', evidence: EVIDENCE }));
}

try {
  await run();
} catch (error) {
  evidence('suite_complete', { result: 'FAIL', summary: String(error.stack || error).slice(0, 1000) });
  console.error(error.stack || error);
  process.exitCode = 1;
}
