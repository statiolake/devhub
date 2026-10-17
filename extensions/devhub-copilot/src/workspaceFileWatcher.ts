import * as vscode from "vscode";
import type {
  LspDidChangeWatchedFilesRegistrationOptions,
  LspFileSystemWatcher,
  LspRegistration,
  LspUnregistration,
  LspWatchedFileChange,
} from "./lspTypes";

const WATCH_CREATE = 1;
const WATCH_CHANGE = 2;
const WATCH_DELETE = 4;

/**
 * Bridges LSP dynamic file-watch registrations to VS Code's public watcher
 * API. This keeps workspace indexing useful without making the LSP client
 * depend on VS Code.
 */
export class WorkspaceFileWatcher implements vscode.Disposable {
  private readonly registrations = new Map<string, vscode.Disposable>();
  private readonly workspaceWatchers = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private started = false;
  private disposed = false;

  public constructor(
    private readonly notify: (
      workspaceUri: string,
      changes: LspWatchedFileChange[],
    ) => void,
    private readonly log: (message: string) => void,
  ) {}

  /** Start the broad workspace watcher used by the Copilot custom watcher. */
  public start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        this.refreshWorkspaceWatchers(),
      ),
    );
    this.refreshWorkspaceWatchers();
  }

  public register(registrations: LspRegistration[]): void {
    for (const registration of registrations) {
      if (registration.method !== "workspace/didChangeWatchedFiles") {
        continue;
      }
      this.unregister([
        {
          id: registration.id,
          method: registration.method,
        },
      ]);

      const options = isWatcherOptions(registration.registerOptions)
        ? registration.registerOptions
        : { watchers: [] };
      const watcherDisposables = (options.watchers ?? [])
        .map((watcher) => this.createWatcher(watcher))
        .filter(
          (watcher): watcher is vscode.Disposable => watcher !== undefined,
        );

      this.registrations.set(
        registration.id,
        new vscode.Disposable(() => {
          for (const watcher of watcherDisposables) {
            watcher.dispose();
          }
        }),
      );
      this.log(
        `Registered ${watcherDisposables.length} Language Server file watcher(s).`,
      );
    }
  }

  public unregister(unregistrations: LspUnregistration[]): void {
    for (const unregistration of unregistrations) {
      if (unregistration.method !== "workspace/didChangeWatchedFiles") {
        continue;
      }
      this.registrations.get(unregistration.id)?.dispose();
      this.registrations.delete(unregistration.id);
    }
  }

  public reset(): void {
    if (this.disposed) {
      return;
    }
    for (const registration of this.registrations.values()) {
      registration.dispose();
    }
    this.registrations.clear();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.reset();
    for (const watcher of this.workspaceWatchers.values()) {
      watcher.dispose();
    }
    this.workspaceWatchers.clear();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.disposed = true;
  }

  private refreshWorkspaceWatchers(): void {
    if (this.disposed) {
      return;
    }
    for (const watcher of this.workspaceWatchers.values()) {
      watcher.dispose();
    }
    this.workspaceWatchers.clear();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const workspaceUri = folder.uri.toString();
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder.uri, "**/*"),
        );
        const disposables: vscode.Disposable[] = [watcher];
        disposables.push(
          watcher.onDidCreate((uri) =>
            this.notifyWorkspaceChange(workspaceUri, uri, 1),
          ),
          watcher.onDidChange((uri) =>
            this.notifyWorkspaceChange(workspaceUri, uri, 2),
          ),
          watcher.onDidDelete((uri) =>
            this.notifyWorkspaceChange(workspaceUri, uri, 3),
          ),
        );
        this.workspaceWatchers.set(
          workspaceUri,
          new vscode.Disposable(() => {
            for (const disposable of disposables) {
              disposable.dispose();
            }
          }),
        );
      } catch (error) {
        this.log(
          `Could not create workspace file watcher: ${formatError(error)}`,
        );
      }
    }
  }

  private createWatcher(
    watcher: LspFileSystemWatcher,
  ): vscode.Disposable | undefined {
    if (this.disposed || !isValidWatcher(watcher)) {
      return undefined;
    }

    const kind = watcher.kind ?? WATCH_CREATE | WATCH_CHANGE | WATCH_DELETE;
    try {
      const globPattern = toVscodeGlobPattern(watcher.globPattern);
      const fileWatcher = vscode.workspace.createFileSystemWatcher(globPattern);
      const disposables: vscode.Disposable[] = [fileWatcher];
      if ((kind & WATCH_CREATE) !== 0) {
        disposables.push(
          fileWatcher.onDidCreate((uri) => this.notifyChange(uri, 1)),
        );
      }
      if ((kind & WATCH_CHANGE) !== 0) {
        disposables.push(
          fileWatcher.onDidChange((uri) => this.notifyChange(uri, 2)),
        );
      }
      if ((kind & WATCH_DELETE) !== 0) {
        disposables.push(
          fileWatcher.onDidDelete((uri) => this.notifyChange(uri, 3)),
        );
      }
      return new vscode.Disposable(() => {
        for (const disposable of disposables) {
          disposable.dispose();
        }
      });
    } catch (error) {
      this.log(
        `Could not create Language Server file watcher: ${formatError(error)}`,
      );
      return undefined;
    }
  }

  private notifyChange(uri: vscode.Uri, type: 1 | 2 | 3): void {
    if (this.disposed) {
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder !== undefined) {
      this.notifyWorkspaceChange(folder.uri.toString(), uri, type);
    }
  }

  private notifyWorkspaceChange(
    workspaceUri: string,
    uri: vscode.Uri,
    type: 1 | 2 | 3,
  ): void {
    if (this.disposed || isIgnoredWorkspaceFile(uri)) {
      return;
    }
    this.notify(workspaceUri, [{ uri: uri.toString(), type }]);
  }
}

function isIgnoredWorkspaceFile(uri: vscode.Uri): boolean {
  const relativePath = vscode.workspace.asRelativePath(uri, false);
  return (
    relativePath === ".git" ||
    relativePath.startsWith(".git/") ||
    relativePath === "node_modules" ||
    relativePath.startsWith("node_modules/")
  );
}

function isWatcherOptions(
  value: unknown,
): value is LspDidChangeWatchedFilesRegistrationOptions {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { watchers?: unknown }).watchers) &&
    (value as { watchers: unknown[] }).watchers.every(isValidWatcher)
  );
}

function isValidWatcher(value: unknown): value is LspFileSystemWatcher {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const watcher = value as LspFileSystemWatcher;
  const pattern = watcher.globPattern;
  const validPattern =
    typeof pattern === "string" ||
    (pattern !== null &&
      typeof pattern === "object" &&
      typeof pattern.pattern === "string");
  return (
    validPattern &&
    (watcher.kind === undefined || Number.isInteger(watcher.kind))
  );
}

function toVscodeGlobPattern(
  pattern: LspFileSystemWatcher["globPattern"],
): vscode.GlobPattern {
  if (typeof pattern === "string") {
    return pattern;
  }
  if (pattern.baseUri === undefined) {
    return pattern.pattern;
  }
  return new vscode.RelativePattern(
    vscode.Uri.parse(pattern.baseUri),
    pattern.pattern,
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
