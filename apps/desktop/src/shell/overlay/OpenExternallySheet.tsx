/**
 * "Open this workspace outside DevHub": where should the folder go?
 *
 * `Cmd+Q O`. A picker rather than a menu, because every list of choices in
 * DevHub is one — see `Picker`'s own docstring for the rule.
 *
 * **There is one row, and that is not an oversight.** The Finder is somewhere
 * DevHub can hand a folder to without knowing anything about the machine.
 * An external terminal is not: DevHub has no configured terminal application,
 * and the choices on this machine — Ghostty, Alacritty, Terminal.app — are not
 * something it can guess. Guessing would open the wrong program for everybody
 * whose terminal is not the one that was guessed, which is a worse answer than
 * offering less. When there is a setting that names a terminal, it becomes a
 * second row here and nothing else changes.
 */

import { Picker } from "../components/shell/Picker";
import { useAppShell } from "../useAppShell";

export interface OpenExternallySheetProps {
  readonly root: string;
  readonly onDismiss: () => void;
}

export function OpenExternallySheet({
  root,
  onDismiss,
}: OpenExternallySheetProps) {
  const { openExternalUrl } = useAppShell();

  return (
    <Picker
      title="Open outside DevHub"
      question={`Where should ${root} be opened?`}
      items={[
        {
          id: "finder",
          label: "Reveal in the Finder",
          detail: root,
        },
      ]}
      note="DevHub has no terminal application configured, so it does not offer to open one — it would have to guess which."
      onChoose={({ id }) => {
        if (id === "finder") {
          // A `file:` URL is what the system opens with the Finder, and it goes
          // out through the one door DevHub already has for handing something
          // to another application.
          openExternalUrl(`file://${root}`);
        }
        onDismiss();
      }}
      onCancel={onDismiss}
    />
  );
}
