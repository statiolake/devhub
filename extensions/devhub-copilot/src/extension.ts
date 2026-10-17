import * as vscode from "vscode";
import {
  CompletionProvider,
  EXECUTE_SERVER_COMMAND,
} from "./completionProvider";
import {
  getConfigurationSection,
  toCopilotClientConfiguration,
} from "./configuration";
import {
  CopilotLspClient,
  type CopilotClientConfiguration,
  type CopilotClientStatus,
} from "./copilotClient";
import {
  DocumentSynchronizer,
  workspaceFolderToLsp,
} from "./documentSynchronizer";
import type {
  LspCommand,
  LspConfigurationItem,
  LspMessageActionItem,
  LspShowDocumentParams,
  LspShowMessageRequestParams,
} from "./lspTypes";
import { NextEditProvider } from "./nextEditProvider";
import {
  accountFromStatus,
  buildHover,
  COMPLETIONS_SETTING,
  isSnoozed,
  NEXT_EDITS_SETTING,
  SET_SETTING_COMMAND,
  SNOOZE_MS,
  statusBarAppearance,
  type AccountState,
  type DashboardState,
  type FeatureSetting,
} from "./dashboard";
import { formatQuotaLines, type CopilotQuota } from "./quota";
import { redactLogMessage, redactSecrets } from "./redaction";
import { resolveLanguageServerLaunch } from "./serverLauncher";
import { statusOf, type CopilotState } from "./status";
import { WorkspaceFileProvider } from "./workspaceFileProvider";
import { WorkspaceFileWatcher } from "./workspaceFileWatcher";

const SECTION = "devhub.copilot";
const OUTPUT_CHANNEL_NAME = "Copilot";
const MAX_AUTOMATIC_RECOVERIES = 3;
const RECOVERY_DELAY_MS = 1_000;
const STABLE_RUNTIME_MS = 60_000;
const QUOTA_REFRESH_INTERVAL_MS = 10 * 60_000;

/**
 * The marketplace adapter this extension grew out of. Installed beside this
 * one it would start a second language server and offer every completion
 * twice, so its provider is excluded (`excludes` below) and the person is
 * told once.
 */
const SUPERSEDED_EXTENSION = "statiolake.vscode-copilot-lsp";

/** Where suggestions are offered: each scheme the server is sent. */
const SELECTOR: vscode.DocumentSelector = [
  { scheme: "file" },
  { scheme: "vscode-remote" },
  { scheme: "untitled" },
];

type QuotaState =
  | { kind: "loaded"; quota: CopilotQuota }
  | { kind: "failed"; message: string };

let controller: Controller | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  controller = new Controller(context);
  await controller.activate();
}

export async function deactivate(): Promise<void> {
  await controller?.deactivate();
  controller = undefined;
}

class Controller {
  private readonly output =
    vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  private readonly statusBar = vscode.window.createStatusBarItem(
    "devhub.copilot.status",
    vscode.StatusBarAlignment.Right,
    100,
  );
  private readonly client: CopilotLspClient;
  private readonly fileWatchers: WorkspaceFileWatcher;
  private readonly fileProvider: WorkspaceFileProvider;
  private synchronizer?: DocumentSynchronizer;
  private lifecycle: Promise<void> = Promise.resolve();
  private recoveryTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private quotaTimer?: NodeJS.Timeout;
  private recoveryCount = 0;
  private lastServerStatus?: CopilotClientStatus;
  private quotaState?: QuotaState;
  private disposed = false;
  private enabled: boolean;
  private signingIn = false;
  private starting = false;
  private account: AccountState = { kind: "unknown" };
  private snoozedUntil?: number;
  private snoozeTimer?: NodeJS.Timeout;
  private languageNames?: Map<string, string>;
  /**
   * Whether this build's workbench draws `StatusBarItem.hover`, the
   * `devhubStatusBarHover` proposal (patches/vscode/0009). Without it the
   * item keeps a plain tooltip and opens the Quick Pick menu.
   */
  private readonly richHover: boolean;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar.name = "Copilot";
    this.richHover = supportsRichHover(this.statusBar);
    // With the hover, an item without a command pins it open on click.
    this.statusBar.command = this.richHover
      ? undefined
      : "devhub.copilot.showMenu";
    this.enabled = this.setting("enable", true);
    this.fileWatchers = new WorkspaceFileWatcher(
      (workspaceUri, changes) =>
        this.client.notifyWatchedFilesChanged(workspaceUri, changes),
      (message) => this.log(message),
    );
    this.fileProvider = new WorkspaceFileProvider((message) =>
      this.log(message),
    );
    this.client = new CopilotLspClient({
      onStatus: (status) => this.onServerStatus(status),
      onLog: (message) => this.log(message),
      onShowDocument: (params) => this.showDocument(params),
      onShowMessageRequest: (params) => this.showMessageRequest(params),
      onShowMessage: (params) =>
        void this.showMessageWithType(params.type, params.message, []),
      onConfigurationRequest: async (items) => this.configurationRequest(items),
      onRegisterCapability: (registrations) =>
        this.fileWatchers.register(registrations),
      onUnregisterCapability: (unregistrations) =>
        this.fileWatchers.unregister(unregistrations),
      onWatchedFilesRequest: (params) => this.fileProvider.provide(params),
      onProcessExit: (code, signal) => this.onProcessExit(code, signal),
      isDebugLoggingEnabled: () => this.setting("debug.logging", false),
    });
  }

  public async activate(): Promise<void> {
    const getClient = () => this.client;
    const log = (message: string) => this.log(message);
    // Signed out, the server answers every request with "Not authenticated";
    // asking on each keystroke would only fill the log with it.
    const canAsk = () =>
      this.enabled &&
      statusOf(this.state()).kind !== "signedOut" &&
      this.account.kind !== "signedOut" &&
      this.account.kind !== "notAuthorized" &&
      !isSnoozed({ snoozedUntil: this.snoozedUntil, now: Date.now() });
    // Both settings are language-overridable, so they are read for the
    // document being asked about.
    const enabledFor = (document: vscode.TextDocument, key: string) =>
      vscode.workspace.getConfiguration(SECTION, document).get(key, true);
    const completions = new CompletionProvider({
      getClient,
      log,
      isEnabled: (document) =>
        canAsk() && enabledFor(document, COMPLETIONS_SETTING),
    });
    const nextEdits = new NextEditProvider({
      getClient,
      log,
      isEnabled: (document) =>
        canAsk() && enabledFor(document, NEXT_EDITS_SETTING),
    });
    this.context.subscriptions.push(
      vscode.commands.registerCommand("devhub.copilot.signIn", () =>
        this.signIn(),
      ),
      vscode.commands.registerCommand("devhub.copilot.signOut", () =>
        this.signOut(),
      ),
      vscode.commands.registerCommand("devhub.copilot.restart", () =>
        this.restartServer(true),
      ),
      vscode.commands.registerCommand("devhub.copilot.toggle", () =>
        this.toggle(),
      ),
      vscode.commands.registerCommand("devhub.copilot.showMenu", () =>
        this.showMenu(),
      ),
      vscode.commands.registerCommand("devhub.copilot.showOutput", () =>
        this.output.show(true),
      ),
      vscode.commands.registerCommand("devhub.copilot.snooze", () =>
        this.snooze(),
      ),
      vscode.commands.registerCommand("devhub.copilot.cancelSnooze", () =>
        this.cancelSnooze(),
      ),
      vscode.commands.registerCommand(
        SET_SETTING_COMMAND,
        (key: unknown, languageId: unknown, value: unknown) =>
          this.setFeatureSetting(key, languageId, value),
      ),
      vscode.commands.registerCommand(
        EXECUTE_SERVER_COMMAND,
        (command: unknown) => this.executeServerCommand(command),
      ),
      vscode.languages.registerInlineCompletionItemProvider(
        SELECTOR,
        completions,
        { displayName: "Copilot", excludes: [SUPERSEDED_EXTENSION] },
      ),
      vscode.languages.registerInlineCompletionItemProvider(
        SELECTOR,
        nextEdits,
        {
          displayName: "Copilot Next Edit Suggestions",
          excludes: [SUPERSEDED_EXTENSION],
        },
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        this.onConfigurationChanged(event);
        this.onSettingsChanged(event);
      }),
      // The hover's "for <language>" toggles follow the active editor.
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document === vscode.window.activeTextEditor?.document) {
          this.updateStatusBar(); // its language was changed
        }
      }),
      vscode.extensions.onDidChange(() => {
        this.languageNames = undefined;
      }),
      { dispose: () => clearTimeout(this.snoozeTimer) },
      this.statusBar,
      this.fileWatchers,
      this.output,
    );
    this.fileWatchers.start();
    this.updateStatusBar();
    this.warnAboutSupersededExtension();

    if (this.enabled) {
      await this.enqueue(() => this.startServer());
    } else {
      this.log(`Copilot is turned off by ${SECTION}.enable.`);
    }
  }

  public async deactivate(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.stableTimer);
    this.stopQuotaRefresh();
    await this.enqueue(async () => {
      this.synchronizer?.dispose();
      this.synchronizer = undefined;
      await this.client.stop();
    });
  }

  private warnAboutSupersededExtension(): void {
    if (vscode.extensions.getExtension(SUPERSEDED_EXTENSION) === undefined) {
      return;
    }
    this.log(
      `${SUPERSEDED_EXTENSION} is installed as well; its completions are excluded in favour of the built-in ones.`,
    );
    void vscode.window.showWarningMessage(
      `DevHub has Copilot built in. Uninstall or disable ${SUPERSEDED_EXTENSION}, or it runs a second language server and draws its own Next Edit Suggestions beside the editor's.`,
    );
  }

  private async startServer(): Promise<void> {
    if (this.disposed || !this.enabled || this.client.isReady) {
      return;
    }
    this.lastServerStatus = undefined;
    this.starting = true;
    this.updateStatusBar();
    const folders = vscode.workspace.workspaceFolders ?? [];
    // The server runs on this machine (extensionKind `ui`), so only a local
    // folder can be its working directory; a remote one is a path that is
    // not here.
    const local = folders.find((folder) => folder.uri.scheme === "file");
    try {
      await this.client.start({
        launch: resolveLanguageServerLaunch(this.context.extensionPath),
        workspaceFolders: folders.map(workspaceFolderToLsp),
        workspaceRoot: local?.uri.fsPath,
        vscodeVersion: vscode.version,
        extensionVersion: this.extensionVersion,
        configuration: this.serverConfiguration(),
      });
      this.synchronizer?.dispose();
      this.synchronizer = new DocumentSynchronizer(this.client, (message) =>
        this.log(message),
      );
      this.synchronizer.start();
      this.log("Copilot language server started.");
      this.scheduleStableRecoveryReset();
      this.startQuotaRefresh();
      void this.refreshAccount();
    } catch (error) {
      this.log(
        `Could not start the Copilot language server: ${formatError(error)}`,
      );
      this.lastServerStatus = {
        busy: false,
        kind: "Error",
        message: "The language server could not be started.",
      };
      void vscode.window.showErrorMessage(
        "Copilot could not start. See the Copilot output for details.",
      );
    } finally {
      this.starting = false;
      this.updateStatusBar();
    }
  }

  private async stopServer(): Promise<void> {
    this.fileWatchers.reset();
    this.stopQuotaRefresh();
    this.synchronizer?.dispose();
    this.synchronizer = undefined;
    await this.client.stop();
    this.updateStatusBar();
  }

  private restartServer(byPerson: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (!this.enabled) {
        if (byPerson) {
          void vscode.window.showInformationMessage(
            `Copilot is turned off by ${SECTION}.enable.`,
          );
        }
        return;
      }
      if (byPerson) {
        this.recoveryCount = 0;
      }
      await this.stopServer();
      await this.startServer();
    });
  }

  private async signIn(): Promise<void> {
    if (!(await this.ensureRunning())) {
      return;
    }
    this.signingIn = true;
    this.updateStatusBar();
    try {
      const response = await this.client.signIn();
      const userCode = response?.userCode;
      const command = response?.command;
      const hasCode = typeof userCode === "string" && userCode.length > 0;
      if (hasCode) {
        let copied = false;
        try {
          await vscode.env.clipboard.writeText(userCode);
          copied = true;
        } catch (error) {
          this.log(`Could not copy the sign-in code: ${formatError(error)}`);
        }
        void vscode.window.showInformationMessage(
          `GitHub sign-in code: ${userCode}${copied ? " (copied to the clipboard)" : ""}`,
        );
      }
      if (isLspCommand(command)) {
        // The server's own command opens the device-flow page and waits.
        await this.client.executeCommand(command);
      } else if (!hasCode) {
        // No challenge means the server's session is already signed in.
        void vscode.window.showInformationMessage(
          "Copilot is already signed in to GitHub.",
        );
      }
    } catch (error) {
      this.log(`Sign-in failed: ${formatError(error)}`);
      void vscode.window.showErrorMessage(
        "Copilot sign-in failed. See the Copilot output for details.",
      );
    } finally {
      this.signingIn = false;
      this.updateStatusBar();
    }
    await Promise.all([this.refreshQuota(), this.refreshAccount()]);
  }

  private async signOut(): Promise<void> {
    if (!(await this.ensureRunning())) {
      return;
    }
    try {
      await this.client.signOut();
      this.account = { kind: "signedOut" };
      await Promise.all([this.refreshQuota(), this.refreshAccount()]);
      void vscode.window.showInformationMessage("Copilot signed out.");
    } catch (error) {
      this.log(`Sign-out failed: ${formatError(error)}`);
      void vscode.window.showErrorMessage(
        "Copilot sign-out failed. See the Copilot output for details.",
      );
    }
  }

  private async executeServerCommand(command: unknown): Promise<void> {
    if (!isLspCommand(command) || !this.client.isReady) {
      return;
    }
    try {
      await this.client.executeCommand(command);
    } catch (error) {
      this.log(`Acceptance command failed: ${formatError(error)}`);
    }
  }

  private async toggle(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(SECTION);
    const inspection = configuration.inspect<boolean>("enable");
    const target =
      inspection?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspection?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    try {
      await configuration.update("enable", !this.enabled, target);
    } catch (error) {
      this.log(`Could not toggle Copilot: ${formatError(error)}`);
    }
  }

  private async showMenu(): Promise<void> {
    const state = this.state();
    const items: Array<vscode.QuickPickItem & { command?: string }> = [
      {
        label: this.enabled ? "$(circle-slash) Turn Off" : "$(check) Turn On",
        command: "devhub.copilot.toggle",
      },
      { label: "$(sign-in) Sign In", command: "devhub.copilot.signIn" },
      { label: "$(sign-out) Sign Out", command: "devhub.copilot.signOut" },
      {
        label: "$(debug-restart) Restart Language Server",
        command: "devhub.copilot.restart",
      },
      { label: "$(output) Show Output", command: "devhub.copilot.showOutput" },
      {
        label: "$(settings-gear) Settings",
        command: "workbench.action.openSettings",
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Copilot: ${statusOf(state).summary}`,
      placeHolder: this.quotaLines().join(" · "),
    });
    if (picked?.command === "workbench.action.openSettings") {
      await vscode.commands.executeCommand(picked.command, SECTION);
    } else if (picked?.command !== undefined) {
      await vscode.commands.executeCommand(picked.command);
    }
  }

  private async ensureRunning(): Promise<boolean> {
    if (!this.enabled) {
      void vscode.window.showInformationMessage(
        `Copilot is turned off by ${SECTION}.enable.`,
      );
      return false;
    }
    if (!this.client.isReady) {
      await this.enqueue(() => this.startServer());
    }
    return this.client.isReady;
  }

  private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    if (event.affectsConfiguration(`${SECTION}.enable`)) {
      const enabled = this.setting("enable", true);
      if (enabled !== this.enabled) {
        this.enabled = enabled;
        this.updateStatusBar();
        void this.enqueue(() =>
          this.enabled ? this.startServer() : this.stopServer(),
        );
      }
    }
    if (
      event.affectsConfiguration(`${SECTION}.nextEditSuggestions`) ||
      event.affectsConfiguration("http") ||
      event.affectsConfiguration("telemetry") ||
      event.affectsConfiguration("github-enterprise")
    ) {
      this.client.notifyConfigurationChanged(this.serverConfiguration());
    }
  }

  private onSettingsChanged(event: vscode.ConfigurationChangeEvent): void {
    if (event.affectsConfiguration(SECTION)) {
      this.updateStatusBar(); // the hover's toggles
    }
  }

  private onServerStatus(status: CopilotClientStatus): void {
    const previous = this.lastServerStatus;
    this.lastServerStatus = status;
    this.updateStatusBar();
    if (previous !== undefined && previous.kind !== status.kind) {
      // Signed in or out elsewhere (another client of the same store), or
      // the session expired.
      void this.refreshAccount();
    }
    if (status.message.length > 0) {
      this.log(
        `Language server status: ${status.kind}${status.busy ? " (busy)" : ""}: ${status.message}`,
      );
    }
  }

  private onProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.disposed || !this.enabled) {
      return;
    }
    this.log(
      `The language server exited (code=${String(code)}, signal=${String(signal)}).`,
    );
    this.fileWatchers.reset();
    this.lastServerStatus = {
      busy: false,
      kind: "Error",
      message: "The language server process exited.",
    };
    this.updateStatusBar();
    if (this.recoveryCount >= MAX_AUTOMATIC_RECOVERIES) {
      void vscode.window.showErrorMessage(
        "The Copilot language server keeps exiting. Run 'Copilot: Restart Language Server' to try again.",
      );
      return;
    }
    this.recoveryCount += 1;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.enqueue(async () => {
        if (!this.disposed && this.enabled) {
          await this.stopServer();
          await this.startServer();
        }
      });
    }, RECOVERY_DELAY_MS);
  }

  private scheduleStableRecoveryReset(): void {
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.recoveryCount = 0;
    }, STABLE_RUNTIME_MS);
  }

  private startQuotaRefresh(): void {
    this.stopQuotaRefresh();
    this.quotaTimer = setInterval(
      () => void this.refreshQuota(),
      QUOTA_REFRESH_INTERVAL_MS,
    );
    void this.refreshQuota();
  }

  private stopQuotaRefresh(): void {
    clearInterval(this.quotaTimer);
    this.quotaTimer = undefined;
    this.quotaState = undefined;
  }

  /**
   * The server's `checkQuota`, which it answers from its own GitHub session.
   * A failure replaces the last value, so a stale figure is never shown.
   */
  private async refreshQuota(): Promise<void> {
    if (!this.client.isReady) {
      return;
    }
    try {
      this.quotaState = {
        kind: "loaded",
        quota: await this.client.checkQuota(),
      };
    } catch (error) {
      this.quotaState = { kind: "failed", message: formatError(error) };
    }
    this.updateStatusBar();
  }

  private quotaLines(): string[] {
    const state = this.quotaState;
    if (state === undefined) {
      return ["Usage: not loaded"];
    }
    return state.kind === "loaded"
      ? formatQuotaLines(state.quota)
      : [`Usage: unavailable (${redactLogMessage(state.message)})`];
  }

  private async showDocument(params: LspShowDocumentParams): Promise<boolean> {
    try {
      const uri = vscode.Uri.parse(params.uri);
      if (params.external || uri.scheme === "http" || uri.scheme === "https") {
        return await vscode.env.openExternal(uri);
      }
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(uri),
        { preview: false },
      );
      return true;
    } catch (error) {
      this.log(`Could not open a document: ${formatError(error)}`);
      return false;
    }
  }

  private async showMessageRequest(
    params: LspShowMessageRequestParams,
  ): Promise<LspMessageActionItem | null> {
    const actions = params.actions ?? [];
    const selected = await this.showMessageWithType(
      params.type,
      params.message,
      actions.map((action) => action.title),
    );
    return actions.find((action) => action.title === selected) ?? null;
  }

  private showMessageWithType(
    type: 1 | 2 | 3 | 4 | undefined,
    message: string,
    actions: string[],
  ): Thenable<string | undefined> {
    const safe = redactLogMessage(message);
    switch (type) {
      case 1:
        return vscode.window.showErrorMessage(safe, ...actions);
      case 2:
        return vscode.window.showWarningMessage(safe, ...actions);
      default:
        return vscode.window.showInformationMessage(safe, ...actions);
    }
  }

  private configurationRequest(items: LspConfigurationItem[]): unknown[] {
    const configuration = this.serverConfiguration();
    return items.map((item) =>
      getConfigurationSection(configuration, item.section),
    );
  }

  private serverConfiguration(): CopilotClientConfiguration {
    const http = vscode.workspace.getConfiguration("http");
    const telemetry = vscode.workspace.getConfiguration("telemetry");
    const enterprise = vscode.workspace.getConfiguration("github-enterprise");
    return {
      ...toCopilotClientConfiguration({
        proxy: http.get<string | null>("proxy"),
        proxyStrictSSL: http.get<boolean | null>("proxyStrictSSL"),
        proxyKerberosServicePrincipal: http.get<string | null>(
          "proxyKerberosServicePrincipal",
        ),
        telemetryLevel: telemetry.get<string | null>("telemetryLevel"),
        githubEnterpriseUri: enterprise.get<string | null>("uri"),
      }),
      // The server asks for the whole `github.copilot` section and reads its
      // own dotted keys inside it. Their values are this extension's settings;
      // nothing here reads the official extension's namespace.
      github: {
        copilot: {
          // The providers decide per document (the setting is
          // language-overridable); the server only has to be willing.
          "nextEditSuggestions.enabled":
            this.enabledAnywhere(NEXT_EDITS_SETTING),
          "nextEditSuggestions.extendedRange": this.setting(
            "nextEditSuggestions.extendedRange",
            true,
          ),
          "nextEditSuggestions.fixes": true,
          "nextEditSuggestions.allowWhitespaceOnlyChanges": true,
          "chat.inlineEdits.renameSymbolSuggestions": this.setting(
            "nextEditSuggestions.renameSymbolSuggestions",
            true,
          ),
        },
      },
    };
  }

  private setting<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
  }

  private get extensionVersion(): string {
    const version: unknown = this.context.extension.packageJSON.version;
    return typeof version === "string" ? version : "0.0.0";
  }

  private state(): CopilotState {
    return {
      enabled: this.enabled,
      signingIn: this.signingIn,
      ready: this.client.isReady,
      server: this.lastServerStatus,
    };
  }

  private updateStatusBar(): void {
    const state = this.dashboardState();
    const appearance = statusBarAppearance(state);
    this.statusBar.text = appearance.text;
    if (this.richHover) {
      this.statusBar.hover = buildHover(
        state,
        (id) => new vscode.ThemeIcon(id),
      );
    } else {
      this.statusBar.tooltip = [appearance.summary, ...this.quotaLines()].join(
        "\n",
      );
    }
    this.statusBar.accessibilityInformation = {
      label: appearance.summary,
      role: "button",
    };
    this.statusBar.show();
  }

  private dashboardState(): DashboardState {
    const status = statusOf(this.state());
    const editor = vscode.window.activeTextEditor;
    const languageId = editor?.document.languageId;
    const server: DashboardState["server"] = this.starting
      ? "starting"
      : !this.enabled
        ? "stopped"
        : status.kind === "error"
          ? "error"
          : this.client.isReady
            ? "running"
            : "stopped";
    return {
      enabled: this.enabled,
      server,
      busy: this.lastServerStatus?.busy === true,
      signingIn: this.signingIn,
      // The server's own words about signing in count too: they arrive
      // before any checkStatus answer does.
      account:
        status.kind === "signedOut" ? { kind: "signedOut" } : this.account,
      message:
        this.lastServerStatus !== undefined &&
        this.lastServerStatus.message.length > 0
          ? redactLogMessage(this.lastServerStatus.message)
          : undefined,
      quota:
        this.quotaState === undefined
          ? undefined
          : this.quotaState.kind === "loaded"
            ? this.quotaState
            : { kind: "failed" },
      snoozedUntil: this.snoozedUntil,
      now: Date.now(),
      locale: vscode.env.language,
      language:
        languageId === undefined
          ? undefined
          : { id: languageId, name: this.languageName(languageId) },
      completions: this.featureSetting(COMPLETIONS_SETTING, editor?.document),
      nextEdits: this.featureSetting(NEXT_EDITS_SETTING, editor?.document),
    };
  }

  private featureSetting(
    key: string,
    document: vscode.TextDocument | undefined,
  ): FeatureSetting {
    const global = this.setting(key, true);
    if (document === undefined) {
      return { global };
    }
    const inspection = vscode.workspace
      .getConfiguration(SECTION, document)
      .inspect<boolean>(key);
    return {
      global,
      language:
        inspection?.workspaceFolderLanguageValue ??
        inspection?.workspaceLanguageValue ??
        inspection?.globalLanguageValue,
    };
  }

  /** Whether a setting is on anywhere: by default or for some language. */
  private enabledAnywhere(key: string): boolean {
    if (this.setting(key, true)) {
      return true;
    }
    const inspection = vscode.workspace
      .getConfiguration(SECTION)
      .inspect<boolean>(key);
    return (inspection?.languageIds ?? []).some(
      (languageId) =>
        vscode.workspace
          .getConfiguration(SECTION, { languageId })
          .get<boolean>(key, true) === true,
    );
  }

  /**
   * A hover checkbox: `languageId` null for the setting itself, else that
   * language's override, where `'mixed'` removes the override. Written where
   * the value already is (workspace or user), as the toggle command does.
   */
  private async setFeatureSetting(
    key: unknown,
    languageId: unknown,
    value: unknown,
  ): Promise<void> {
    if (
      (key !== COMPLETIONS_SETTING && key !== NEXT_EDITS_SETTING) ||
      (value !== true && value !== false && value !== "mixed")
    ) {
      return;
    }
    try {
      if (typeof languageId !== "string") {
        const configuration = vscode.workspace.getConfiguration(SECTION);
        const inspection = configuration.inspect<boolean>(key);
        await configuration.update(
          key,
          value === true,
          inspection?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global,
        );
        return;
      }
      const configuration = vscode.workspace.getConfiguration(SECTION, {
        languageId,
      });
      const inspection = configuration.inspect<boolean>(key);
      if (value === "mixed") {
        if (inspection?.workspaceLanguageValue !== undefined) {
          await configuration.update(
            key,
            undefined,
            vscode.ConfigurationTarget.Workspace,
            true,
          );
        }
        if (inspection?.globalLanguageValue !== undefined) {
          await configuration.update(
            key,
            undefined,
            vscode.ConfigurationTarget.Global,
            true,
          );
        }
        return;
      }
      await configuration.update(
        key,
        value,
        inspection?.workspaceLanguageValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global,
        true,
      );
    } catch (error) {
      this.log(`Could not change ${SECTION}.${key}: ${formatError(error)}`);
      void vscode.window.showErrorMessage(
        `Could not change ${SECTION}.${key}: ${formatError(error)}`,
      );
    }
  }

  private snooze(): void {
    const now = Date.now();
    this.snoozedUntil = Math.max(now, this.snoozedUntil ?? now) + SNOOZE_MS;
    clearTimeout(this.snoozeTimer);
    this.snoozeTimer = setTimeout(
      () => this.cancelSnooze(),
      this.snoozedUntil - now,
    );
    this.updateStatusBar();
  }

  private cancelSnooze(): void {
    clearTimeout(this.snoozeTimer);
    this.snoozeTimer = undefined;
    this.snoozedUntil = undefined;
    this.updateStatusBar();
  }

  /** The server's `checkStatus`: who is signed in. */
  private async refreshAccount(): Promise<void> {
    if (!this.client.isReady) {
      return;
    }
    try {
      this.account = accountFromStatus(await this.client.checkStatus());
    } catch (error) {
      this.log(`Could not check the sign-in status: ${formatError(error)}`);
      this.account = { kind: "unknown" };
    }
    this.updateStatusBar();
  }

  /**
   * A language's display name, from the `aliases` its extension contributes;
   * the API has no lookup of its own.
   */
  private languageName(languageId: string): string {
    if (this.languageNames === undefined) {
      this.languageNames = new Map();
      for (const extension of vscode.extensions.all) {
        const languages: unknown =
          extension.packageJSON?.contributes?.languages;
        if (!Array.isArray(languages)) {
          continue;
        }
        for (const language of languages) {
          const id: unknown = language?.id;
          const alias: unknown = language?.aliases?.[0];
          if (
            typeof id === "string" &&
            typeof alias === "string" &&
            alias.length > 0 &&
            !this.languageNames.has(id)
          ) {
            this.languageNames.set(id, alias);
          }
        }
      }
    }
    return this.languageNames.get(languageId) ?? languageId;
  }

  private log(message: string, details?: unknown): void {
    const suffix =
      details === undefined ? "" : ` ${JSON.stringify(redactSecrets(details))}`;
    this.output.appendLine(
      `[${new Date().toISOString()}] ${redactLogMessage(message)}${suffix}`,
    );
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(task, task);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }
}

function supportsRichHover(item: vscode.StatusBarItem): boolean {
  if (!("hover" in item)) {
    return false; // a workbench without patches/vscode/0009
  }
  try {
    void item.hover; // throws when the proposal is not enabled for us
    return true;
  } catch {
    return false;
  }
}

function isLspCommand(value: unknown): value is LspCommand {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { command?: unknown }).command === "string"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
