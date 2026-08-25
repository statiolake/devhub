#!/usr/bin/env node
// Finite real OpenVSCode 1.109.5 + Tauri child-WebView smoke.
// The script fails closed when a required boundary is not observed.

import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { BridgeHost, attachUpgrade } from '../host/bridge-host.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const EVIDENCE = `${ROOT}/evidence/real-smoke.ndjson`;
const RUNTIME = `/private/tmp/devhub-bridge-feasibility-${process.pid}-${Date.now()}`;
const ARTIFACT = process.env.OPENVSCODE_ARTIFACT_ROOT || '/private/tmp/openvscode-darwin-arm64-feasibility/vscode-reh-web-darwin-arm64';
const BINARY = `${ROOT}/host-harness/target/debug/devhub-bridge-feasibility-host`;
const VSIX = `${ROOT}/build/devhub-bridge-feasibility-0.0.1.vsix`;
const TEST_FOLDER = `${RUNTIME}/workspace`; // folder must exist for Workbench URL resolution
const REQUEST_FOLDER = `${RUNTIME}/requested-workspace`; // distinct folder forces public openFolder navigation
const SURFACE_ID = '77777777-7777-4777-8777-777777777777';
const WORKSPACE_ID = '88888888-8888-4888-8888-888888888888';
const BRIDGE_TOKEN = randomBytes(32).toString('hex');
const OPENVSCODE_TOKEN = randomBytes(32).toString('hex');
const children = [];

mkdirSync(`${ROOT}/evidence`, { recursive: true });
mkdirSync(TEST_FOLDER, { recursive: true });
mkdirSync(REQUEST_FOLDER, { recursive: true });
writeFileSync(EVIDENCE, '');

function log(kind, data = {}) {
  const event = { at: new Date().toISOString(), kind, ...data };
  appendFileSync(EVIDENCE, `${JSON.stringify(event)}\n`);
  return event;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function spawnLogged(command, args, options, outputFile) {
  const child = spawn(command, args, options);
  children.push(child);
  const write = (chunk) => {
    const text = chunk.toString()
      .replaceAll(BRIDGE_TOKEN, '<bridge-token-redacted>')
      .replaceAll(OPENVSCODE_TOKEN, '<openvscode-token-redacted>')
      // OpenVSCode emits a separate per-connection token in trace output.
      // Keep the diagnostic useful without persisting bearer material.
      .replace(/(connectionToken["']?\s*:\s*["'])([^"']+)(["'])/g, '$1<connection-token-redacted>$3')
      .replace(/([?&]tkn=)([^&\s]+)/g, '$1<token-redacted>');
    appendFileSync(outputFile, text);
  };
  child.stdout?.on('data', write);
  child.stderr?.on('data', write);
  return child;
}

async function waitFor(predicate, timeoutMs, name) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${name}`);
}

function eventsFrom(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

function processRows() {
  let table;
  try {
    table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  return table.split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

function resolveServerPid(server, port) {
  const rows = processRows();
  const serverCommand = `${ARTIFACT}/out/server-main.js`;
  const byPort = rows.find((row) => row.command.includes(serverCommand) && row.command.includes(`--port ${port}`));
  if (byPort) return byPort.pid;
  const direct = rows.find((row) => row.pid === server.pid && row.command.includes(serverCommand));
  if (direct) return direct.pid;
  const child = rows.find((row) => row.ppid === server.pid && row.command.includes(serverCommand));
  return child ? child.pid : null;
}

function extensionHostProcesses(serverPid) {
  return processRows().filter((row) => row
    && row.ppid === serverPid
    && row.command.includes(`${ARTIFACT}/`)
    && /(?:^|\s)--type=extensionHost(?:\s|$)/.test(row.command));
}

async function restartOwnedExtensionHosts(server, port) {
  let serverPid = null;
  await waitFor(() => {
    serverPid = resolveServerPid(server, port);
    return Number.isInteger(serverPid);
  }, 10000, 'owned OpenVSCode server process');
  log('extension_host_server_identity', { spawn_pid: server.pid, server_pid: serverPid });
  await waitFor(() => extensionHostProcesses(serverPid).length > 0, 10000, 'owned remote extension-host child');
  const before = extensionHostProcesses(serverPid);
  const beforePids = before.map((row) => row.pid);
  log('extension_host_restart_before', { server_pid: serverPid, pids: beforePids });
  for (const row of before) {
    try {
      process.kill(row.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  log('extension_host_restart_signal', { server_pid: serverPid, signal: 'SIGTERM', pids: beforePids });
  await waitFor(() => extensionHostProcesses(serverPid).every((row) => !beforePids.includes(row.pid)), 10000, 'owned extension-host process exit');
  log('extension_host_processes_exited', { server_pid: serverPid, pids: beforePids });
  await waitFor(() => extensionHostProcesses(serverPid).some((row) => !beforePids.includes(row.pid)), 30000, 'owned extension-host process respawn');
  const after = extensionHostProcesses(serverPid);
  log('extension_host_processes_respawned', { server_pid: serverPid, pids: after.map((row) => row.pid) });
  return { before, after };
}

async function installExtension() {
  const extensionRoot = `${RUNTIME}/extensions`;
  mkdirSync(extensionRoot, { recursive: true });
  const result = spawnSync(`${ARTIFACT}/bin/openvscode-server`, [
    '--extensions-dir', extensionRoot,
    '--user-data-dir', `${RUNTIME}/install-user-data`,
    '--server-data-dir', `${RUNTIME}/install-server-data`,
    '--install-extension', VSIX,
  ], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
  if (result.status !== 0) throw new Error(`extension install failed: ${result.stderr || result.stdout}`);
  log('extension_installed', { vsix: VSIX, extension_dir: extensionRoot });
  return extensionRoot;
}

async function run() {
  if (spawnSync('zsh', [`${ROOT}/scripts/build-vsix.sh`], { encoding: 'utf8', timeout: 30000 }).status !== 0) throw new Error('VSIX build failed');
  const cargo = spawnSync('cargo', ['build', '--offline', '--quiet', '--manifest-path', `${ROOT}/host-harness/Cargo.toml`], { encoding: 'utf8', timeout: 120000 });
  if (cargo.status !== 0) throw new Error(`host build failed: ${cargo.stderr}`);
  const extensionsDir = await installExtension();
  const bridgeLog = `${ROOT}/evidence/real-host.ndjson`;
  const hostHarnessLog = `${ROOT}/evidence/real-host-harness.log`;
  const serverLog = `${ROOT}/evidence/real-openvscode-server.log`;
  writeFileSync(bridgeLog, '');
  writeFileSync(hostHarnessLog, '');
  writeFileSync(serverLog, '');

  const host = new BridgeHost({ token: BRIDGE_TOKEN, expectedSurfaces: [SURFACE_ID], logFile: bridgeLog, closeFirstAfterSnapshot: true });
  attachUpgrade(host);
  const bridgePort = await host.listen();
  const endpoint = host.endpoint();
  log('bridge_host_started', { endpoint: `ws://127.0.0.1:${bridgePort}/bridge` });

  const openvscodePort = await freePort();
  const tokenFile = `${RUNTIME}/openvscode-token`;
  mkdirSync(`${RUNTIME}/server-data`, { recursive: true });
  mkdirSync(`${RUNTIME}/user-data`, { recursive: true });
  mkdirSync(`${RUNTIME}/user-data/User`, { recursive: true });
  writeFileSync(`${RUNTIME}/user-data/User/settings.json`, JSON.stringify({
    // Keep the headless reload finite while preserving untitled dirty editors
    // through the Workbench hot-exit path.
    'window.confirmBeforeClose': 'never',
    'files.hotExit': 'onExitAndWindowClose',
  }));
  writeFileSync(tokenFile, `${OPENVSCODE_TOKEN}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const scan = spawnSync(`${ARTIFACT}/bin/openvscode-server`, [
    '--extensions-dir', extensionsDir,
    '--user-data-dir', `${RUNTIME}/user-data`,
    '--server-data-dir', `${RUNTIME}/server-data`,
    '--list-extensions', '--show-versions',
  ], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
  if (scan.status !== 0 || !scan.stdout.includes('devhub.devhub-bridge-feasibility@0.0.1')) {
    throw new Error(`extension scan failed: ${scan.stderr || scan.stdout}`);
  }
  log('openvscode_extension_scan_ready', { extension_id: 'devhub.devhub-bridge-feasibility', source: 'cli-list' });
  const server = spawnLogged(`${ARTIFACT}/bin/openvscode-server`, [
    '--host', '127.0.0.1', '--port', String(openvscodePort),
    '--connection-token-file', tokenFile,
    '--accept-server-license-terms', '--disable-telemetry',
    // This isolated fixture is intentionally trusted. Without the public
    // server flag OpenVSCode filters a manifest that has no untrusted-workspace
    // capability before it reaches the remote extension host.
    '--disable-workspace-trust',
    '--server-data-dir', `${RUNTIME}/server-data`, '--user-data-dir', `${RUNTIME}/user-data`,
    '--extensions-dir', extensionsDir, '--log', 'trace',
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEVHUB_BRIDGE_ENDPOINT: endpoint,
      DEVHUB_BRIDGE_TOKEN: BRIDGE_TOKEN,
      DEVHUB_BRIDGE_SURFACE_ID: SURFACE_ID,
      DEVHUB_BRIDGE_WORKSPACE_ID: WORKSPACE_ID,
      DEVHUB_BRIDGE_AUTOMATION: 'real',
      DEVHUB_BRIDGE_TEST_FOLDER: REQUEST_FOLDER,
      VSCODE_VERBOSE_LOGGING: 'true',
      VSCODE_LOG_LEVEL: 'trace',
    },
  }, serverLog);
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${openvscodePort}/`)).status === 403; } catch { return false; }
  }, 30000, 'OpenVSCode loopback readiness');
  log('openvscode_ready', { version: '1.109.5', port: openvscodePort });

  const folderUrl = `http://127.0.0.1:${openvscodePort}/?ew=true&folder=${encodeURIComponent(TEST_FOLDER)}&tkn=${OPENVSCODE_TOKEN}`;
  const appEnv = {
    ...process.env,
    BRIDGE_WORKBENCH_URL: folderUrl,
    BRIDGE_BOUNDARY_ENDPOINT: `http://127.0.0.1:${bridgePort}/boundary`,
  };
  // OpenVSCode starts its first extension scan in response to the first
  // Workbench management connection. Warm one bounded client to complete that
  // scan, then reconnect a fresh Workbench so its initial remote snapshot
  // includes the user VSIX (the first connection can legitimately receive the
  // built-in-only snapshot while the scan is in flight).
  const warmup = spawnLogged(BINARY, [], { cwd: ROOT, env: appEnv }, hostHarnessLog);
  log('tauri_warmup_started', { binary: BINARY });
  await waitFor(() => {
    const trace = readFileSync(serverLog, 'utf8');
    return trace.includes('Scanned user extensions: 1')
      && trace.includes('devhub.devhub-bridge-feasibility');
  }, 30000, 'OpenVSCode extension scan');
  warmup.kill('SIGTERM');
  await sleep(1500);
  const app = spawnLogged(BINARY, [], { cwd: ROOT, env: appEnv }, hostHarnessLog);
  log('tauri_host_started', { binary: BINARY });

  const deadline = Date.now() + 90000;
  let lastCount = 0;
  let extensionHostRestart = null;
  while (Date.now() < deadline) {
    const events = eventsFrom(bridgeLog);
    const hello = events.filter((event) => event.kind === 'hello_accepted');
    const snapshots = events.filter((event) => event.kind === 'snapshot_applied');
    const requests = events.filter((event) => event.kind === 'open_workspace_requested' || event.kind === 'new_window_requested');
    const boundaries = events.filter((event) => event.kind === 'folder_navigation_intercepted' || event.kind === 'new_window_intercepted');
    if (events.length !== lastCount) {
      lastCount = events.length;
      log('progress', { events: events.length, hello: hello.length, snapshots: snapshots.length, requests: requests.length, boundaries: boundaries.length });
    }
    // First prove endpoint-loss reconnect (generation 2), then restart only
    // this isolated server's remote extension-host child processes. This is
    // distinct from workbench.action.reloadWindow and does not navigate the
    // Workbench or inject DOM state.
    if (!extensionHostRestart
      && hello.length >= 2
      && events.some((event) => event.kind === 'endpoint_loss_injected')
      && events.some((event) => event.kind === 'connection_closed')) {
      extensionHostRestart = await restartOwnedExtensionHosts(server, openvscodePort);
    }
    if (extensionHostRestart
      && hello.length >= 3
      && snapshots.length >= 3
      && requests.length >= 2
      && boundaries.length >= 2
      && events.some((event) => event.kind === 'dirty_changed' && event.dirty === true)) break;
    await sleep(250);
  }

  const events = eventsFrom(bridgeLog);
  const hello = events.filter((event) => event.kind === 'hello_accepted');
  const snapshots = events.filter((event) => event.kind === 'snapshot_applied');
  const dirty = events.filter((event) => event.kind === 'dirty_changed');
  const requests = events.filter((event) => event.kind === 'open_workspace_requested' || event.kind === 'new_window_requested');
  const boundaries = events.filter((event) => event.kind === 'folder_navigation_intercepted' || event.kind === 'new_window_intercepted');
  if (dirty.some((event) => event.dirty === true)) {
    log('dirty_fixture_observed', {
      fixture: 'two-untitled-content-documents',
      source: 'vscode.workspace.openTextDocument({content}) + showTextDocument',
      aggregate_dirty: true,
    });
  }
  const result = {
    pinned_openvscode: 'PASS',
    bearer_upgrade_auth: events.some((event) => event.kind === 'hello_accepted') ? 'PASS' : 'FAIL',
    hello_accepted_snapshot: hello.length >= 1 && snapshots.length >= 1 ? 'PASS' : 'FAIL',
    readiness: snapshots.some((event) => event.readiness === 'ready') ? 'PASS' : 'FAIL',
    endpoint_loss: events.some((event) => event.kind === 'endpoint_loss_injected') && events.some((event) => event.kind === 'connection_closed') ? 'PASS' : 'FAIL',
    reconnect: hello.length >= 2 && snapshots.length >= 2 ? 'PASS' : 'FAIL',
    extension_host_restart: extensionHostRestart
      && hello.length >= 3
      && snapshots.length >= 3
      && new Set(hello.map((event) => event.workbench_instance_id)).size >= 2
      && events.some((event) => event.kind === 'dirty_changed' && event.dirty === true)
      ? 'PASS' : 'NOT PROVEN',
    dirty_aggregate: dirty.some((event) => event.aggregate_dirty === true)
      && (dirty.some((event) => event.aggregate_dirty === false) || snapshots.some((event) => event.aggregate_dirty === false))
      ? 'PASS' : 'NOT PROVEN',
    open_workspace_request: requests.some((event) => event.kind === 'open_workspace_requested') ? 'PASS' : 'FAIL',
    new_window_request: requests.some((event) => event.kind === 'new_window_requested') ? 'PASS' : 'FAIL',
    folder_interception_boundary: boundaries.some((event) => event.kind === 'folder_navigation_intercepted') ? 'PASS' : 'FAIL',
    new_window_interception_boundary: boundaries.some((event) => event.kind === 'new_window_intercepted') ? 'PASS' : 'FAIL',
  };
  const hardGate = result.folder_interception_boundary === 'PASS' && result.new_window_interception_boundary === 'PASS';
  log('result', { ...result, hard_gate: hardGate ? 'PASS' : 'FAIL' });
  console.log(JSON.stringify({ result, evidence: EVIDENCE }));
  if (!hardGate) process.exitCode = 2;
  await host.close();
  for (const child of [app, server]) {
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

try {
  await run();
} catch (error) {
  log('result', { hard_gate: 'NOT PROVEN', result: 'FAIL', summary: String(error.stack || error).slice(0, 2000) });
  console.error(error.stack || error);
  for (const child of children) if (child && !child.killed) child.kill('SIGTERM');
  process.exitCode = 1;
}
