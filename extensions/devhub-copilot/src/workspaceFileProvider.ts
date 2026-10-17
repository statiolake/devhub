import * as vscode from "vscode";
import type {
  LspWatchedFilesRequestParams,
  LspWatchedFilesResponse,
} from "./lspTypes";

const DEFAULT_EXCLUDES = ["**/.git/**", "**/node_modules/**"];

/**
 * Supplies the file inventory requested by the Copilot Language Server's
 * custom copilot/watchedFiles request. File discovery remains in the VS Code
 * adapter so the LSP client never needs local filesystem assumptions.
 */
export class WorkspaceFileProvider {
  public constructor(
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  public async provide(
    params: LspWatchedFilesRequestParams,
  ): Promise<LspWatchedFilesResponse> {
    const folder = findWorkspaceFolder(params.workspaceUri);
    if (folder === undefined) {
      this.log(
        `Language Server requested files for an unknown workspace: ${params.workspaceUri}`,
      );
      return { files: [] };
    }

    const excludes = new Set(DEFAULT_EXCLUDES);
    if (params.excludeIDEIgnoredFiles === true) {
      addConfiguredExcludes(
        excludes,
        vscode.workspace
          .getConfiguration("files", folder.uri)
          .get<Record<string, boolean>>("exclude"),
      );
      addConfiguredExcludes(
        excludes,
        vscode.workspace
          .getConfiguration("search", folder.uri)
          .get<Record<string, boolean>>("exclude"),
      );
    }

    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder.uri, "**/*"),
      toExcludePattern(excludes),
    );
    this.log(
      `Language Server workspace inventory: ${files.length} file(s) for ${folder.name}.`,
    );
    return { files: files.map((uri) => uri.toString()) };
  }
}

function findWorkspaceFolder(
  workspaceUri: string,
): vscode.WorkspaceFolder | undefined {
  return (
    vscode.workspace.workspaceFolders?.find(
      (folder) => folder.uri.toString() === workspaceUri,
    ) ?? vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(workspaceUri))
  );
}

function addConfiguredExcludes(
  target: Set<string>,
  configured: Record<string, boolean> | undefined,
): void {
  if (configured === undefined) {
    return;
  }
  for (const [pattern, enabled] of Object.entries(configured)) {
    if (enabled) {
      target.add(pattern);
    }
  }
}

function toExcludePattern(patterns: Set<string>): string | undefined {
  const values = [...patterns];
  if (values.length === 0) {
    return undefined;
  }
  if (values.length === 1) {
    return values[0];
  }
  return `{${values.join(",")}}`;
}
