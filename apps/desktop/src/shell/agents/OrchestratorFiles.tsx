/**
 * The Orchestrator screen's Files tab: the orchestrator's folder — where it
 * keeps what it decided (`decisions.md`) and its skills (`.claude/skills`) —
 * as a tree, and a file pushed over it, read-only.
 *
 * Main reads and watches the folder (`main/orchestrator/orchestratorFiles.ts`,
 * confined to the root); this only asks. Markdown is drawn by the
 * conversation's own renderer, other text as a highlighted code block, and
 * images inline. "エディタで開く" opens the file in the root Workspace's
 * workbench, the way `devhub <file>` would.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  OrchestratorFileWire,
  OrchestratorFolderWire,
} from "../../ipc/contract";
import { useAgents } from "./AgentsContext";
import { devhub } from "./client";
import { focusIsOurs, useNavStack } from "./navStack";
import { RichText } from "./orchestratorRichText";
import type { SideButtons } from "./OrchestratorScreen";

/** A text file as Markdown: one fenced block, fenced longer than any run. */
export function codeBlock(text: string, language: string | undefined): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/gu)].map((run) => run[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language ?? ""}\n${text.replace(/\n$/u, "")}\n${fence}`;
}

export function FilesPage({
  pane,
  sideButtons,
  orchestratorAgentId,
}: {
  readonly pane: RefObject<HTMLElement | null>;
  readonly sideButtons: RefObject<SideButtons>;
  readonly orchestratorAgentId: string | undefined;
}) {
  const { reportFailure } = useAgents();
  const [folders, setFolders] = useState<
    ReadonlyMap<string, OrchestratorFolderWire>
  >(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [files, setFiles] = useState<ReadonlyMap<string, OrchestratorFileWire>>(
    () => new Map(),
  );
  const tree = useRef<HTMLDivElement>(null);
  const stack = useNavStack<string>(pane, (path) =>
    [
      ...(tree.current?.querySelectorAll<HTMLElement>("[data-file-path]") ??
        []),
    ].find((row) => row.dataset["filePath"] === path),
  );
  const { nav, shown, forward, open, close } = stack;

  const load = useCallback(async (path: string) => {
    try {
      const folder = await devhub().listOrchestratorFolder(path);
      setFolders((before) => new Map(before).set(path, folder));
    } catch {
      // A folder that went away: it is no longer listed.
      setFolders((before) => {
        const after = new Map(before);
        after.delete(path);
        return after;
      });
    }
  }, []);
  const read = useCallback(
    async (path: string) => {
      try {
        const file = await devhub().readOrchestratorFile(path);
        setFiles((before) => new Map(before).set(path, file));
      } catch (error: unknown) {
        reportFailure(error);
      }
    },
    [reportFailure],
  );
  const openFile = useCallback(
    (path: string) => {
      open(path);
      void read(path);
    },
    [open, read],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  // Live: the orchestrator writes `decisions.md`, and the tree and the file
  // on screen follow, a moment later (main debounces).
  const watching = useRef({ expanded, shown });
  watching.current = { expanded, shown };
  useEffect(
    () =>
      devhub().onOrchestratorFilesChanged((paths) => {
        const now = watching.current;
        for (const folder of ["", ...now.expanded]) void load(folder);
        const path = now.shown;
        if (
          path !== undefined &&
          (paths.includes("") ||
            paths.some((one) => one === path || path.startsWith(`${one}/`)))
        )
          void read(path);
      }),
    [load, read],
  );

  useEffect(() => {
    sideButtons.current = (direction) => {
      if (direction === "back" && nav === "push") {
        close();
        return true;
      }
      if (direction === "forward" && nav !== "push" && forward !== undefined) {
        openFile(forward);
        return true;
      }
      return false;
    };
  }, [sideButtons, nav, forward, close, openFile]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((before) => {
        const after = new Set(before);
        if (after.has(path)) after.delete(path);
        else {
          after.add(path);
          void load(path);
        }
        return after;
      });
    },
    [load],
  );

  const root = folders.get("");
  const reading = nav === "push";
  return (
    <div
      className="orchestrator-stage"
      data-nav={nav}
      role="tabpanel"
      id="orchestrator-panel-files"
      aria-labelledby="orchestrator-tab-files"
    >
      <div
        ref={tree}
        className="orchestrator-files orchestrator-layer"
        data-layer="under"
        inert={reading}
        aria-hidden={reading ? true : undefined}
      >
        {root === undefined ? null : root.problem !== undefined ? (
          <p className="orchestrator-lane-empty">{root.problem}</p>
        ) : (
          <>
            <div className="orchestrator-files-root" title={root.root}>
              {root.root}
            </div>
            {root.entries.length === 0 ? (
              <p className="orchestrator-lane-empty">The folder is empty.</p>
            ) : (
              <ul className="orchestrator-tree" role="tree" aria-label="Files">
                <Entries
                  folder={root}
                  depth={0}
                  folders={folders}
                  expanded={expanded}
                  onToggle={toggle}
                  onOpen={openFile}
                />
              </ul>
            )}
          </>
        )}
      </div>
      {shown === undefined ? null : (
        <FileView
          key={shown}
          path={shown}
          file={files.get(shown)}
          leaving={!reading}
          agentId={orchestratorAgentId}
          folderRoot={root?.root}
          onBack={() => {
            close();
          }}
          onOpenInEditor={() => {
            void devhub().openOrchestratorFile(shown).catch(reportFailure);
          }}
        />
      )}
    </div>
  );
}

function Entries({
  folder,
  depth,
  folders,
  expanded,
  onToggle,
  onOpen,
}: {
  readonly folder: OrchestratorFolderWire;
  readonly depth: number;
  readonly folders: ReadonlyMap<string, OrchestratorFolderWire>;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (path: string) => void;
  readonly onOpen: (path: string) => void;
}) {
  return (
    <>
      {folder.entries.map((entry) => {
        const isOpen = entry.kind === "directory" && expanded.has(entry.path);
        const inside = isOpen ? folders.get(entry.path) : undefined;
        return (
          <li
            key={entry.path}
            role="treeitem"
            aria-expanded={entry.kind === "directory" ? isOpen : undefined}
            aria-selected={false}
          >
            <button
              type="button"
              className="orchestrator-file-row"
              data-kind={entry.kind}
              data-file-path={entry.path}
              style={{ paddingLeft: `${String(8 + depth * 14)}px` }}
              title={entry.path}
              onClick={() => {
                if (entry.kind === "directory") onToggle(entry.path);
                else onOpen(entry.path);
              }}
            >
              <span className="orchestrator-file-chevron" aria-hidden="true">
                {entry.kind === "directory" ? (isOpen ? "▾" : "▸") : ""}
              </span>
              <span className="orchestrator-file-name">{entry.name}</span>
            </button>
            {inside === undefined || inside.entries.length === 0 ? null : (
              <ul role="group" className="orchestrator-tree">
                <Entries
                  folder={inside}
                  depth={depth + 1}
                  folders={folders}
                  expanded={expanded}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

function FileView({
  path,
  file,
  leaving,
  agentId,
  folderRoot,
  onBack,
  onOpenInEditor,
}: {
  readonly path: string;
  readonly file: OrchestratorFileWire | undefined;
  readonly leaving: boolean;
  readonly agentId: string | undefined;
  /** The folder's root, absolute: what the file's relative paths start from. */
  readonly folderRoot: string | undefined;
  readonly onBack: () => void;
  readonly onOpenInEditor: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Opened: focus goes to the file, and only from inside the pane.
  useEffect(() => {
    const pane =
      root.current?.closest<HTMLElement>(".orchestrator-board") ?? null;
    if (focusIsOurs(pane)) body.current?.focus({ preventScroll: true });
  }, []);
  const name = path.split("/").at(-1) ?? path;
  const folder = path.slice(0, Math.max(0, path.length - name.length - 1));
  return (
    <div
      ref={root}
      className="orchestrator-reading orchestrator-file-view orchestrator-layer"
      data-layer="over"
      inert={leaving}
      aria-hidden={leaving ? true : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onBack();
        }
      }}
    >
      <div className="orchestrator-reading-head">
        <button
          type="button"
          className="orchestrator-back"
          onClick={onBack}
          aria-label="Back to the files"
          title="Back to the files (Esc)"
        >
          <span aria-hidden="true">←</span> ファイル
        </button>
        <div className="orchestrator-reading-title">
          <h2>{name}</h2>
          <button
            type="button"
            className="orchestrator-chip is-link orchestrator-open-editor"
            title="Open it in the workbench of its Workspace"
            onClick={onOpenInEditor}
          >
            エディタで開く
          </button>
        </div>
        {folder === "" ? null : (
          <div className="orchestrator-file-folder">{folder}/</div>
        )}
      </div>
      <div
        ref={body}
        className="orchestrator-thread orchestrator-file-body conversation-selectable"
        tabIndex={-1}
        aria-label={path}
      >
        <FileBody
          file={file}
          agentId={agentId}
          cwd={
            folderRoot === undefined
              ? undefined
              : folder === ""
                ? folderRoot
                : `${folderRoot}/${folder}`
          }
        />
      </div>
    </div>
  );
}

function FileBody({
  file,
  agentId,
  cwd,
}: {
  readonly file: OrchestratorFileWire | undefined;
  readonly agentId: string | undefined;
  readonly cwd: string | undefined;
}) {
  if (file === undefined) return null;
  switch (file.kind) {
    case "markdown":
      return <RichText source={file.text ?? ""} agentId={agentId} cwd={cwd} />;
    case "text":
      return (
        <RichText
          source={codeBlock(file.text ?? "", file.language)}
          agentId={agentId}
        />
      );
    case "image":
      return (
        <img
          className="orchestrator-file-image"
          src={file.dataUrl}
          alt={file.path}
        />
      );
    case "binary":
      return (
        <p className="orchestrator-closed-note">
          Not a text file. エディタで開く opens it in the workbench.
        </p>
      );
    case "too_large":
      return (
        <p className="orchestrator-closed-note">
          Too large to show here. エディタで開く opens it in the workbench.
        </p>
      );
  }
}
