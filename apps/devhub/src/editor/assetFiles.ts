/**
 * Reading, through the connection, what the browser loads from the host.
 *
 * `resourceUriProvider` answers where the *browser* can load a file the
 * server has on disk, and the answer is an address the host serves. But the
 * Workbench also reads some of those files itself — an icon theme's JSON, a
 * language configuration — and it decides how by looking at that same
 * browser-facing address: anything that is not an ordinary web address it
 * hands to the file service, which had never heard of this one.
 *
 * So the file service is taught it. One file has one address here and one
 * way to read it; the two consumers just spell it differently, and this is
 * the translation between the spellings.
 */
import { registerCustomProvider } from "@codingame/monaco-vscode-files-service-override";
import {
  FileSystemProviderCapabilities,
  FileType,
  type IFileSystemProvider,
  type IStat,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files";
import { getService, IFileService } from "@codingame/monaco-vscode-api";
import * as monaco from "monaco-editor";

/** The scheme Tauri serves local files under. */
export const ASSET_SCHEME = "asset";

const nothingEverChanges = () => ({ dispose: () => {} });

/**
 * The file this asset address names, back in the terms the connection uses.
 *
 * The address carries the server's absolute path, percent-encoded by the host
 * so it survives being a URL. Leading slashes vary with how the address was
 * built; the path itself starts at the first one.
 */
function remoteEquivalent(resource: monaco.Uri, authority: string): monaco.Uri {
  const path = decodeURIComponent(resource.path.replace(/^\/+/, "/"));
  return monaco.Uri.from({ scheme: "vscode-remote", authority, path });
}

/**
 * Let the file service read `asset:` addresses, by reading the file they name
 * over the connection that is already open.
 *
 * Must be called before the services start: a provider registered afterwards
 * would race the first icon theme, and a race is not a thing to get right
 * once — it is a thing to be wrong at intermittently.
 */
export function registerAssetFiles(authority: string): void {
  const unsupported = (): never => {
    // Nothing writes here, and a caller that tries has misunderstood what
    // this is rather than hit a limitation to work around.
    throw new Error("asset: addresses are read-only");
  };

  const provider: IFileSystemProvider = {
    capabilities:
      FileSystemProviderCapabilities.FileReadWrite |
      FileSystemProviderCapabilities.Readonly |
      FileSystemProviderCapabilities.PathCaseSensitive,
    onDidChangeCapabilities: nothingEverChanges,
    onDidChangeFile: nothingEverChanges,
    watch: () => ({ dispose: () => {} }),
    async stat(resource: monaco.Uri): Promise<IStat> {
      const files = await getService(IFileService);
      const stat = await files.stat(remoteEquivalent(resource, authority));
      return {
        type: FileType.File,
        ctime: stat.ctime ?? 0,
        mtime: stat.mtime ?? 0,
        size: stat.size ?? 0,
      };
    },
    async readFile(resource: monaco.Uri): Promise<Uint8Array> {
      const files = await getService(IFileService);
      const file = await files.readFile(remoteEquivalent(resource, authority));
      return file.value.buffer;
    },
    mkdir: unsupported,
    readdir: unsupported,
    delete: unsupported,
    rename: unsupported,
    writeFile: unsupported,
  };

  registerCustomProvider(ASSET_SCHEME, provider);
}
