#!/usr/bin/env node
// Finite real OpenVSCode 1.109.5 + native CGEvent/IME smoke.
//
// The runner owns the server, Bridge sink, and child host. It fails closed:
// synthetic DOM events, injected observers, and an absent screenshot are
// never converted into a native Workbench PASS.

import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { NativeInputBridge, attachUpgrade } from '../host/native-input-bridge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv.includes('--ime') ? 'ime' : 'normal';
const runId = `${process.pid}-${Date.now()}`;
const runtime = process.env.REAL_WORKBENCH_NATIVE_INPUT_RUNTIME_ROOT || `/private/tmp/real-workbench-native-input-${runId}`;
const evidenceRoot = `${ROOT}/evidence`;
const evidence = `${evidenceRoot}/native-workbench-${mode}-${runId}.ndjson`;
const hostLog = `${evidenceRoot}/native-workbench-${mode}-${runId}.host.log`;
const serverLog = `${evidenceRoot}/native-workbench-${mode}-${runId}.server.log`;
const bridgeLog = `${evidenceRoot}/native-workbench-${mode}-${runId}.bridge.ndjson`;
const screenshotDir = `${evidenceRoot}/native-workbench-${mode}-${runId}-screenshots`;
const artifact = process.env.OPENVSCODE_ARTIFACT_ROOT || '/private/tmp/openvscode-darwin-arm64-feasibility/vscode-reh-web-darwin-arm64';
const openvscode = `${artifact}/bin/openvscode-server`;
const cargoBinary = `${ROOT}/target/debug/devhub-real-workbench-native-input`;
const extensionVsix = `${ROOT}/build/devhub-real-workbench-native-input-0.0.1.vsix`;
const surfaceId = '99999999-9999-4999-8999-999999999999';
const bridgeToken = randomBytes(32).toString('hex');
const openvscodeToken = randomBytes(32).toString('hex');
const children = [];
let bridge;
let openvscodePort;
let screenshotTimer;

mkdirSync(evidenceRoot, { recursive: true });
mkdirSync(runtime, { recursive: true });
mkdirSync(screenshotDir, { recursive: true });
writeFileSync(evidence, '');
writeFileSync(hostLog, '');
writeFileSync(serverLog, '');
writeFileSync(bridgeLog, '');

function log(kind, fields = {}) {
  const event = { at: new Date().toISOString(), kind, ...fields };
  appendFileSync(evidence, `${JSON.stringify(event)}\n`);
  return event;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function eventsFrom(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function redact(text) {
  return text
    .replaceAll(bridgeToken, '<bridge-token-redacted>')
    .replaceAll(openvscodeToken, '<openvscode-token-redacted>')
    .replace(/([?&]tkn=)[^&\s]+/g, '$1<token-redacted>')
    .replace(/(connectionToken["']?\s*:\s*["'])[^"']+(["'])/g, '$1<connection-token-redacted>$2');
}

function spawnLogged(command, args, options, output) {
  const child = spawn(command, args, {
    detached: process.platform !== 'win32',
    ...options,
  });
  children.push(child);
  const write = (chunk) => appendFileSync(output, redact(chunk.toString()));
  child.stdout?.on('data', write);
  child.stderr?.on('data', write);
  return child;
}

function signalChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // A process can exit between the state check and group signal. Fall
      // back to the direct child handle in that case.
    }
  }
  child.kill(signal);
}

async function waitFor(predicate, timeoutMs, name) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${name}`);
}

async function terminate(child, name) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  signalChild(child, 'SIGTERM');
  await Promise.race([once(child, 'close'), sleep(5_000)]);
  if (child.exitCode === null && !child.signalCode) signalChild(child, 'SIGKILL');
  log('process_stopped', { name });
}

function screenshotWhenCheckpoint() {
  const seen = new Set();
  screenshotTimer = setInterval(() => {
    const source = readFileSync(hostLog, 'utf8');
    for (const checkpoint of [
      'cmd-p-ui-open',
      'cmd-shift-p-ui-open',
      'after-cmd-c-public-editor-state',
      'after-cmd-v-public-editor-state',
    ]) {
      if (seen.has(checkpoint) || !source.includes(`checkpoint=${checkpoint}`)) continue;
      seen.add(checkpoint);
      const output = `${screenshotDir}/${checkpoint}.png`;
      try {
        execFileSync('/usr/sbin/screencapture', ['-x', output], { timeout: 10_000, stdio: 'ignore' });
        const bytes = statSync(output).size;
        log('screenshot_captured', { checkpoint, path: output, bytes });
      } catch (error) {
        log('screenshot_not_proven', { checkpoint, summary: String(error.message).slice(0, 256) });
      }
    }
  }, 80);
}

function build() {
  const vsix = spawnSync('zsh', [`${ROOT}/scripts/build-vsix.sh`], { encoding: 'utf8', timeout: 30_000 });
  if (vsix.status !== 0) throw new Error(`VSIX build failed: ${vsix.stderr || vsix.stdout}`);
  const cargo = spawnSync('cargo', ['build', '--offline', '--quiet', '--manifest-path', `${ROOT}/Cargo.toml`], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (cargo.status !== 0) throw new Error(`host build failed: ${cargo.stderr || cargo.stdout}`);
  log('build_ready', { cargo: cargoBinary, vsix: extensionVsix, wry_patch: '../native-key-router/vendor' });
}

async function installExtension(extensionsDir) {
  mkdirSync(extensionsDir, { recursive: true });
  const result = spawnSync(openvscode, [
    '--extensions-dir', extensionsDir,
    '--user-data-dir', `${runtime}/install-user-data`,
    '--server-data-dir', `${runtime}/install-server-data`,
    '--install-extension', extensionVsix,
  ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
  if (result.status !== 0) throw new Error(`extension install failed: ${result.stderr || result.stdout}`);
  // `--list-extensions` starts a second server-side watcher on some reference
  // Macs with a low per-process descriptor limit. The install command itself
  // is authoritative here; the Workbench extension host is the runtime scan.
  const installed = `${extensionsDir}/devhub.devhub-real-workbench-native-input-0.0.1`;
  if (!statSync(installed, { throwIfNoEntry: false })) {
    throw new Error(`extension install produced no directory: ${installed}`);
  }
  log('extension_ready', {
    extension_id: 'devhub.devhub-real-workbench-native-input',
    version: '0.0.1',
    verification: 'openvscode-install-directory',
  });
}

async function serverReady() {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${openvscodePort}/`);
      return response.status === 403;
    } catch {
      return false;
    }
  }, 45_000, 'authenticated OpenVSCode loopback server');
}

function appEnvironment(workbenchUrl, endpoint, fixturePath, selfTest) {
  const ordinarySelfTest = selfTest && mode !== 'ime';
  const environment = {
    ...process.env,
    DEVHUB_NATIVE_INPUT_WORKBENCH_URL: workbenchUrl,
    DEVHUB_NATIVE_INPUT_DATA_ROOT: `${runtime}/shared-webkit-data`,
    DEVHUB_NATIVE_INPUT_ENDPOINT: endpoint,
    DEVHUB_NATIVE_INPUT_BRIDGE_TOKEN: bridgeToken,
    DEVHUB_NATIVE_INPUT_SURFACE_ID: surfaceId,
    DEVHUB_NATIVE_INPUT_FIXTURE: fixturePath,
    DEVHUB_NATIVE_INPUT_SELF_TEST: ordinarySelfTest ? '1' : undefined,
    DEVHUB_NATIVE_INPUT_IME_TEST: mode === 'ime' && selfTest ? '1' : undefined,
  };
  if (!ordinarySelfTest) {
    delete environment.DEVHUB_NATIVE_INPUT_SELF_TEST;
  }
  if (!(mode === 'ime' && selfTest)) {
    delete environment.DEVHUB_NATIVE_INPUT_IME_TEST;
  }
  return environment;
}

function startApp(workbenchUrl, endpoint, fixturePath, selfTest) {
  return spawnLogged(cargoBinary, [], {
    cwd: ROOT,
    env: appEnvironment(workbenchUrl, endpoint, fixturePath, selfTest),
  }, hostLog);
}

function resultForNormal(hostEvents, bridgeEvents) {
  const diagnostics = bridgeEvents.filter((event) => event.kind === 'workbench_public_api_state');
  const stage = (name) => diagnostics.filter((event) => event.stage === name);
  const finalSave = stage('document_saved').find((event) => event.dirty === false && String(event.text).includes('native-paste'));
  const undo = stage('document_changed').some((event) => event.text === 'seed\n' && event.dirty === false);
  const q = stage('public_command_q_result');
  const nativeKeys = ['cmd-p', 'cmd-shift-p', 'cmd-s', 'cmd-z', 'cmd-c', 'cmd-v'];
  const keyPosts = Object.fromEntries(nativeKeys.map((key) => [key, hostEvents.some((event) => event.message?.includes(`key=${key}`))]));
  const qForward = hostEvents.filter((event) => event.message?.includes('forward native key equivalent') && event.message?.includes('synthetic_js=false'));
  const firstQConsumed = hostEvents.some((event) => event.message?.includes('prefix armed') && event.message?.includes('workbench_received=false'));
  const screenshotP = hostEvents.some((event) => event.kind === 'screenshot_captured' && event.checkpoint === 'cmd-p-ui-open');
  const screenshotShiftP = hostEvents.some((event) => event.kind === 'screenshot_captured' && event.checkpoint === 'cmd-shift-p-ui-open');
  return {
    real_workbench_child: hostEvents.some((event) => event.message?.includes('openvscode_source=upstream_pinned_1.109.5')) ? 'PASS' : 'FAIL',
    ordinary_shortcut_posts: Object.values(keyPosts).every(Boolean) ? 'PASS' : 'NOT PROVEN',
    ordinary_shortcut_result: finalSave && undo ? 'PASS' : 'NOT PROVEN',
    cmd_p_ui_screenshot: screenshotP ? 'PASS' : 'NOT PROVEN',
    cmd_shift_p_ui_screenshot: screenshotShiftP ? 'PASS' : 'NOT PROVEN',
    cmd_q_first_withheld: firstQConsumed ? 'PASS' : 'NOT PROVEN',
    cmd_q_second_native_forward: qForward.length === 1 && q.length === 1 ? 'PASS' : 'NOT PROVEN',
    cmd_q_public_command_result: q.length === 1 ? 'PASS' : 'NOT PROVEN',
    public_bridge_editor_state: diagnostics.some((event) => event.content_source === 'public-vscode-api') ? 'PASS' : 'FAIL',
    clipboard_after_cmd_c: hostEvents.some((event) => event.message?.includes('clipboard label=after-cmd-c utf8_hex=736565640a')) ? 'PASS' : 'NOT PROVEN',
  };
}

function resultForIme(hostEvents, bridgeEvents) {
  const diagnostics = bridgeEvents.filter((event) => event.kind === 'workbench_public_api_state');
  const japanese = diagnostics.some((event) => typeof event.text === 'string' && event.text.includes('にほんご'));
  const restored = hostEvents.some((event) => event.message?.includes('restored_match=true'));
  return {
    real_workbench_child: hostEvents.some((event) => event.message?.includes('openvscode_source=upstream_pinned_1.109.5')) ? 'PASS' : 'FAIL',
    tis_main_thread_selected: hostEvents.some((event) => event.message?.includes('selected TIS source_id=')) ? 'PASS' : 'NOT PROVEN',
    japanese_ime_commit: japanese ? 'PASS' : 'NOT PROVEN',
    editor_content_public_bridge: japanese ? 'PASS' : 'NOT PROVEN',
    input_source_restored: restored ? 'PASS' : 'NOT PROVEN',
  };
}

async function run() {
  if (!statSync(openvscode, { throwIfNoEntry: false })) throw new Error(`missing OpenVSCode artifact: ${openvscode}`);
  build();
  const extensionsDir = `${runtime}/extensions`;
  const workspace = `${runtime}/workspace`;
  const fixturePath = `${workspace}/native-input-fixture.txt`;
  mkdirSync(workspace, { recursive: true });
  writeFileSync(fixturePath, mode === 'ime' ? '' : 'seed\n');
  writeFileSync(`${runtime}/openvscode-token`, `${openvscodeToken}\n`, { mode: 0o600 });
  chmodSync(`${runtime}/openvscode-token`, 0o600);
  await installExtension(extensionsDir);

  bridge = new NativeInputBridge({ token: bridgeToken, surfaceId, logFile: bridgeLog });
  attachUpgrade(bridge);
  const bridgePort = await bridge.listen();
  const endpoint = bridge.endpoint();
  log('bridge_ready', { endpoint: `ws://127.0.0.1:${bridgePort}/bridge`, surface_id: surfaceId });

  openvscodePort = await freePort();
  const server = spawnLogged(openvscode, [
    '--host', '127.0.0.1',
    '--port', String(openvscodePort),
    '--connection-token-file', `${runtime}/openvscode-token`,
    '--accept-server-license-terms',
    '--disable-telemetry',
    '--disable-workspace-trust',
    '--server-data-dir', `${runtime}/server-data`,
    '--user-data-dir', `${runtime}/user-data`,
    '--extensions-dir', extensionsDir,
    '--log', 'trace',
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEVHUB_NATIVE_INPUT_ENDPOINT: endpoint,
      DEVHUB_NATIVE_INPUT_BRIDGE_TOKEN: bridgeToken,
      DEVHUB_NATIVE_INPUT_SURFACE_ID: surfaceId,
      DEVHUB_NATIVE_INPUT_FIXTURE: fixturePath,
      VSCODE_LOG_LEVEL: 'trace',
      VSCODE_VERBOSE_LOGGING: 'true',
    },
  }, serverLog);
  await serverReady();
  log('openvscode_ready', { version: '1.109.5', port: openvscodePort });

  const workbenchUrl = `http://127.0.0.1:${openvscodePort}/?ew=true&folder=${encodeURIComponent(workspace)}&tkn=${openvscodeToken}`;
  const warmup = startApp(workbenchUrl, endpoint, fixturePath, false);
  log('warmup_started');
  await waitFor(() => eventsFrom(bridgeLog).some((event) => event.kind === 'workbench_public_api_state' && event.stage === 'editor_ready'), 60_000, 'public Workbench editor readiness');
  await terminate(warmup, 'warmup');
  await sleep(1_500);
  writeFileSync(hostLog, '');
  writeFileSync(bridgeLog, '');

  const app = startApp(workbenchUrl, endpoint, fixturePath, true);
  log('native_host_started', { mode, host_binary: cargoBinary });
  screenshotWhenCheckpoint();
  const completion = mode === 'ime'
    ? () => readFileSync(hostLog, 'utf8').includes('ime self injection complete') || readFileSync(hostLog, 'utf8').includes('ime self injection BLOCKED')
    : () => readFileSync(hostLog, 'utf8').includes('self injection complete source=CGEventPostToPid');
  await waitFor(completion, mode === 'ime' ? 75_000 : 90_000, `${mode} native sequence`);
  await sleep(1_500);

  const hostLines = readFileSync(hostLog, 'utf8').split('\n').filter(Boolean);
  const hostEvents = [
    ...hostLines.map((line) => ({ kind: 'host_log', message: line })),
    ...eventsFrom(evidence),
  ];
  const bridgeEvents = eventsFrom(bridgeLog);
  const result = mode === 'ime' ? resultForIme(hostEvents, bridgeEvents) : resultForNormal(hostEvents, bridgeEvents);
  log('result', { mode, result });
  console.log(JSON.stringify({ mode, result, evidence, hostLog, bridgeLog, screenshotDir }));
  if (Object.values(result).includes('FAIL')) process.exitCode = 2;
  if (Object.values(result).includes('NOT PROVEN')) process.exitCode = 3;

  await terminate(app, 'native-host');
  await terminate(server, 'openvscode-server');
}

async function cleanup() {
  if (screenshotTimer) clearInterval(screenshotTimer);
  for (const child of children.slice().reverse()) await terminate(child, 'remaining-child');
  if (bridge) {
    await bridge.close();
    log('bridge_closed');
  }
  if (openvscodePort || bridge?.port) {
    await sleep(500);
    for (const port of [openvscodePort, bridge?.port].filter(Boolean)) {
      let listeners = '';
      try {
        listeners = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
      } catch {
        listeners = '';
      }
      log('cleanup_listener_check', { port, listener_zero: listeners.trim().length === 0 });
    }
  }
}

try {
  await run();
} catch (error) {
  log('result', { mode, result: 'NOT PROVEN', summary: String(error.stack || error).slice(0, 2000) });
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
