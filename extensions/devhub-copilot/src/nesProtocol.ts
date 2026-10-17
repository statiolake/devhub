import type {
  LspCommand,
  LspNextEdit,
  LspNextEditResponse,
  LspRange,
} from "./lspTypes";
import { copyRange, type NextEditSuggestion } from "./nesModel";

export interface ParsedNextEdit {
  suggestion: NextEditSuggestion;
  raw: LspNextEdit;
}

export function parseNextEditResponse(result: unknown): ParsedNextEdit[] {
  if (!isRecord(result) || !Array.isArray(result.edits)) {
    return [];
  }

  const parsed: ParsedNextEdit[] = [];
  for (const [index, value] of result.edits.entries()) {
    if (!isLspNextEdit(value)) {
      continue;
    }
    const command = isLspCommand(value.command) ? value.command : undefined;
    const id = nextEditId(value, command, index);
    parsed.push({
      suggestion: {
        id,
        documentUri: value.textDocument.uri,
        documentVersion: value.textDocument.version,
        range: copyRange(value.range),
        newText: value.text,
        acceptCommand: command,
      },
      raw: value,
    });
  }
  return parsed;
}

function isLspNextEdit(value: unknown): value is LspNextEdit {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    !isRecord(value.textDocument) ||
    typeof value.textDocument.uri !== "string" ||
    !Number.isSafeInteger(value.textDocument.version) ||
    !isLspRange(value.range)
  ) {
    return false;
  }
  return true;
}

function isLspRange(value: unknown): value is LspRange {
  return (
    isRecord(value) && isLspPosition(value.start) && isLspPosition(value.end)
  );
}

function isLspPosition(
  value: unknown,
): value is { line: number; character: number } {
  return (
    isRecord(value) &&
    typeof value.line === "number" &&
    typeof value.character === "number" &&
    Number.isSafeInteger(value.line) &&
    Number.isSafeInteger(value.character) &&
    value.line >= 0 &&
    value.character >= 0
  );
}

function isLspCommand(value: unknown): value is LspCommand {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    value.command.length > 0
  );
}

function nextEditId(
  item: LspNextEdit,
  command: LspCommand | undefined,
  index: number,
): string {
  const explicitId = item.id;
  if (typeof explicitId === "string" && explicitId.length > 0) {
    return explicitId;
  }
  const commandId = command?.arguments?.find(
    (argument) => typeof argument === "string",
  );
  if (typeof commandId === "string" && commandId.length > 0) {
    return commandId;
  }
  return `${item.textDocument.uri}:${item.textDocument.version}:${item.range.start.line}:${item.range.start.character}:${index}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
