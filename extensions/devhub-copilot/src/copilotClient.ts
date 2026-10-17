import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcConnection, type CancellationTokenLike } from "./jsonRpc";
import type {
  LspCheckStatusResponse,
  LspCommand,
  LspConfigurationItem,
  LspInlineCompletionItem,
  LspInlineCompletionList,
  LspInlineCompletionParams,
  LspMessageActionItem,
  LspServerCommandRequest,
  LspShowDocumentParams,
  LspShowMessageRequestParams,
  LspSignInResponse,
  LspStatus,
  LspNextEdit,
  LspNextEditParams,
  LspNextEditResponse,
  LspRegistration,
  LspUnregistration,
  LspWatchedFileChange,
  LspWatchedFilesRequestParams,
  LspWatchedFilesResponse,
  LspTextDocumentContentChangeEvent,
  LspTextDocumentItem,
  LspTextDocumentIdentifier,
  LspWorkspaceFolder,
  LspWorkspaceConfigurationParams,
} from "./lspTypes";
import { parseCopilotQuota, type CopilotQuota } from "./quota";
import { redactLogMessage, redactSecrets } from "./redaction";
import {
  launchLanguageServer,
  type LanguageServerLaunch,
} from "./serverLauncher";

export interface CopilotClientConfiguration {
  [key: string]: unknown;
  http?: {
    proxy?: string;
    proxyStrictSSL?: boolean;
    proxyKerberosServicePrincipal?: string;
  };
  telemetry?: {
    telemetryLevel?: string;
  };
  "github-enterprise"?: {
    uri?: string;
  };
}

export interface CopilotClientStatus {
  busy: boolean;
  message: string;
  kind: string;
  command?: LspCommand;
}

export interface CopilotClientHandlers {
  onStatus?: (status: CopilotClientStatus) => void;
  onLog?: (message: string) => void;
  onShowDocument?: (params: LspShowDocumentParams) => Promise<boolean>;
  onShowMessageRequest?: (
    params: LspShowMessageRequestParams,
  ) => Promise<LspMessageActionItem | null>;
  onShowMessage?: (params: LspShowMessageRequestParams) => void;
  onConfigurationRequest?: (
    items: LspConfigurationItem[],
  ) => Promise<unknown[]>;
  onRegisterCapability?: (
    registrations: LspRegistration[],
  ) => Promise<void> | void;
  onUnregisterCapability?: (
    unregistrations: LspUnregistration[],
  ) => Promise<void> | void;
  onWatchedFilesRequest?: (
    params: LspWatchedFilesRequestParams,
  ) => Promise<LspWatchedFilesResponse> | LspWatchedFilesResponse;
  onProcessExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  isDebugLoggingEnabled?: () => boolean;
}

export interface CopilotClientStartOptions {
  launch: LanguageServerLaunch;
  workspaceFolders: LspWorkspaceFolder[];
  workspaceRoot?: string;
  vscodeVersion: string;
  extensionVersion: string;
  configuration: CopilotClientConfiguration;
}

export class CopilotLspClient {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: JsonRpcConnection;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private workspaceFolders: LspWorkspaceFolder[] = [];
  private initialized = false;
  private stopping = false;
  private handlers: CopilotClientHandlers;

  public constructor(handlers: CopilotClientHandlers = {}) {
    this.handlers = handlers;
  }

  public setHandlers(handlers: CopilotClientHandlers): void {
    this.handlers = handlers;
  }

  public get isReady(): boolean {
    return this.initialized && this.connection !== undefined;
  }

  public async start(options: CopilotClientStartOptions): Promise<void> {
    if (this.isReady) {
      return;
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal(options).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  public async stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  public async restart(options: CopilotClientStartOptions): Promise<void> {
    await this.stop();
    await this.start(options);
  }

  public notifyDocumentOpened(document: LspTextDocumentItem): void {
    this.connection?.notify("textDocument/didOpen", { textDocument: document });
  }

  public notifyDocumentChanged(
    document: LspTextDocumentIdentifier & { version: number },
    contentChanges: LspTextDocumentContentChangeEvent[],
  ): void {
    this.connection?.notify("textDocument/didChange", {
      textDocument: document,
      contentChanges,
    });
  }

  public notifyDocumentClosed(document: LspTextDocumentIdentifier): void {
    this.connection?.notify("textDocument/didClose", {
      textDocument: document,
    });
  }

  public notifyDocumentFocused(uri?: string): void {
    this.connection?.notify(
      "textDocument/didFocus",
      uri === undefined ? {} : { textDocument: { uri } },
    );
  }

  public notifyWorkspaceFoldersChanged(
    added: LspWorkspaceFolder[],
    removed: LspWorkspaceFolder[],
  ): void {
    this.workspaceFolders = this.workspaceFolders
      .filter(
        (folder) =>
          !removed.some((removedFolder) => removedFolder.uri === folder.uri),
      )
      .concat(added);
    this.connection?.notify("workspace/didChangeWorkspaceFolders", {
      event: { added, removed },
    });
  }

  public notifyConfigurationChanged(
    configuration: CopilotClientConfiguration,
  ): void {
    this.connection?.notify("workspace/didChangeConfiguration", {
      settings: configuration,
    });
  }

  public notifyWatchedFilesChanged(
    workspaceUri: string,
    changes: LspWatchedFileChange[],
  ): void {
    if (changes.length === 0) {
      return;
    }
    this.connection?.notify("workspace/didChangeWatchedFiles", {
      workspaceUri,
      changes,
    });
  }

  public requestInlineCompletions(
    params: LspInlineCompletionParams,
    cancellationToken?: CancellationTokenLike,
  ): Promise<LspInlineCompletionList> {
    if (this.connection === undefined || !this.initialized) {
      return Promise.resolve({ items: [] });
    }
    return this.connection.request<LspInlineCompletionList>(
      "textDocument/inlineCompletion",
      params,
      cancellationToken,
    );
  }

  public requestNextEditSuggestions(
    params: LspNextEditParams,
    cancellationToken?: CancellationTokenLike,
  ): Promise<LspNextEditResponse> {
    if (this.connection === undefined || !this.initialized) {
      return Promise.resolve({ edits: [] });
    }
    return this.connection.request<LspNextEditResponse>(
      "textDocument/copilotInlineEdit",
      params,
      cancellationToken,
    );
  }

  public notifyCompletionShown(item: LspInlineCompletionItem): void {
    this.connection?.notify("textDocument/didShowCompletion", { item });
  }

  /**
   * `acceptedLength` counts from the start of `insertText` to the end of what
   * was accepted, in UTF-16 code units, which is also what VS Code's
   * `PartialAcceptInfo.acceptedLength` reports.
   */
  public notifyCompletionPartiallyAccepted(
    item: LspInlineCompletionItem,
    acceptedLength: number,
  ): void {
    this.connection?.notify("textDocument/didPartiallyAcceptCompletion", {
      item,
      acceptedLength,
    });
  }

  public notifyNextEditShown(item: LspNextEdit): void {
    this.connection?.notify("textDocument/didShowInlineEdit", { item });
  }

  public signIn(): Promise<LspSignInResponse | null> {
    return this.requireConnection().request<LspSignInResponse | null>(
      "signIn",
      {},
    );
  }

  public checkStatus(): Promise<LspCheckStatusResponse | null> {
    return this.requireConnection().request<LspCheckStatusResponse | null>(
      "checkStatus",
      {},
    );
  }

  public signOut(): Promise<void> {
    return this.requireConnection().request<void>("signOut", {});
  }

  public async checkQuota(): Promise<CopilotQuota> {
    return parseCopilotQuota(
      await this.requireConnection().request<unknown>("checkQuota", {}),
    );
  }

  public executeCommand(command: LspCommand): Promise<unknown> {
    const params: LspServerCommandRequest = {
      command: command.command,
      arguments: command.arguments,
    };
    return this.requireConnection().request("workspace/executeCommand", params);
  }

  private async startInternal(
    options: CopilotClientStartOptions,
  ): Promise<void> {
    if (this.process !== undefined) {
      await this.stop();
    }

    const child = launchLanguageServer(options.launch, options.workspaceRoot);
    this.process = child;
    this.workspaceFolders = [...options.workspaceFolders];
    this.stopping = false;

    child.stderr.on("data", (chunk: Buffer | string) => {
      const message = redactLogMessage(String(chunk).trim());
      if (message.length > 0) {
        this.handlers.onLog?.(`[server] ${message}`);
      }
    });
    child.on("error", (error) => {
      this.handlers.onLog?.(
        `Language Server process error: ${redactLogMessage(error.message)}`,
      );
    });
    child.on("exit", (code, signal) => {
      if (this.process === child) {
        this.process = undefined;
        this.connection?.dispose();
        this.connection = undefined;
        this.initialized = false;
      }
      if (!this.stopping) {
        this.handlers.onProcessExit?.(code, signal);
      }
    });

    this.connection = new JsonRpcConnection(child.stdout, child.stdin, {
      requestTimeoutMs: 20_000,
      log: (message, details) => {
        if (this.handlers.isDebugLoggingEnabled?.() === true) {
          this.handlers.onLog?.(
            `${message} ${JSON.stringify(redactSecrets(details))}`,
          );
        }
      },
      requestHandler: (method, params) =>
        this.handleServerRequest(method, params),
      notificationHandler: (method, params) =>
        this.handleServerNotification(method, params),
    });

    try {
      await this.initialize(options);
      this.initialized = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async initialize(options: CopilotClientStartOptions): Promise<void> {
    const initializeParams = {
      processId: process.pid,
      clientInfo: {
        name: "devhub-copilot",
        version: options.extensionVersion,
      },
      rootUri: options.workspaceFolders[0]?.uri ?? null,
      workspaceFolders: options.workspaceFolders,
      capabilities: {
        workspace: {
          workspaceFolders: true,
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
            relativePatternSupport: true,
          },
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            didSave: false,
            willSaveWaitUntil: false,
          },
          inlineCompletion: {
            dynamicRegistration: false,
          },
        },
        window: {
          showDocument: {
            support: true,
          },
          showMessage: {
            messageActionItem: {
              additionalPropertiesSupport: true,
            },
          },
        },
        general: {
          positionEncodings: ["utf-16"],
        },
      },
      initializationOptions: {
        editorInfo: {
          name: "Visual Studio Code",
          version: options.vscodeVersion,
        },
        editorPluginInfo: {
          name: "devhub-copilot",
          version: options.extensionVersion,
        },
        // The Copilot Language Server uses this editor capability to enable
        // workspace semantic search and its custom copilot/watchedFiles
        // request. It is distinct from the standard LSP file-watch capability.
        copilotCapabilities: {
          watchedFiles: true,
        },
      },
    };

    await this.requireConnection().request("initialize", initializeParams);
    this.requireConnection().notify("initialized", {});
    this.notifyConfigurationChanged(options.configuration);
  }

  private async stopInternal(): Promise<void> {
    const child = this.process;
    const connection = this.connection;
    this.stopping = true;
    this.initialized = false;
    this.process = undefined;
    this.connection = undefined;

    if (connection !== undefined) {
      try {
        await connection.request("shutdown", {}, undefined, 2_000);
      } catch {
        // The process may already have exited. We still close its streams below.
      }
      connection.notify("exit", null);
      connection.dispose();
    }

    if (child === undefined) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      child.once("exit", finish);
      child.once("close", finish);
      child.stdin.end();
      setTimeout(() => {
        if (!settled) {
          child.kill();
          finish();
        }
      }, 2_000);
    });
  }

  private requireConnection(): JsonRpcConnection {
    if (
      this.connection === undefined ||
      (!this.initialized && this.process === undefined)
    ) {
      throw new Error("Copilot Language Server is not running.");
    }
    return this.connection;
  }

  private async handleServerRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "window/showDocument":
        return (
          this.handlers.onShowDocument?.(params as LspShowDocumentParams) ??
          false
        );
      case "window/showMessageRequest":
        return (
          this.handlers.onShowMessageRequest?.(
            params as LspShowMessageRequestParams,
          ) ?? null
        );
      case "workspace/configuration": {
        const configurationParams = params as
          | LspWorkspaceConfigurationParams
          | undefined;
        return (
          this.handlers.onConfigurationRequest?.(
            configurationParams?.items ?? [],
          ) ?? []
        );
      }
      case "client/registerCapability": {
        const registrations =
          isRecord(params) && Array.isArray(params.registrations)
            ? params.registrations.filter(isLspRegistration)
            : [];
        await this.handlers.onRegisterCapability?.(registrations);
        return null;
      }
      case "client/unregisterCapability": {
        const unregistrations =
          isRecord(params) && Array.isArray(params.unregistrations)
            ? params.unregistrations.filter(isLspUnregistration)
            : [];
        await this.handlers.onUnregisterCapability?.(unregistrations);
        return null;
      }
      case "copilot/watchedFiles": {
        const watchedFiles =
          this.handlers.onWatchedFilesRequest === undefined
            ? { files: [] }
            : await this.handlers.onWatchedFilesRequest(
                params as LspWatchedFilesRequestParams,
              );
        return watchedFiles;
      }
      case "workspace/workspaceFolders":
        return this.workspaceFolders;
      default:
        throw new Error(`Unsupported server request: ${method}`);
    }
  }

  private handleServerNotification(method: string, params: unknown): void {
    switch (method) {
      case "didChangeStatus": {
        const status = params as LspStatus | undefined;
        this.handlers.onStatus?.({
          busy: status?.busy === true,
          message: typeof status?.message === "string" ? status.message : "",
          kind: typeof status?.kind === "string" ? status.kind : "Normal",
          command: status?.command,
        });
        break;
      }
      case "window/logMessage": {
        const messageParams = params as { message?: unknown } | undefined;
        const message =
          typeof messageParams?.message === "string"
            ? messageParams.message
            : JSON.stringify(redactSecrets(params));
        this.handlers.onLog?.(`[server] ${redactLogMessage(message)}`);
        break;
      }
      case "window/showMessage":
        this.handlers.onShowMessage?.(params as LspShowMessageRequestParams);
        break;
      default:
        if (this.handlers.isDebugLoggingEnabled?.() === true) {
          this.handlers.onLog?.(`Unhandled server notification: ${method}`);
        }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isLspRegistration(value: unknown): value is LspRegistration {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.method === "string"
  );
}

function isLspUnregistration(value: unknown): value is LspUnregistration {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.method === "string"
  );
}
