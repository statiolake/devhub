export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextDocumentIdentifier {
  uri: string;
  version?: number | null;
}

export interface LspTextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface LspTextDocumentContentChangeEvent {
  range: LspRange;
  rangeLength?: number;
  text: string;
}

export interface LspWorkspaceFolder {
  uri: string;
  name: string;
}

export interface LspCommand {
  title?: string;
  command: string;
  arguments?: unknown[];
}

export interface LspInlineCompletionItem {
  insertText: string;
  range?: LspRange;
  command?: LspCommand;
  insertTextFormat?: 1 | 2;
  filterText?: string;
  [key: string]: unknown;
}

export interface LspInlineCompletionList {
  isIncomplete?: boolean;
  items: LspInlineCompletionItem[];
}

export interface LspNextEditParams {
  textDocument: LspTextDocumentIdentifier & { version: number };
  position: LspPosition;
}

export interface LspNextEdit {
  text: string;
  textDocument: LspTextDocumentIdentifier & { version: number };
  range: LspRange;
  command?: LspCommand;
  [key: string]: unknown;
}

export interface LspNextEditResponse {
  edits: LspNextEdit[];
  [key: string]: unknown;
}

export interface LspInlineCompletionParams {
  textDocument: LspTextDocumentIdentifier;
  position: LspPosition;
  context: {
    triggerKind: 1 | 2;
  };
  formattingOptions: {
    tabSize: number;
    insertSpaces: boolean;
  };
}

export interface LspStatusCommand extends LspCommand {
  title: string;
}

export interface LspStatus {
  busy?: boolean;
  message?: string;
  kind?: "Normal" | "Error" | "Warning" | "Inactive" | string;
  command?: LspStatusCommand;
}

export interface LspSignInResponse {
  /**
   * The Language Server may return an empty object when an existing session is
   * already available. Keep both fields optional so the adapter does not
   * mistake that valid response for a device-flow failure.
   */
  userCode?: string;
  command?: LspCommand;
}

export interface LspMessageActionItem {
  title: string;
  [key: string]: unknown;
}

export interface LspShowMessageRequestParams {
  type?: 1 | 2 | 3 | 4;
  message: string;
  actions?: LspMessageActionItem[];
}

export interface LspShowDocumentParams {
  uri: string;
  external?: boolean;
  takeFocus?: boolean;
  selection?: LspRange;
}

export interface LspConfigurationItem {
  scopeUri?: string | null;
  section?: string;
}

export interface LspWorkspaceConfigurationParams {
  items: LspConfigurationItem[];
}

export interface LspFileSystemWatcher {
  globPattern:
    | string
    | {
        baseUri?: string;
        pattern: string;
      };
  kind?: number;
}

export interface LspDidChangeWatchedFilesRegistrationOptions {
  watchers?: LspFileSystemWatcher[];
}

export interface LspRegistration {
  id: string;
  method: string;
  registerOptions?: unknown;
}

export interface LspUnregistration {
  id: string;
  method: string;
}

export interface LspWatchedFileChange {
  uri: string;
  type: 1 | 2 | 3;
}

export interface LspWatchedFilesRequestParams {
  workspaceUri: string;
  workspaceFolder?: LspWorkspaceFolder;
  excludeGitignoredFiles?: boolean;
  excludeIDEIgnoredFiles?: boolean;
  partialResultToken?: number | string;
}

export interface LspWatchedFilesResponse {
  files: string[];
}

export interface LspServerCommandRequest {
  command: string;
  arguments?: unknown[];
}
