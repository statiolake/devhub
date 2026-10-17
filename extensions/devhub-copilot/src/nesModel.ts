import type { LspCommand, LspRange } from "./lspTypes";

export interface NextEditPosition {
  line: number;
  character: number;
}

export interface NextEditRange {
  start: NextEditPosition;
  end: NextEditPosition;
}

export interface NextEditSuggestion {
  id: string;
  documentUri: string;
  documentVersion: number;
  range: NextEditRange;
  newText: string;
  acceptCommand?: LspCommand;
}

export function copyRange(range: LspRange): NextEditRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

export function isValidPosition(position: NextEditPosition): boolean {
  return (
    Number.isInteger(position.line) &&
    Number.isInteger(position.character) &&
    position.line >= 0 &&
    position.character >= 0
  );
}

export function isOrderedRange(range: NextEditRange): boolean {
  return (
    isValidPosition(range.start) &&
    isValidPosition(range.end) &&
    (range.start.line < range.end.line ||
      (range.start.line === range.end.line &&
        range.start.character <= range.end.character))
  );
}

export function isRangeWithinDocument(
  range: NextEditRange,
  lineLengths: readonly number[],
): boolean {
  if (!isOrderedRange(range)) {
    return false;
  }
  if (
    range.start.line >= lineLengths.length ||
    range.end.line >= lineLengths.length
  ) {
    return false;
  }
  return (
    range.start.character <= lineLengths[range.start.line]! &&
    range.end.character <= lineLengths[range.end.line]!
  );
}

export function rangeContainsPosition(
  range: NextEditRange,
  position: NextEditPosition,
): boolean {
  if (!isOrderedRange(range) || !isValidPosition(position)) {
    return false;
  }
  const afterStart =
    position.line > range.start.line ||
    (position.line === range.start.line &&
      position.character >= range.start.character);
  const beforeEnd =
    position.line < range.end.line ||
    (position.line === range.end.line &&
      position.character <= range.end.character);
  return afterStart && beforeEnd;
}
