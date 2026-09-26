/**
 * Which way to open a folder that defines a Dev Container.
 *
 * A folder with a `devcontainer.json` in it can be opened two ways, and
 * neither is wrong. Either way it is the same Workspace, and its terminals and
 * Agents run on this Mac; what the answer decides is where its *editor* is —
 * here, or in the container, with the toolchain and the language servers the
 * definition's author chose, at the version they pinned.
 *
 * So it is a question, asked once, at the moment the answer is needed. Not a
 * setting: a setting would have to be found before the first time anyone knew
 * they wanted it, and it would then be wrong for the next folder. Not a guess
 * either — a folder having a definition does not mean the person wants the
 * container this minute, and silently building an image because a file exists
 * is a minute of somebody's time DevHub decided to spend for them.
 *
 * The question is only asked of folders that have one, so nobody who does not
 * use dev containers ever sees it — and of folders DevHub could not check,
 * because "could not check" is not "has none". Opening such a folder here
 * without a word would be answering a question nobody got an answer to. The
 * sheet says the check failed and why, and offers the same two ways with the
 * folder first: it is the one that does not depend on the missing answer.
 */

import type { DevContainerConfigWire } from "../../../ipc/contract";
import { Picker } from "./Picker";

const OPEN_HERE = "devhub:open-here";
const OPEN_IN_CONTAINER = "devhub:open-in-container:";

/**
 * The crate from the Sidebar's row mark, redrawn to this sheet's 16-unit box.
 *
 * The same silhouette a row wears when its editor is in a container, so the
 * thing chosen here and the mark it becomes are recognisably the same thing.
 */
function ContainerGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.4 4.8h11.2v6.4H2.4zM5.6 4.8v6.4M8 4.8v6.4M10.4 4.8v6.4" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 4.4a1 1 0 0 1 1-1h3l1.2 1.6H13a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

/** What the probe of a folder said, when it said anything but "none". */
export type DevContainerDefinition =
  | {
      readonly kind: "found";
      readonly configs: readonly DevContainerConfigWire[];
    }
  | { readonly kind: "unchecked"; readonly reason: string };

/**
 * What the person answered: the folder here, or its editor in one of its
 * containers — `configPath` absent when the definitions could not be listed,
 * which main answers with the first of them.
 */
export type DevContainerChoice =
  | { readonly kind: "here" }
  | { readonly kind: "container"; readonly configPath?: string };

export interface DevContainerSheetProps {
  /** The folder on this Mac, as the person chose it. */
  readonly folder: string;
  readonly definition: DevContainerDefinition;
  readonly step: number;
  readonly onChoose: (choice: DevContainerChoice) => void;
  readonly onCancel: () => void;
}

export function DevContainerSheet({
  folder,
  definition,
  step,
  onChoose,
  onCancel,
}: DevContainerSheetProps) {
  // One row per definition when they could be listed: a folder with several
  // (`.devcontainer/<name>/`) is asked which, because each is a different
  // container. What it costs is said before it is spent: the first open of a
  // definition that has never been built is an image build, and a person who
  // did not expect one reads a long pause as a hang.
  const containers =
    definition.kind === "found"
      ? definition.configs.map((config) => ({
          id: `${OPEN_IN_CONTAINER}${config.path}`,
          label:
            config.label === undefined
              ? "Open in Dev Container"
              : `Open in Dev Container: ${config.label}`,
          detail: `Build or start the container ${config.path} describes`,
          glyph: <ContainerGlyph />,
        }))
      : [
          {
            id: OPEN_IN_CONTAINER,
            label: "Open in Dev Container",
            detail:
              "Build or start the container the folder's definition describes, if it has one",
            glyph: <ContainerGlyph />,
          },
        ];
  const here = {
    id: OPEN_HERE,
    label: "Open the folder",
    detail: "Its editor on this Mac, as usual",
    glyph: <FolderGlyph />,
  };
  return (
    <Picker
      title="Open in a Dev Container?"
      question={
        definition.kind === "found"
          ? `${folder} defines a Dev Container. Where should its editor run? Its terminals and agents run on this Mac either way.`
          : `DevHub could not check whether ${folder} defines a Dev Container. Where should its editor run?`
      }
      step={step}
      // A definition found puts the containers first, because they are why
      // this sheet appeared at all: the folder said so itself. A check that
      // failed puts the folder first. The other answer is one key away.
      items={
        definition.kind === "found"
          ? [...containers, here]
          : [here, ...containers]
      }
      note={
        definition.kind === "unchecked" ? (
          <span className="picker-note-failure">{definition.reason}</span>
        ) : undefined
      }
      onChoose={(choice) => {
        if (choice.id === OPEN_HERE) {
          onChoose({ kind: "here" });
          return;
        }
        const configPath = choice.id.slice(OPEN_IN_CONTAINER.length);
        onChoose(
          configPath.length === 0
            ? { kind: "container" }
            : { kind: "container", configPath },
        );
      }}
      onCancel={onCancel}
    />
  );
}
