import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { AbsolutePath, Context, UUID } from "./generated/bridge/index";
import {
  findSurfaceForRoot,
  normalizedAbsolutePath,
  parseSurfaceRegistry,
  type SurfaceRegistryEntry,
} from "./registry";
import { BridgeControllerCore } from "./controller";
import { parseNavigationUri } from "./navigation";
import { isSafeBearerToken, LoopbackSocket } from "./transport";
import {
  describeFault,
  faultIdentity,
  faultIsTransient,
  type BridgeFault,
} from "./fault";
import { controlSocketFromGlobalStorage, requestInstall } from "./installCli";

interface BridgeConfiguration {
  endpoint: string;
  token: string;
  surfaceId: string;
  workspaceId: string | null;
  registry: SurfaceRegistryEntry[];
}

/**
 * Where a fault is said, and the only place.
 *
 * Two audiences, one value. The workbench gets a notification or a status item
 * — that is where the person is looking when the integration stops working,
 * and it is the half that was missing entirely. `console.log` stays as the
 * transcript, but it is no longer the report: in a packaged app nobody is
 * reading it, which is how "the editor integration just does not work" became
 * a sentence with no reason anywhere behind it.
 *
 * A fault that will fix itself on the next reconnect goes to the status item
 * only. One that needs a person is said out loud, once per distinct fault, so
 * a reconnect loop cannot turn the channel into noise.
 */
class FaultReporter {
  private readonly status: vscode.StatusBarItem;
  private announced: string | null = null;

  public constructor() {
    this.status = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      0,
    );
    this.status.name = "DevHub Bridge";
  }

  public report(fault: BridgeFault): void {
    const sentence = describeFault(fault);
    console.log(`[DEVHUB-BRIDGE] ${JSON.stringify(fault)}`);
    this.status.text = "$(warning) DevHub";
    this.status.tooltip = sentence;
    this.status.show();
    const identity = faultIdentity(fault);
    if (this.announced === identity) return;
    this.announced = identity;
    if (faultIsTransient(fault)) return;
    void vscode.window.showErrorMessage(sentence);
  }

  /** The Bridge is working. Nothing to say and nothing to show. */
  public clear(): void {
    this.announced = null;
    this.status.hide();
  }

  public dispose(): void {
    this.status.dispose();
  }
}

/**
 * A note about the Bridge that is not a failure.
 *
 * Kept deliberately separate from `report`: activation, and a workbench DevHub
 * did not inject a Bridge into, are the normal desktop case, and announcing
 * them would teach a person to ignore the channel that matters.
 */
function note(kind: string): void {
  console.log(`[DEVHUB-BRIDGE] ${JSON.stringify({ kind })}`);
}

/**
 * What DevHub injected, or why it cannot be used.
 *
 * Three outcomes, not two. `null` used to mean both "there is no Bridge here"
 * and "there is one and it is wrong", which is how seven distinct refusals
 * became one silent return — and the first of the two is not a failure at all:
 * the desktop app injects no endpoint, so an uninjected workbench is inactive
 * by design.
 */
type Bootstrap =
  | { readonly kind: "absent" }
  | {
      readonly kind: "ready";
      readonly endpoint: string;
      readonly token: string;
    }
  | { readonly kind: "refused"; readonly fault: BridgeFault };

function configuration(): Bootstrap {
  const endpoint = process.env.DEVHUB_BRIDGE_ENDPOINT;
  const token = process.env.DEVHUB_BRIDGE_TOKEN;
  const registryPath = process.env.DEVHUB_BRIDGE_SURFACE_REGISTRY;
  const present = [endpoint, token, registryPath].filter(
    (value) => value !== undefined && value.length > 0,
  ).length;
  if (present === 0) return { kind: "absent" };
  if (present < 3) {
    return {
      kind: "refused",
      fault: {
        kind: "config",
        variable: "DEVHUB_BRIDGE_ENDPOINT",
        refusal: "partially_injected",
      },
    };
  }
  if (
    !registryPath ||
    !registryPath.startsWith("/") ||
    registryPath.includes("\0")
  ) {
    return {
      kind: "refused",
      fault: {
        kind: "config",
        variable: "DEVHUB_BRIDGE_SURFACE_REGISTRY",
        refusal: "registry_path_unsafe",
      },
    };
  }
  if (!token || !isSafeBearerToken(token)) {
    return {
      kind: "refused",
      fault: {
        kind: "config",
        variable: "DEVHUB_BRIDGE_TOKEN",
        // Never the value. This one is a bearer token, and a diagnostic that
        // prints the credential it is complaining about is a worse failure
        // than the one it is reporting.
        refusal: "token_unsafe",
      },
    };
  }
  const badEndpoint: Bootstrap = {
    kind: "refused",
    fault: {
      kind: "config",
      variable: "DEVHUB_BRIDGE_ENDPOINT",
      refusal: "endpoint_not_loopback",
    },
  };
  if (!endpoint) return badEndpoint;
  try {
    const parsed = new URL(endpoint);
    const port = Number(parsed.port || 80);
    if (
      parsed.protocol !== "ws:" ||
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    )
      return badEndpoint;
  } catch {
    return badEndpoint;
  }
  // IDs are intentionally resolved asynchronously from the EditorHost-owned
  // registry below; the common environment carries only the registry path.
  return { kind: "ready", endpoint, token };
}

type RegistryReading =
  | { readonly kind: "entries"; readonly entries: SurfaceRegistryEntry[] }
  | { readonly kind: "refused"; readonly fault: BridgeFault };

async function readSurfaceRegistry(): Promise<RegistryReading> {
  const registryPath = process.env.DEVHUB_BRIDGE_SURFACE_REGISTRY;
  if (
    !registryPath ||
    !registryPath.startsWith("/") ||
    registryPath.includes("\0")
  ) {
    return {
      kind: "refused",
      fault: {
        kind: "config",
        variable: "DEVHUB_BRIDGE_SURFACE_REGISTRY",
        refusal: "registry_path_unsafe",
      },
    };
  }
  // Read and parse are two different things to be told, and they used to be
  // one `catch { return null }`: "DevHub did not write the file" and "DevHub
  // wrote one this Bridge does not understand" want different people looked at.
  let bytes: Buffer;
  try {
    bytes = await readFile(registryPath);
  } catch {
    return {
      kind: "refused",
      fault: { kind: "registry", refusal: "unreadable" },
    };
  }
  const entries = parseSurfaceRegistry(bytes);
  return entries
    ? { kind: "entries", entries }
    : {
        kind: "refused",
        fault: { kind: "registry", refusal: "unparsable" },
      };
}

type Resolution =
  /** No Bridge was injected into this workbench. Inactive, and correctly so. */
  | { readonly kind: "absent" }
  | { readonly kind: "ready"; readonly configuration: BridgeConfiguration }
  | { readonly kind: "refused"; readonly fault: BridgeFault };

async function resolveConfiguration(): Promise<Resolution> {
  const base = configuration();
  if (base.kind !== "ready") return base;
  const folders = vscode.workspace.workspaceFolders?.length ?? 0;
  if (folders > 1) {
    return { kind: "refused", fault: { kind: "surface", folders } };
  }
  const root = vscode.workspace.workspaceFolders?.[0]
    ? filePath(vscode.workspace.workspaceFolders[0].uri)
    : null;
  const registry = await readSurfaceRegistry();
  if (registry.kind === "refused") return registry;
  const match = findSurfaceForRoot(registry.entries, root);
  if (!match) {
    return { kind: "refused", fault: { kind: "surface", folders } };
  }
  return {
    kind: "ready",
    configuration: {
      endpoint: base.endpoint,
      token: base.token,
      surfaceId: match.surface_id,
      workspaceId: match.workspace_id,
      registry: registry.entries,
    },
  };
}

function filePath(uri: vscode.Uri): string | null {
  // Browser Workbench sessions expose workspace folders through the remote
  // authority even though the underlying filesystem is local. `code
  // serve-web` uses `vscode-remote`; `file` still appears for folderless and
  // locally resolved sessions. Both are public URI schemes, and both still
  // pass through the owner-canonical registry.
  if (!uri || !["file", "vscode-remote"].includes(uri.scheme)) return null;
  return normalizedAbsolutePath(uri.fsPath);
}

function contextForWorkspace(
  workspaceId: string | null,
  registry: SurfaceRegistryEntry[],
): Context | null {
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) return null;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    const globals = registry.filter(
      (entry) => entry.workspace_id === null && entry.canonical_root === null,
    );
    return globals.length === 1 && workspaceId === null
      ? { kind: "global" }
      : null;
  }
  const root = filePath(folder.uri);
  if (!root) return null;
  const entry = registry.find(
    (candidate) =>
      candidate.workspace_id !== null && candidate.canonical_root === root,
  );
  if (!entry || entry.workspace_id !== workspaceId) return null;
  return {
    kind: "workspace",
    workspace_id: workspaceId as UUID,
    canonical_root: root as AbsolutePath,
  };
}

function install(
  context: vscode.ExtensionContext,
  configurationValue: BridgeConfiguration,
  reporter: FaultReporter,
): BridgeControllerCore {
  const controller = new BridgeControllerCore(
    {
      endpoint: configurationValue.endpoint,
      token: configurationValue.token,
      surfaceId: configurationValue.surfaceId,
      extensionVersion: "0.1.0",
      workbenchInstanceId: randomUUID(),
      createMessageId: randomUUID,
    },
    {
      createSocket: (endpoint, token, handlers) =>
        new LoopbackSocket(endpoint, token, handlers),
      context: () =>
        contextForWorkspace(
          configurationValue.workspaceId,
          configurationValue.registry,
        ),
      dirty: () =>
        vscode.workspace.textDocuments.some(
          (document: vscode.TextDocument) => document.isDirty === true,
        ),
      log: (kind, fields) => {
        console.log(`[DEVHUB-BRIDGE] ${JSON.stringify({ kind, ...fields })}`);
      },
      report: (fault) => {
        reporter.report(fault);
      },
    },
  );
  const update = () => {
    controller.observeDirty();
    controller.observeWorkspace();
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(update),
    vscode.workspace.onDidCloseTextDocument(update),
    vscode.workspace.onDidChangeTextDocument(update),
    vscode.workspace.onDidSaveTextDocument(update),
    vscode.workspace.onDidChangeWorkspaceFolders(update),
    vscode.commands.registerCommand(
      "devhub.bridge.openFolder",
      (uri: vscode.Uri) => {
        const path = filePath(uri);
        if (path) controller.openFolder(path);
      },
    ),
    vscode.commands.registerCommand(
      "devhub.bridge.newWindow",
      (uri: vscode.Uri | null = null) => {
        const path = uri ? filePath(uri) : null;
        if (uri && !path) return;
        controller.newWindow(path);
      },
    ),
    vscode.window.registerUriHandler({
      handleUri: (uri: vscode.Uri) => {
        const request = parseNavigationUri(uri, vscode.env.uriScheme);
        if (!request) return;
        if (request.kind === "open_workspace")
          controller.openWorkspace(request.path, "external_uri");
        else controller.newWindow(request.path);
      },
    }),
    { dispose: () => controller.stop() },
  );
  controller.start();
  return controller;
}

/**
 * The palette command that puts `devhub` on the PATH.
 *
 * Registered unconditionally, unlike everything else in this extension: the
 * bridge transport only comes up when a Web Workbench handed it an endpoint,
 * and this command has nothing to do with that. It works wherever DevHub is
 * the host, which is the only place this extension is built in.
 *
 * Nothing is caught: a failure to reach DevHub or to write the launcher is the
 * answer to the command and is shown as an error, not logged and shrugged off.
 */
function installCliCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand("devhub.installCli", async () => {
    const socketPath = controlSocketFromGlobalStorage(
      context.globalStorageUri.fsPath,
    );
    if (!socketPath) {
      await vscode.window.showErrorMessage(
        "This workbench is not running inside DevHub, so there is no DevHub to install a command for.",
      );
      return;
    }
    const answer = await requestInstall(socketPath);
    if (answer.ok) {
      await vscode.window.showInformationMessage(answer.message);
    } else {
      await vscode.window.showErrorMessage(answer.message);
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(installCliCommand(context));
  const reporter = new FaultReporter();
  context.subscriptions.push({
    dispose: () => {
      reporter.dispose();
    },
  });
  void resolveConfiguration()
    .then((resolution) => {
      if (resolution.kind === "absent") {
        note("inactive_no_bridge_injected");
        return;
      }
      if (resolution.kind === "refused") {
        reporter.report(resolution.fault);
        return;
      }
      try {
        install(context, resolution.configuration, reporter);
        reporter.clear();
        note("activated");
      } catch (error) {
        reporter.report({
          kind: "startup",
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    })
    .catch((error: unknown) => {
      reporter.report({
        kind: "startup",
        reason: error instanceof Error ? error.message : "unknown",
      });
    });
}

export function deactivate(): void {
  // The disposable registered by activate closes the transport. No provider
  // process or editor resource is owned by this extension.
}
