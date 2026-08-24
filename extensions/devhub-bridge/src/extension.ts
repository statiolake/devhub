import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import type {
  AbsolutePath,
  Context,
  UUID,
} from "../../../apps/devhub/src/generated/bridge/index";
import {
  findSurfaceForRoot,
  normalizedAbsolutePath,
  parseSurfaceRegistry,
  type SurfaceRegistryEntry,
} from "./registry";
import { BridgeControllerCore } from "./controller";
import { parseNavigationUri } from "./navigation";
import { isSafeBearerToken, LoopbackSocket } from "./transport";

interface BridgeConfiguration {
  endpoint: string;
  token: string;
  surfaceId: string;
  workspaceId: string | null;
  registry: SurfaceRegistryEntry[];
}

interface BridgeBootstrap {
  endpoint: string;
  token: string;
}

function log(kind: string, fields: Record<string, unknown> = {}): void {
  // Diagnostics are intentionally content-free. Never add endpoint, token,
  // workspace paths, editor text, or query values to this object.
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      ["attempt", "dirty", "readiness", "reason", "source"].includes(key),
    ),
  );
  console.log(`[DEVHUB-BRIDGE] ${JSON.stringify({ kind, ...safe })}`);
}

function configuration(): BridgeBootstrap | null {
  const endpoint = process.env.DEVHUB_BRIDGE_ENDPOINT;
  const token = process.env.DEVHUB_BRIDGE_TOKEN;
  const registryPath = process.env.DEVHUB_BRIDGE_SURFACE_REGISTRY;
  if (
    !endpoint ||
    !token ||
    !registryPath ||
    !registryPath.startsWith("/") ||
    registryPath.includes("\0")
  ) {
    log("inactive_missing_configuration");
    return null;
  }
  if (!isSafeBearerToken(token)) {
    log("inactive_invalid_configuration");
    return null;
  }
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
      throw new Error("invalid endpoint");
  } catch {
    log("inactive_invalid_configuration");
    return null;
  }
  // IDs are intentionally resolved asynchronously from the EditorHost-owned
  // registry below; the common environment carries only the registry path.
  return { endpoint, token };
}

async function readSurfaceRegistry(): Promise<SurfaceRegistryEntry[] | null> {
  const registryPath = process.env.DEVHUB_BRIDGE_SURFACE_REGISTRY;
  if (
    !registryPath ||
    !registryPath.startsWith("/") ||
    registryPath.includes("\0")
  )
    return null;
  try {
    const bytes = await readFile(registryPath);
    return parseSurfaceRegistry(bytes);
  } catch {
    return null;
  }
}

async function resolveConfiguration(): Promise<BridgeConfiguration | null> {
  const base = configuration();
  if (!base) return null;
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) return null;
  const root = vscode.workspace.workspaceFolders?.[0]
    ? filePath(vscode.workspace.workspaceFolders[0].uri)
    : null;
  const entries = await readSurfaceRegistry();
  if (!entries) return null;
  const match = findSurfaceForRoot(entries, root);
  if (!match) return null;
  return {
    ...base,
    surfaceId: match.surface_id,
    workspaceId: match.workspace_id,
    registry: entries,
  };
}

function filePath(uri: vscode.Uri): string | null {
  // Browser Workbench sessions expose workspace folders through the remote
  // authority even though the underlying filesystem is local. The official
  // `code serve-web` provider uses `vscode-remote`; OpenVSCode may expose
  // `file` in its embedded configuration. Both are public URI schemes for
  // this provider, and both still pass through the owner-canonical registry.
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
      log,
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

export function activate(context: vscode.ExtensionContext): void {
  void resolveConfiguration()
    .then((config) => {
      if (!config) return;
      try {
        install(context, config);
        log("activated");
      } catch {
        log("inactive_startup_failure");
      }
    })
    .catch(() => log("inactive_startup_failure"));
}

export function deactivate(): void {
  // The disposable registered by activate closes the transport. No provider
  // process or editor resource is owned by this extension.
}
