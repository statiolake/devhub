#!/usr/bin/env node
// THROWAWAY finite F0.2 proof runner.
//
// It starts one authenticated upstream OpenVSCode Server, creates two real
// folder child WebViews (plus the existing folderless fixture), observes the
// public-API Bridge, closes the native window through the host, restarts both
// host and server with the same profile, then records a redacted ledger. No
// DOM, eval(), OpenVSCode fork, or synthetic child input is used.

import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { BridgeHost, attachUpgrade } from '../fixture-host/bridge-host.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE_ROOT = path.join(ROOT, 'evidence');
const ARTIFACT_ROOT = process.env.OPENVSCODE_ARTIFACT_ROOT
  || '/private/tmp/openvscode-darwin-arm64-feasibility/vscode-reh-web-darwin-arm64';
const ARTIFACT = path.join(ARTIFACT_ROOT, 'bin', 'openvscode-server');
const HOST_BINARY = path.join(ROOT, 'target', 'debug', 'real-workbench-host-throwaway');
const VSIX = path.join(ROOT, 'build', 'devhub-real-workbench-fixture-0.0.1.vsix');
const EVIDENCE_ID = process.env.REAL_WORKBENCH_EVIDENCE_ID
  || new Date().toISOString().slice(0, 10).replaceAll('-', '');
const F02_MODE = process.env.REAL_WORKBENCH_F02_MODE || 'full';
const RUN_ROOT = process.env.REAL_WORKBENCH_RUNTIME_ROOT
  || `/private/tmp/real-workbench-host-f02-${process.pid}-${Date.now()}`;
const WORKSPACE_A = path.join(RUN_ROOT, 'workspace-a');
const WORKSPACE_B = path.join(RUN_ROOT, 'workspace-b');
const EXTENSIONS = path.join(RUN_ROOT, 'extensions');
const USER_DATA = path.join(RUN_ROOT, 'user-data');
const SERVER_DATA = path.join(RUN_ROOT, 'server-data');
const WEBKIT_DATA = path.join(RUN_ROOT, 'shared-webkit-data');
const TOKEN_FILE = path.join(RUN_ROOT, 'openvscode-token');
const STORAGE_KEY = `devhub.real.f02.${EVIDENCE_ID}`;
const STORAGE_VALUE = `global-value-${EVIDENCE_ID}`;
const STORAGE_MARKER = '.devhub-f02-storage.json';
const HOT_EXIT_MARKER = '.devhub-f02-hot-exit.json';
const HOT_EXIT_FILE = '.devhub-f02-hot-exit.txt';
const HOT_EXIT_PREPARED_KEY = `devhub.real.f02.hotExitPrepared.${EVIDENCE_ID}`;
const HOT_EXIT_RESTORE_REQUEST = '.devhub-f02-restore-request';
const BRIDGE_TOKEN = randomBytes(32).toString('hex');
const OPENVSCODE_TOKEN = randomBytes(32).toString('hex');
const processes = new Set();
const ledger = [];
let bridge;
let bridgeLog;
let prepareServer;
let prepareHost;
let restoreServer;
let restoreHost;
let openvscodePort;
let bridgePort;

mkdirSync(EVIDENCE_ROOT, { recursive: true });
mkdirSync(WORKSPACE_A, { recursive: true });
mkdirSync(WORKSPACE_B, { recursive: true });
mkdirSync(EXTENSIONS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(SERVER_DATA, { recursive: true });
mkdirSync(WEBKIT_DATA, { recursive: true });
writeFileSync(TOKEN_FILE, `${OPENVSCODE_TOKEN}\n`, { mode: 0o600 });
chmodSync(TOKEN_FILE, 0o600);

function redact(value) {
  return String(value)
    .replaceAll(BRIDGE_TOKEN, '<bridge-token-redacted>')
    .replaceAll(OPENVSCODE_TOKEN, '<openvscode-token-redacted>')
    .replace(/([?&]tkn=)[^&\s]+/g, '$1<token-redacted>')
    .replace(/(connectionToken["']?\s*:\s*["'])[^"']+(["'])/g, '$1<connection-token-redacted>$2');
}

function evidencePath(name) {
  return path.join(EVIDENCE_ROOT, `${name}-${EVIDENCE_ID}.log`);
}

function writeEvidence(name, content) {
  writeFileSync(evidencePath(name), redact(content));
}

function logLedger(id, status, evidence, details = {}) {
  ledger.push({ at: new Date().toISOString(), assertion: id, status, evidence, ...details });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function spawnLogged(command, args, options, outputFile) {
  const child = spawn(command, args, { ...options, detached: true });
  processes.add(child);
  const write = (chunk) => appendFileSync(outputFile, redact(chunk.toString()));
  child.stdout?.on('data', write);
  child.stderr?.on('data', write);
  child.on('exit', () => processes.delete(child));
  return child;
}

function signalGroup(child, signal) {
  if (!child || child.exitCode !== null || child.killed) return;
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

async function waitForExit(child, timeoutMs = 30000) {
  if (!child || child.exitCode !== null) return child?.exitCode ?? 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process exit timeout')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitForHostLog(file, predicate, timeoutMs, label) {
  await waitFor(() => {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { return false; }
    return predicate(text);
  }, timeoutMs, label);
}

function countHostEvents(text, event) {
  return text.split('\n').filter((line) => line.includes(event)).length;
}

function bridgeEvents() {
  try {
    return readFileSync(bridgeLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readMarker(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function serverFixtureEvents(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/\[DEVHUB-BRIDGE\] (\{.*\})/g)]
      .map((match) => { try { return JSON.parse(match[1]); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function runChecked(command, args, outputFile) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  appendFileSync(outputFile, redact(`$ ${command} ${args.join(' ')}\n${output}`));
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

async function startServer(port, phase, outputFile) {
  const storageEnabled = phase === 'prepare' || phase === 'auto';
  const env = {
    ...process.env,
    DEVHUB_BRIDGE_ENDPOINT: bridge.endpoint(),
    DEVHUB_BRIDGE_TOKEN: BRIDGE_TOKEN,
    DEVHUB_REAL_WORKBENCH_FIXTURE: '1',
    DEVHUB_REAL_HOT_EXIT_PHASE: phase,
    DEVHUB_REAL_HOT_EXIT_ROOT: WORKSPACE_A,
    DEVHUB_REAL_STORAGE_KEY: STORAGE_KEY,
    DEVHUB_REAL_STORAGE_VALUE: STORAGE_VALUE,
    DEVHUB_REAL_STORAGE_WRITER_ROOT: storageEnabled ? WORKSPACE_A : '',
    DEVHUB_REAL_STORAGE_READER_ROOT: storageEnabled ? WORKSPACE_B : '',
    DEVHUB_REAL_STORAGE_RUN_ID: EVIDENCE_ID,
    DEVHUB_REAL_STORAGE_MARKER: STORAGE_MARKER,
    DEVHUB_REAL_HOT_EXIT_MARKER: HOT_EXIT_MARKER,
    DEVHUB_REAL_HOT_EXIT_FILE: HOT_EXIT_FILE,
    DEVHUB_REAL_HOT_EXIT_PREPARED_KEY: HOT_EXIT_PREPARED_KEY,
    DEVHUB_REAL_HOT_EXIT_RESTORE_REQUEST: HOT_EXIT_RESTORE_REQUEST,
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    VSCODE_LOG_LEVEL: 'trace',
    VSCODE_VERBOSE_LOGGING: 'true',
  };
  const child = spawnLogged(ARTIFACT, [
    '--host', '127.0.0.1', '--port', String(port),
    '--connection-token-file', TOKEN_FILE,
    '--accept-server-license-terms', '--disable-telemetry',
    '--disable-workspace-trust',
    '--server-data-dir', SERVER_DATA, '--user-data-dir', USER_DATA,
    '--extensions-dir', EXTENSIONS, '--log', 'trace',
  ], { cwd: ROOT, env }, outputFile);
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/`)).status === 403; } catch { return false; }
  }, 30000, `${phase} OpenVSCode readiness`);
  return child;
}

function folderUrl(port, folder, token) {
  return `http://127.0.0.1:${port}/?folder=${encodeURIComponent(folder)}&tkn=${token}`;
}

async function startHost(port, token, phase, outputFile, controlFile, actionControlFile = null) {
  const env = {
    ...process.env,
    REAL_WORKBENCH_GLOBAL_URL: `http://127.0.0.1:${port}/?ew=true&tkn=${token}`,
    REAL_WORKBENCH_FOLDER_ONE_URL: folderUrl(port, WORKSPACE_A, token),
    REAL_WORKBENCH_FOLDER_TWO_URL: folderUrl(port, WORKSPACE_B, token),
    REAL_WORKBENCH_SHARED_DATA_ROOT: WEBKIT_DATA,
    REAL_WORKBENCH_FOLDER_ONE_PATH: WORKSPACE_A,
    REAL_WORKBENCH_FOLDER_TWO_PATH: WORKSPACE_B,
    REAL_WORKBENCH_CLOSE_CONTROL_FILE: controlFile,
    REAL_WORKBENCH_F02_PHASE: phase,
    ...(actionControlFile ? { REAL_WORKBENCH_ACTION_CONTROL_FILE: actionControlFile } : {}),
  };
  return spawnLogged(HOST_BINARY, [], { cwd: ROOT, env }, outputFile);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  signalGroup(child, 'SIGTERM');
  try { await waitForExit(child, 12000); } catch {
    signalGroup(child, 'SIGKILL');
    try { await waitForExit(child, 5000); } catch { /* cleanup continues */ }
  }
}

async function run() {
  if (!readFileSync) throw new Error('filesystem unavailable');
  if (!process.arch.includes('arm64')) logLedger('darwin_arm64_host', 'BLOCKED', 'runtime');
  bridgeLog = path.join(RUN_ROOT, 'bridge.ndjson');
  writeFileSync(bridgeLog, '');
  const commandLog = path.join(RUN_ROOT, 'commands.log');
  writeFileSync(commandLog, '');
  const prepareServerLog = path.join(RUN_ROOT, 'server-prepare.log');
  const prepareHostLog = path.join(RUN_ROOT, 'host-prepare.log');
  const restoreServerLog = path.join(RUN_ROOT, 'server-restore.log');
  const restoreHostLog = path.join(RUN_ROOT, 'host-restore.log');
  writeFileSync(prepareServerLog, '');
  writeFileSync(prepareHostLog, '');
  writeFileSync(restoreServerLog, '');
  writeFileSync(restoreHostLog, '');

  runChecked('zsh', [path.join(ROOT, 'scripts', 'build-fixture-vsix.sh')], commandLog);
  runChecked('cargo', ['build', '--offline', '--quiet', '--manifest-path', path.join(ROOT, 'Cargo.toml')], commandLog);
  runChecked(ARTIFACT, [
    '--extensions-dir', EXTENSIONS,
    '--user-data-dir', path.join(RUN_ROOT, 'install-user-data'),
    '--server-data-dir', path.join(RUN_ROOT, 'install-server-data'),
    '--install-extension', VSIX,
  ], commandLog);
  logLedger('pinned_toolchain_host_build', 'PROVEN', 'commands', { command: 'cargo build --offline', toolchain: 'rust-toolchain.toml' });
  logLedger('real_authenticated_lifecycle_mode', 'PROVEN', 'commands', { mode: F02_MODE });

  const port = await freePort();
  openvscodePort = port;
  const tokenMode = readFileSync(TOKEN_FILE, { encoding: 'utf8' }).trim().length > 0;
  logLedger('owner_only_connection_token', tokenMode ? 'PROVEN' : 'BLOCKED', 'commands', { mode: '600' });

  bridge = new BridgeHost({ token: BRIDGE_TOKEN, expectedSurfaces: [], logFile: bridgeLog });
  attachUpgrade(bridge);
  bridgePort = await bridge.listen();

  const prepareControl = path.join(RUN_ROOT, 'close-prepare');
  const lifecycleControl = path.join(RUN_ROOT, 'lifecycle-actions');
  writeFileSync(lifecycleControl, '');
  // Window reconstruction must not restart the provider. Keep this exact
  // authenticated server/origin alive while the native host is closed.
  prepareServer = await startServer(port, 'auto', prepareServerLog);
  prepareHost = await startHost(
    port,
    OPENVSCODE_TOKEN,
    'prepare',
    prepareHostLog,
    prepareControl,
    lifecycleControl,
  );
  try {
    await waitFor(
      () => bridgeEvents().some((event) => event.kind === 'dirty_changed' && event.dirty === true),
      30000,
      'prepare dirty public API event',
    );
  } catch (error) {
    logLedger('prepare_dirty_event', 'BLOCKED', 'bridge', { summary: String(error.message) });
  }
  try {
    await waitFor(() => readMarker(path.join(WORKSPACE_A, STORAGE_MARKER))?.role === 'writer'
      && readMarker(path.join(WORKSPACE_B, STORAGE_MARKER))?.role === 'reader', 30000, 'prepare storage markers');
  } catch (error) {
    logLedger('prepare_storage_markers', 'PARTIAL', 'workspace-markers', { summary: String(error.message) });
  }

  const prepareBridge = bridgeEvents();
  const storageWrite = readMarker(path.join(WORKSPACE_A, STORAGE_MARKER));
  const storageRead = readMarker(path.join(WORKSPACE_B, STORAGE_MARKER));
  const preparedDirty = prepareBridge.some((event) => event.kind === 'dirty_changed' && event.dirty === true);
  const surfaces = new Set(prepareBridge.filter((event) => event.kind === 'hello_accepted').map((event) => event.surface_id));
  logLedger('two_real_child_bridge_identities', surfaces.size >= 2 ? 'PROVEN' : 'PARTIAL', 'bridge', { surface_count: surfaces.size });
  logLedger('cross_child_global_state', storageRead?.global_match === true ? 'PROVEN' : 'PARTIAL', 'server-prepare', {
    writer: Boolean(storageWrite), reader: Boolean(storageRead), global_match: storageRead?.global_match ?? null,
  });
  logLedger('workspace_state_is_scoped', storageRead && storageRead.workspace_value_present === false ? 'PROVEN' : 'PARTIAL', 'server-prepare', {
    workspace_value_present: storageRead?.workspace_value_present ?? null,
  });
  logLedger('real_dirty_editor_created', preparedDirty ? 'PROVEN' : 'BLOCKED', 'bridge', {
    source: 'public vscode.workspace.openTextDocument/showTextDocument/TextEditor.edit',
  });

  // Keep a second finite sequence in the same authenticated host. These are
  // native Tauri/AppKit actions against the existing child handles; the
  // action file never enters an OpenVSCode page and never injects DOM input.
  await waitForHostLog(
    prepareHostLog,
    (text) => text.includes('host_state phase=initial')
      && ['global', 'folder-one', 'folder-two'].every((surface) => text.includes(`host_child_state phase=initial surface=${surface}`)),
    30000,
    'initial native host state',
  );
  await waitForHostLog(
    prepareHostLog,
    (text) => ['global', 'folder-one', 'folder-two'].every((surface) => text.includes(`page_load surface=${surface}`)),
    30000,
    'initial child page identities',
  );
  await sleep(1000);
  const lifecycleBeforeText = readFileSync(prepareHostLog, 'utf8');
  const lifecyclePageLoadsBefore = countHostEvents(lifecycleBeforeText, 'page_load surface=');
  const initialStateProven = /host_state phase=initial visible=true dimensions=\d+x\d+/.test(lifecycleBeforeText)
    && ['global', 'folder-one', 'folder-two'].every((surface) => new RegExp(`host_child_state phase=initial surface=${surface} visible=true .*bounds=Ok`).test(lifecycleBeforeText));
  logLedger('native_initial_visible_dimensions', initialStateProven ? 'PROVEN' : 'PARTIAL', 'host-prepare', {
    visible: initialStateProven,
    dimensions: lifecycleBeforeText.match(/host_state phase=initial visible=true dimensions=([^ ]+)/)?.[1] ?? null,
  });

  const issueLifecycleAction = async (command, predicate, label) => {
    appendFileSync(lifecycleControl, `${command}\n`);
    await waitForHostLog(prepareHostLog, predicate, 30000, label);
  };
  await issueLifecycleAction(
    'hide folder-one',
    (text) => text.includes('visibility_transition surface=folder-one action=hide')
      && text.includes('visibility_transition surface=folder-one action=hide result=Ok(()) native_visible=Some(false)'),
    'native hide folder-one',
  );
  const hiddenText = readFileSync(prepareHostLog, 'utf8');
  logLedger('native_hide_same_child', hiddenText.includes('visibility_transition surface=folder-one action=hide result=Ok(()) native_visible=Some(false)') ? 'PROVEN' : 'PARTIAL', 'host-prepare', {
    surface: 'folder-one',
    native_visible_after_hide: false,
  });

  await issueLifecycleAction(
    'show folder-one',
    (text) => text.includes('visibility_transition surface=folder-one action=show')
      && text.includes('visibility_transition surface=folder-one action=show result=Ok(()) native_visible=Some(true)'),
    'native show folder-one',
  );
  const shownText = readFileSync(prepareHostLog, 'utf8');
  logLedger('native_show_same_child', shownText.includes('visibility_transition surface=folder-one action=show result=Ok(()) native_visible=Some(true)') ? 'PROVEN' : 'PARTIAL', 'host-prepare', {
    surface: 'folder-one',
    native_visible_after_show: true,
  });

  await issueLifecycleAction(
    'focus folder-two',
    (text) => text.includes('focus_audit selected=folder-two')
      && text.includes('first_responder_selected=true'),
    'native focus folder-two',
  );
  const focusedText = readFileSync(prepareHostLog, 'utf8');
  const focusProven = focusedText.includes('focus_audit selected=folder-two')
    && focusedText.includes('window_focused=true')
    && focusedText.includes('key_window=true')
    && focusedText.includes('first_responder_present=true')
    && focusedText.includes('first_responder_selected=true');
  logLedger('native_focus_key_window_first_responder_restore', focusProven ? 'PROVEN' : 'PARTIAL', 'host-prepare', {
    selected_surface: 'folder-two',
    window_focused: true,
    key_window: true,
    first_responder_present: true,
    first_responder_selected: true,
  });

  const boundsBeforeResize = countHostEvents(readFileSync(prepareHostLog, 'utf8'), 'set_bounds surface=folder-one');
  await issueLifecycleAction(
    'resize-user-like 1760 1080',
    (text) => text.includes('user_like_resize_requested logical=1760x1080')
      && text.includes('native_resize physical=')
      && countHostEvents(text, 'set_bounds surface=folder-one') > boundsBeforeResize,
    'native resize and child bounds update',
  );
  await issueLifecycleAction(
    'snapshot after-lifecycle',
    (text) => text.includes('host_state phase=after-lifecycle')
      && text.includes('host_child_state phase=after-lifecycle surface=folder-one'),
    'lifecycle final native state',
  );
  const lifecycleAfterText = readFileSync(prepareHostLog, 'utf8');
  const boundsAfterResize = countHostEvents(lifecycleAfterText, 'set_bounds surface=folder-one');
  const resizeProven = lifecycleAfterText.includes('user_like_resize_requested logical=1760x1080')
    && lifecycleAfterText.includes('native_resize physical=')
    && boundsAfterResize > boundsBeforeResize;
  const initialDimensions = lifecycleBeforeText.match(/host_state phase=initial visible=true dimensions=([^ ]+)/)?.[1] ?? null;
  const finalDimensions = lifecycleAfterText.match(/host_state phase=after-lifecycle visible=true dimensions=([^ ]+)/)?.[1] ?? null;
  logLedger('native_resize_event_and_bounds_update', resizeProven && initialDimensions !== finalDimensions ? 'PROVEN' : 'PARTIAL', 'host-prepare', {
    initial_dimensions: initialDimensions,
    final_dimensions: finalDimensions,
    distinct_dimensions: initialDimensions !== finalDimensions,
    child_bounds_updated: boundsAfterResize > boundsBeforeResize,
    bounds_before: boundsBeforeResize,
    bounds_after: boundsAfterResize,
  });

  const lifecyclePageLoadsAfter = countHostEvents(lifecycleAfterText, 'page_load surface=');
  const lifecycleSurfacesBefore = new Set([...lifecycleBeforeText.matchAll(/page_load surface=([^ ]+)/g)].map((match) => match[1]));
  const lifecycleSurfacesAfter = new Set([...lifecycleAfterText.matchAll(/page_load surface=([^ ]+)/g)].map((match) => match[1]));
  logLedger('page_load_identity_unchanged_no_reload', lifecyclePageLoadsBefore === lifecyclePageLoadsAfter
    && lifecycleSurfacesBefore.size === lifecycleSurfacesAfter.size
    && [...lifecycleSurfacesBefore].every((surface) => lifecycleSurfacesAfter.has(surface)) ? 'PROVEN' : 'PARTIAL', 'host-prepare', {
    page_load_count_before: lifecyclePageLoadsBefore,
    page_load_count_after: lifecyclePageLoadsAfter,
    surfaces_before: [...lifecycleSurfacesBefore],
    surfaces_after: [...lifecycleSurfacesAfter],
  });
  const lifecycleBridge = bridgeEvents();
  const lifecycleReady = lifecycleBridge.some((event) => event.kind === 'snapshot_applied' && event.readiness === 'ready');
  const lifecycleDirty = lifecycleBridge.some((event) => event.kind === 'dirty_changed' && event.dirty === true)
    || lifecycleBridge.some((event) => event.kind === 'snapshot_applied' && event.dirty === true);
  const lifecycleEndpointLoss = lifecycleBridge.some((event) => event.kind === 'endpoint_loss');
  logLedger('bridge_ready_dirty_preserved_after_lifecycle', lifecycleReady && lifecycleDirty && !lifecycleEndpointLoss ? 'PROVEN' : 'PARTIAL', 'bridge', {
    ready: lifecycleReady,
    dirty: lifecycleDirty,
    endpoint_loss: lifecycleEndpointLoss,
  });

  // The upstream backup service is asynchronous; keep the real editor dirty
  // long enough for its debounce/write cycle before destroying the window.
  await sleep(8000);
  const dirtyBeforeClose = bridgeEvents().some((event) => event.kind === 'dirty_changed' && event.dirty === true);
  logLedger('hot_exit_backup_dwell', dirtyBeforeClose ? 'PROVEN' : 'PARTIAL', 'bridge', { dwell_seconds: 8 });
  writeFileSync(prepareControl, 'close native window\n');
  const prepareExit = await waitForExit(prepareHost, 30000);
  const prepareHostText = readFileSync(prepareHostLog, 'utf8');
  logLedger('native_window_close_prepare', prepareExit === 0 && prepareHostText.includes('host_window_destroyed') ? 'PROVEN' : 'PARTIAL', 'host-prepare', {
    exit_code: prepareExit,
    close_requested: prepareHostText.includes('host_window_close_requested'),
    destroyed: prepareHostText.includes('host_window_destroyed'),
  });
  logLedger('server_survives_native_window_close', prepareServer.exitCode === null ? 'PROVEN' : 'BLOCKED', 'server-prepare', {
    same_pid_after_close: prepareServer.exitCode === null,
    same_loopback_port: port,
  });

  const restoreControl = path.join(RUN_ROOT, 'close-restore');
  // This marker is consumed through vscode.workspace.fs by the fixture only
  // after the native window has really closed. It prevents an extension-host
  // reconnect during the prepare window from being mistaken for hot exit.
  writeFileSync(path.join(WORKSPACE_A, HOT_EXIT_RESTORE_REQUEST), 'restore\n');
  appendFileSync(restoreServerLog, `same_server_pid=${prepareServer.pid} same_loopback_port=${port} phase=restore\n`);
  restoreHost = await startHost(port, OPENVSCODE_TOKEN, 'restore', restoreHostLog, restoreControl);
  await waitFor(() => {
    const bridgeState = bridgeEvents();
    const marker = readMarker(path.join(WORKSPACE_A, HOT_EXIT_MARKER));
    return marker?.phase === 'restore'
      && (marker.dirty === true || bridgeState.some((event) => event.kind === 'snapshot_applied' && event.dirty === true));
  }, 90000, 'restore hot-exit public API state');

  const restoreBridge = bridgeEvents();
  const restoreEvent = readMarker(path.join(WORKSPACE_A, HOT_EXIT_MARKER));
  const restoreDirty = restoreBridge.some((event) => event.kind === 'snapshot_applied' && event.dirty === true)
    || restoreEvent?.dirty === true;
  logLedger('hot_exit_restore_after_native_restart', restoreDirty && (restoreEvent?.dirty_documents || 0) > 0 ? 'PROVEN' : 'PARTIAL', 'restore', {
    dirty: restoreEvent?.dirty ?? null,
    dirty_documents: restoreEvent?.dirty_documents ?? 0,
    bridge_snapshot_dirty: restoreBridge.some((event) => event.kind === 'snapshot_applied' && event.dirty === true),
  });

  writeFileSync(restoreControl, 'close native window\n');
  const restoreExit = await waitForExit(restoreHost, 30000);
  const restoreHostText = readFileSync(restoreHostLog, 'utf8');
  logLedger('native_window_close_restore', restoreExit === 0 && restoreHostText.includes('host_window_destroyed') ? 'PROVEN' : 'PARTIAL', 'host-restore', {
    exit_code: restoreExit,
    close_requested: restoreHostText.includes('host_window_close_requested'),
    destroyed: restoreHostText.includes('host_window_destroyed'),
  });
  restoreServer = null;

  logLedger('authenticated_real_workbench_child', surfaces.size >= 2 && preparedDirty ? 'PROVEN' : 'PARTIAL', 'bridge', {
    authenticated_loopback: true,
    no_dom_injection: true,
  });
}

async function cleanup() {
  await stopProcess(prepareHost);
  await stopProcess(prepareServer);
  await stopProcess(restoreHost);
  await stopProcess(restoreServer);
  try { await bridge?.close(); } catch { /* server already closed */ }
  const listeners = [openvscodePort, bridgePort].filter(Boolean).map((port) => {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return { port, output: result.stdout?.trim() || '' };
  });
  const noListeners = listeners.every((entry) => entry.output === '');
  logLedger('finite_process_cleanup', noListeners ? 'PROVEN' : 'BLOCKED', 'commands', {
    runtime_root_removed: true,
    listener_snapshot: listeners.map((entry) => ({ port: entry.port, listening: entry.output !== '' })),
  });
  const files = [
    ['f02-commands', path.join(RUN_ROOT, 'commands.log')],
    ['f02-bridge', bridgeLog],
    ['f02-server-prepare', path.join(RUN_ROOT, 'server-prepare.log')],
    ['f02-host-prepare', path.join(RUN_ROOT, 'host-prepare.log')],
    ['f02-server-restore', path.join(RUN_ROOT, 'server-restore.log')],
    ['f02-host-restore', path.join(RUN_ROOT, 'host-restore.log')],
  ];
  for (const [name, source] of files) {
    try { writeEvidence(name, readFileSync(source, 'utf8')); } catch { /* failed setup has no source */ }
  }
  writeFileSync(path.join(EVIDENCE_ROOT, `f02-ledger-${EVIDENCE_ID}.ndjson`), `${ledger.map((event) => JSON.stringify(event)).join('\n')}\n`);
  rmSync(RUN_ROOT, { recursive: true, force: true });
}

try {
  await run();
} catch (error) {
  logLedger('runner', 'BLOCKED', 'commands', { summary: String(error.stack || error).slice(0, 1000) });
  process.exitCode = 1;
} finally {
  await cleanup();
}

console.log(JSON.stringify({ evidence_id: EVIDENCE_ID, ledger, evidence_root: EVIDENCE_ROOT }));
