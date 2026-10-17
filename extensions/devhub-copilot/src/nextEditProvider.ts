import * as vscode from "vscode";
import {
  acceptCommand,
  toRange,
  type ProviderOptions,
} from "./completionProvider";
import { documentUri, shouldSynchronizeDocument } from "./documentSynchronizer";
import type { CancellationTokenLike } from "./jsonRpc";
import type { LspNextEdit } from "./lspTypes";
import { parseNextEditResponse, type ParsedNextEdit } from "./nesProtocol";
import { normalizeNewlines } from "./protocol";

/**
 * Copilot's Next Edit Suggestions, `textDocument/copilotInlineEdit`, handed to
 * the editor as inline edits.
 *
 * `isInlineEdit` is the whole difference between this and ghost text. The
 * editor turns an item that has it into an `InlineEditItem`
 * (`inlineSuggestionItem.ts`, `InlineSuggestionItem.create`) and draws it
 * with the inline edit views: the gutter indicator and its menu, the
 * side-by-side and word-replacement views, the jump hint and Tab to jump.
 * An item without it is ghost text, which is dropped whenever it is not a
 * continuation at the cursor (`inlineCompletionsModel.ts`,
 * `_inlineSuggestionItems`). The extension host forwards `isInlineEdit`,
 * `showInlineEditMenu` and `correlationId` only for an extension that is
 * granted `inlineCompletionsAdditions` (`extHostLanguageFeatures.ts`,
 * `InlineCompletionAdapter`), which scripts/product_metadata.py does for this
 * one.
 *
 * The editor asks on every edit, debounces, cancels what an edit made stale,
 * and shows an inline edit only while no ghost text is visible, so neither
 * provider needs to know about the other.
 */
export class NextEditProvider implements vscode.InlineCompletionItemProvider {
  private readonly raw = new WeakMap<
    vscode.InlineCompletionItem,
    LspNextEdit
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
    // The suggest widget is open: the editor shows only items that extend
    // its selection then, and an edit elsewhere never does.
    if (context.selectedCompletionInfo !== undefined) {
      return undefined;
    }
    const client = this.options.getClient();
    if (client === undefined || !client.isReady) {
      return undefined;
    }

    const uri = documentUri(document);
    const version = document.version;
    try {
      const result = await client.requestNextEditSuggestions(
        {
          textDocument: { uri, version },
          position: { line: position.line, character: position.character },
        },
        token as CancellationTokenLike,
      );
      if (token.isCancellationRequested || document.version !== version) {
        return undefined;
      }
      const items: vscode.InlineCompletionItem[] = [];
      for (const candidate of parseNextEditResponse(result)) {
        const item = this.toItem(candidate, document, uri, version);
        if (item !== undefined) {
          this.raw.set(item, candidate.raw);
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
          `Next edit request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return undefined;
    }
  }

  public handleDidShowCompletionItem(item: vscode.InlineCompletionItem): void {
    const raw = this.raw.get(item);
    if (raw !== undefined) {
      this.options.getClient()?.notifyNextEditShown(raw);
    }
  }

  private toItem(
    candidate: ParsedNextEdit,
    document: vscode.TextDocument,
    uri: string,
    version: number,
  ): vscode.InlineCompletionItem | undefined {
    const { suggestion } = candidate;
    if (
      suggestion.documentUri !== uri ||
      suggestion.documentVersion !== version
    ) {
      return undefined;
    }
    const range = toRange(suggestion.range, document);
    // A range the document does not have is a stale answer, not one to clamp.
    if (
      range === undefined ||
      range.start.line !== suggestion.range.start.line ||
      range.start.character !== suggestion.range.start.character ||
      range.end.line !== suggestion.range.end.line ||
      range.end.character !== suggestion.range.end.character
    ) {
      return undefined;
    }
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const text = normalizeNewlines(suggestion.newText, eol);
    if (document.getText(range) === text) {
      return undefined;
    }
    const item = new vscode.InlineCompletionItem(text, range);
    item.isInlineEdit = true;
    item.showInlineEditMenu = true;
    item.correlationId = suggestion.id;
    item.command = acceptCommand(suggestion.acceptCommand);
    return item;
  }
}
