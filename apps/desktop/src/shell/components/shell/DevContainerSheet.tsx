/**
 * Which way to open a folder that defines a Dev Container.
 *
 * A folder with a `devcontainer.json` in it can be opened two ways, and
 * neither is wrong. Opening it here is what every other folder does: this
 * Mac's tools, this Mac's terminal. Opening it in the container is what the
 * file in the folder is *for* — the toolchain its author chose, at the version
 * they pinned.
 *
 * So it is a question, asked once, at the moment the answer is needed. Not a
 * setting: a setting would have to be found before the first time anyone knew
 * they wanted it, and it would then be wrong for the next folder. Not a guess
 * either — a folder having a definition does not mean the person wants the
 * container this minute, and silently building an image because a file exists
 * is a minute of somebody's time DevHub decided to spend for them.
 *
 * The question is only asked of folders that have one, so nobody who does not
 * use dev containers ever sees it.
 */

import { Picker } from "./Picker";

const OPEN_HERE = "devhub:open-here";
const OPEN_IN_CONTAINER = "devhub:open-in-container";

/**
 * The crate from the Sidebar's rail, redrawn to this sheet's 16-unit box.
 *
 * The same silhouette a container Workspace's row wears, so the thing chosen
 * here and the row it becomes are recognisably the same thing.
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

export interface DevContainerSheetProps {
  /** The folder on this Mac, as the person chose it. */
  readonly folder: string;
  /** The definition that was found, for the row that names it. */
  readonly configPath: string;
  readonly step: number;
  readonly onChoose: (inContainer: boolean) => void;
  readonly onCancel: () => void;
}

export function DevContainerSheet({
  folder,
  configPath,
  step,
  onChoose,
  onCancel,
}: DevContainerSheetProps) {
  return (
    <Picker
      title="Open in a Dev Container?"
      question={`${folder} defines a Dev Container. Where should its terminals and agents run?`}
      step={step}
      items={[
        {
          id: OPEN_IN_CONTAINER,
          label: "Open in Dev Container",
          // What it costs, said before it is spent: the first open of a
          // definition that has never been built is an image build, and a
          // person who did not expect one reads a long pause as a hang.
          detail: `Build or start the container ${configPath} describes`,
          glyph: <ContainerGlyph />,
        },
        {
          id: OPEN_HERE,
          label: "Open the folder",
          detail: "Work in it on this Mac, as usual",
          glyph: <FolderGlyph />,
        },
      ]}
      // The container first, because it is why this sheet appeared at all: the
      // folder said so itself. The other answer is one key away either way.
      onChoose={(choice) => {
        onChoose(choice.id === OPEN_IN_CONTAINER);
      }}
      onCancel={onCancel}
    />
  );
}
