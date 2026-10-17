import * as vscode from "vscode";
import type { CopilotLspClient } from "./copilotClient";
import { documentUri, shouldSynchronizeDocument } from "./documentSynchronizer";
import type { CancellationTokenLike } from "./jsonRpc";
import type {
  LspCommand,
  LspInlineCompletionItem,
  LspInlineCompletionParams,
} from "./lspTypes";
import {
  isCurrentDocument,
  isValidLspPosition,
  normalizeNewlines,
} from "./protocol";

/** The command an accepted suggestion runs: the server's own, forwarded. */
export const EXECUTE_SERVER_COMMAND = "devhub.copilot._executeServerCommand";

export interface ProviderOptions {
  getClient: () => CopilotLspClient | undefined;
  isEnabled: () => boolean;
  log: (message: string) => void;
}

/**
 * Copilot's ghost text: `textDocument/inlineCompletion`, at the cursor.
 *
 * What the proposed half of the API adds here is the two notifications the
 * server's own README asks for, `didShowCompletion` and
 * `didPartiallyAcceptCompletion`, which the stable API has no event for.
 */
export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly raw = new WeakMap<
    vscode.InlineCompletionItem,
    LspInlineCompletionItem
  >();

  public constructor(private readonly options: ProviderOptions) {}

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | undefined> {
    if (!this.options.isEnabled() || !shouldSynchronizeDocument(document)) {
      return undefined;
    }
    const client = this.options.getClient();
    if (client === undefined || !client.isReady) {
      return undefined;
    }

    const requestVersion = document.version;
    const requestUri = documentUri(document);
    const editor = vscode.workspace.getConfiguration("editor", document.uri);
    const tabSize = editor.get<number | "auto">("tabSize", 4);
    const params: LspInlineCompletionParams = {
      textDocument: { uri: requestUri, version: requestVersion },
      position: { line: position.line, character: position.character },
      context: {
        triggerKind:
          context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
            ? 2
            : 1,
      },
      formattingOptions: {
        tabSize:
          typeof tabSize === "number" && Number.isFinite(tabSize) ? tabSize : 4,
        insertSpaces: editor.get<boolean>("insertSpaces", true),
      },
    };

    try {
      const result = await client.requestInlineCompletions(
        params,
        token as CancellationTokenLike,
      );
      if (
        token.isCancellationRequested ||
        !isCurrentDocument(
          requestUri,
          requestVersion,
          documentUri(document),
          document.version,
        ) ||
        !Array.isArray(result?.items)
      ) {
        return undefined;
      }
      const items: vscode.InlineCompletionItem[] = [];
      for (const raw of result.items) {
        const item = this.toItem(raw, document, position);
        if (item !== undefined) {
          this.raw.set(item, raw);
          items.push(item);
        }
      }
      return new vscode.InlineCompletionList(items);
    } catch (error) {
      if (
        !token.isCancellationRequested &&
        !(error instanceof Error && error.name === "RequestCancelledError")
      ) {
        this.options.log(
          `Completion request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return undefined;
    }
  }

  public handleDidShowCompletionItem(item: vscode.InlineCompletionItem): void {
    const raw = this.raw.get(item);
    if (raw !== undefined) {
      this.options.getClient()?.notifyCompletionShown(raw);
    }
  }

  /**
   * The extension host calls this twice per partial accept: once with the
   * accepted length (the deprecated shape) and once with a `PartialAcceptInfo`.
   * The length is what the server wants, so only that call is forwarded.
   */
  public handleDidPartiallyAcceptCompletionItem(
    item: vscode.InlineCompletionItem,
    info: vscode.PartialAcceptInfo | number,
  ): void {
    const raw = this.raw.get(item);
    if (raw !== undefined && typeof info === "number") {
      this.options.getClient()?.notifyCompletionPartiallyAccepted(raw, info);
    }
  }

  private toItem(
    raw: LspInlineCompletionItem,
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.InlineCompletionItem | undefined {
    if (typeof raw.insertText !== "string") {
      return undefined;
    }
    const range = toRange(
      raw.range ?? { start: position, end: position },
      document,
    );
    if (range === undefined) {
      return undefined;
    }
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const text = normalizeNewlines(raw.insertText, eol);
    const item = new vscode.InlineCompletionItem(
      raw.insertTextFormat === 2 ? new vscode.SnippetString(text) : text,
      range,
    );
    item.command = acceptCommand(raw.command);
    return item;
  }
}

export function acceptCommand(
  command: LspCommand | undefined,
): vscode.Command | undefined {
  if (command === undefined || typeof command.command !== "string") {
    return undefined;
  }
  return {
    title: command.title ?? "Accept Copilot suggestion",
    command: EXECUTE_SERVER_COMMAND,
    arguments: [command],
  };
}

export function toRange(
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  },
  document: vscode.TextDocument,
): vscode.Range | undefined {
  if (!isValidLspPosition(range.start) || !isValidLspPosition(range.end)) {
    return undefined;
  }
  if (
    range.start.line > range.end.line ||
    (range.start.line === range.end.line &&
      range.start.character > range.end.character)
  ) {
    return undefined;
  }
  return document.validateRange(
    new vscode.Range(
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
    ),
  );
}
