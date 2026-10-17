export function normalizeNewlines(text: string, eol: "\n" | "\r\n"): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

export function isCurrentDocumentVersion(
  expectedVersion: number,
  currentVersion: number,
): boolean {
  return expectedVersion === currentVersion;
}

export function isCurrentDocument(
  expectedUri: string,
  expectedVersion: number,
  currentUri: string,
  currentVersion: number,
): boolean {
  return (
    expectedUri === currentUri &&
    isCurrentDocumentVersion(expectedVersion, currentVersion)
  );
}

export function utf16Length(text: string): number {
  return [...text].reduce(
    (length, codePoint) =>
      length + (codePoint.codePointAt(0)! > 0xffff ? 2 : 1),
    0,
  );
}

export function isValidLspPosition(position: {
  line: number;
  character: number;
}): boolean {
  return (
    Number.isInteger(position.line) &&
    Number.isInteger(position.character) &&
    position.line >= 0 &&
    position.character >= 0
  );
}
