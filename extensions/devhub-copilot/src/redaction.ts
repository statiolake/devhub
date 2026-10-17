const sensitiveKeyPattern =
  /token|secret|password|authorization|cookie|user.?code|device.?code|credential|private.?key/i;

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+\b/g, "[REDACTED]");
}

export function redactSecrets(value: unknown, key?: string): unknown {
  if (key !== undefined && sensitiveKeyPattern.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = redactSecrets(entryValue, entryKey);
    }
    return result;
  }

  return value;
}

export function redactLogMessage(message: string): string {
  return redactText(message);
}
