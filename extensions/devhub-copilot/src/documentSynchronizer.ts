import * as vscode from "vscode";
import type {
  LspTextDocumentContentChangeEvent,
  LspTextDocumentIdentifier,
  LspTextDocumentItem,
  LspWorkspaceFolder,
} from "./lspTypes";
import { isValidLspPosition } from "./protocol";

export interface DocumentSyncClient {
  notifyDocumentOpened(document: LspTextDocumentItem): void;
  notifyDocumentChanged(
    document: LspTextDocumentIdentifier & { version: number },
    contentChanges: LspTextDocumentContentChangeEvent[],
  ): void;
  notifyDocumentClosed(document: LspTextDocumentIdentifier): void;
  notifyDocumentFocused(uri?: string): void;
  notifyWorkspaceFoldersChanged(
    added: LspWorkspaceFolder[],
    removed: LspWorkspaceFolder[],
  ): void;
}

interface SyncedDocument {
  uri: string;
  version: number;
}

export const MAX_DOCUMENT_BYTES = 1_000_000;

export function documentUri(document: vscode.TextDocument): string {
  // VS Code owns URI escaping, including remote authorities. Do not alter fsPath
  // or perform string substitutions for remote/Dev Container documents.
  return document.uri.toString();
}

export function workspaceFolderToLsp(
  folder: vscode.WorkspaceFolder,
): LspWorkspaceFolder {
  return {
    uri: folder.uri.toString(),
    name: folder.name,
  };
}

export function isNotebookCell(document: vscode.TextDocument): boolean {
  return vscode.workspace.notebookDocuments.some((notebook) =>
    notebook
      .getCells()
      .some((cell) => cell.document.uri.toString() === document.uri.toString()),
  );
}

export function shouldSynchronizeDocument(
  document: vscode.TextDocument,
): boolean {
  if (
    document.uri.scheme !== "file" &&
    document.uri.scheme !== "vscode-remote" &&
    document.uri.scheme !== "untitled"
  ) {
    return false;
  }
  if (isNotebookCell(document)) {
    return false;
  }
  return Buffer.byteLength(document.getText(), "utf8") <= MAX_DOCUMENT_BYTES;
}

export class DocumentSynchronizer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly synced = new Map<string, SyncedDocument>();
  private disposed = false;

  public constructor(
    private readonly client: DocumentSyncClient,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  public start(): void {
    if (this.disposed) {
      return;
    }

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => this.open(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.change(event)),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.close(document),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.focus(editor?.document),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders((event) =>
        this.workspaceFoldersChanged(event),
      ),
    );

    for (const document of vscode.workspace.textDocuments) {
      this.open(document);
    }
    this.focus(vscode.window.activeTextEditor?.document);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    for (const document of this.synced.values()) {
      this.client.notifyDocumentClosed({ uri: document.uri });
    }
    this.synced.clear();
  }

  private open(document: vscode.TextDocument): void {
    const uri = documentUri(document);
    if (!shouldSynchronizeDocument(document)) {
      this.closeByUri(uri);
      return;
    }

    const previous = this.synced.get(uri);
    if (previous !== undefined) {
      if (previous.version === document.version) {
        return;
      }
      this.client.notifyDocumentClosed({ uri });
      this.synced.delete(uri);
    }

    this.client.notifyDocumentOpened({
      uri,
      languageId: document.languageId,
      version: document.version,
      text: document.getText(),
    });
    this.synced.set(uri, { uri, version: document.version });
  }

  private change(event: vscode.TextDocumentChangeEvent): void {
    const document = event.document;
    const uri = documentUri(document);
    if (!shouldSynchronizeDocument(document)) {
      this.closeByUri(uri);
      return;
    }

    const tracked = this.synced.get(uri);
    if (tracked === undefined) {
      this.open(document);
      return;
    }
    if (document.version === tracked.version) {
      // VS Code can report a duplicate event while a document is being
      // reopened. The server already has this exact version, so no message is
      // needed and no duplicate didChange should be sent.
      return;
    }
    if (document.version < tracked.version) {
      // A queued event from before a reopen can arrive after a newer version
      // has been tracked. Incremental changes can no longer be applied safely
      // in that order; reset the server's document state from the current
      // VS Code snapshot instead of leaving the server stale.
      this.log(
        `Resynchronizing document after an out-of-order version for ${uri}.`,
      );
      this.client.notifyDocumentClosed({ uri });
      this.client.notifyDocumentOpened({
        uri,
        languageId: document.languageId,
        version: document.version,
        text: document.getText(),
      });
      tracked.version = document.version;
      return;
    }

    const contentChanges: LspTextDocumentContentChangeEvent[] = [];
    for (const change of event.contentChanges) {
      const range = {
        start: {
          line: change.range.start.line,
          character: change.range.start.character,
        },
        end: {
          line: change.range.end.line,
          character: change.range.end.character,
        },
      };
      if (!isValidLspPosition(range.start) || !isValidLspPosition(range.end)) {
        this.log(`Ignored an invalid document change for ${uri}.`);
        return;
      }
      contentChanges.push({
        range,
        rangeLength: change.rangeLength,
        text: change.text,
      });
    }

    this.client.notifyDocumentChanged(
      { uri, version: document.version },
      contentChanges,
    );
    tracked.version = document.version;
  }

  private close(document: vscode.TextDocument): void {
    this.closeByUri(documentUri(document));
  }

  private closeByUri(uri: string): void {
    if (!this.synced.delete(uri)) {
      return;
    }
    this.client.notifyDocumentClosed({ uri });
  }

  private focus(document: vscode.TextDocument | undefined): void {
    if (document === undefined || !shouldSynchronizeDocument(document)) {
      this.client.notifyDocumentFocused();
      return;
    }
    this.client.notifyDocumentFocused(documentUri(document));
  }

  private workspaceFoldersChanged(
    event: vscode.WorkspaceFoldersChangeEvent,
  ): void {
    this.client.notifyWorkspaceFoldersChanged(
      event.added.map(workspaceFolderToLsp),
      event.removed.map(workspaceFolderToLsp),
    );
  }
}
