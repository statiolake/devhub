const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_SURFACES = 128;

export interface SurfaceRegistryEntry {
  surface_id: string;
  workspace_id: string | null;
  canonical_root: string | null;
}

function normalizedAbsolutePath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.includes("\0"))
    return null;
  const components = raw.split("/");
  const normalized: string[] = [];
  for (const component of components) {
    if (!component || component === ".") continue;
    if (component === "..") return null;
    normalized.push(component);
  }
  return `/${normalized.join("/")}` || "/";
}

/**
 * Parse the EditorHost-owned registry. This intentionally mirrors the Rust
 * registry document shape and rejects unknown fields so an extension never
 * invents an identity when the owner changes its contract.
 */
export function parseSurfaceRegistry(
  input: string | Uint8Array,
): SurfaceRegistryEntry[] | null {
  try {
    const bytes =
      typeof input === "string" ? new TextEncoder().encode(input) : input;
    if (bytes.byteLength > MAX_REGISTRY_BYTES) return null;
    const source =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true }).decode(input);
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const document = parsed as Record<string, unknown>;
    if (
      Object.keys(document).sort().join(",") !== "surfaces,version" ||
      document.version !== 1 ||
      !Array.isArray(document.surfaces) ||
      document.surfaces.length > MAX_SURFACES
    )
      return null;

    const entries: SurfaceRegistryEntry[] = [];
    const surfaceIds = new Set<string>();
    const workspaceIds = new Set<string>();
    let globalSeen = false;
    for (const raw of document.surfaces) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const item = raw as Record<string, unknown>;
      if (
        Object.keys(item).sort().join(",") !==
        "canonical_root,surface_id,workspace_id"
      )
        return null;
      if (
        typeof item.surface_id !== "string" ||
        !UUID_RE.test(item.surface_id) ||
        (item.workspace_id !== null &&
          (typeof item.workspace_id !== "string" ||
            !UUID_RE.test(item.workspace_id))) ||
        (item.canonical_root !== null &&
          typeof item.canonical_root !== "string")
      )
        return null;
      const root =
        item.canonical_root === null
          ? null
          : normalizedAbsolutePath(item.canonical_root);
      if (
        item.canonical_root !== null &&
        (!root || root !== item.canonical_root)
      )
        return null;
      if ((item.workspace_id === null) !== (item.canonical_root === null))
        return null;
      if (item.workspace_id === null && globalSeen) return null;
      if (
        surfaceIds.has(item.surface_id) ||
        (item.workspace_id !== null && workspaceIds.has(item.workspace_id))
      )
        return null;
      surfaceIds.add(item.surface_id);
      if (item.workspace_id !== null) workspaceIds.add(item.workspace_id);
      else globalSeen = true;
      entries.push({
        surface_id: item.surface_id,
        workspace_id: item.workspace_id,
        canonical_root: root,
      });
    }
    return entries;
  } catch {
    return null;
  }
}

export function findSurfaceForRoot(
  entries: readonly SurfaceRegistryEntry[],
  canonicalRoot: string | null,
): SurfaceRegistryEntry | null {
  const matches = entries.filter(
    (entry) => entry.canonical_root === canonicalRoot,
  );
  return matches.length === 1 ? matches[0] : null;
}

export { normalizedAbsolutePath };
