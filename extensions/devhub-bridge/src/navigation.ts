import { normalizedAbsolutePath } from "./registry";

export type NavigationRequest =
  | { kind: "open_workspace"; path: string }
  | { kind: "new_window"; path: string | null };

/** Parse the URI shape delivered by VS Code's registered extension URI handler. */
export function parseNavigationUri(
  input: {
    scheme: string;
    path: string;
    query: string;
  },
  expectedScheme: string,
): NavigationRequest | null {
  if (!expectedScheme || input.scheme !== expectedScheme) return null;
  if (input.path !== "/open-workspace" && input.path !== "/new-window")
    return null;
  let rawPath: string | null = null;
  if (input.query !== "") {
    for (const part of input.query.split("&")) {
      const separator = part.indexOf("=");
      if (separator < 1) return null;
      let key: string;
      let value: string;
      try {
        key = decodeURIComponent(part.slice(0, separator).replace(/\+/g, " "));
        value = decodeURIComponent(
          part.slice(separator + 1).replace(/\+/g, " "),
        );
      } catch {
        return null;
      }
      if (key !== "path" || rawPath !== null) return null;
      rawPath = value;
    }
  }
  const path = rawPath === null ? null : normalizedAbsolutePath(rawPath);
  if (input.path === "/open-workspace") {
    return path ? { kind: "open_workspace", path } : null;
  }
  return { kind: "new_window", path };
}
