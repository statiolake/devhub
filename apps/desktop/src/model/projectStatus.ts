/**
 * An Issue's place on GitHub Projects (v2) boards: the lane (the "Status"
 * single-select) it sits in, per board.
 *
 * Pure, and shared by main (which parses the GraphQL answer) and the shell
 * (which draws the letter and the tooltip), so the two cannot disagree.
 */

/** One board the Issue is on, and the lane it is in there. */
export interface ProjectLane {
  readonly project: string;
  /** The Status option's name; absent when the item has no Status set. */
  readonly status?: string;
  /** GitHub's colour name for the option (`GREEN`, `YELLOW`, ...). */
  readonly color?: string;
}

/** The Issue's `projectItems` selection, as GitHub answers it. */
export interface GraphQlProjectItems {
  readonly nodes?:
    | readonly ({
        readonly project?: { readonly title?: string | null } | null;
        readonly fieldValueByName?: {
          readonly name?: string | null;
          readonly color?: string | null;
        } | null;
      } | null)[]
    | null;
}

/** What `projectItems` is asked for, spliced into a query by main. */
export const PROJECT_ITEMS_SELECTION = `projectItems(first:10){ nodes{
      project{ title }
      fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name color } }
    } }`;

/** Boards from an answer; items GitHub could not describe are dropped. */
export function parseProjectLanes(
  items: GraphQlProjectItems | null | undefined,
): ProjectLane[] {
  const lanes: ProjectLane[] = [];
  for (const node of items?.nodes ?? []) {
    const project = node?.project?.title?.trim();
    if (!project) continue;
    const status = node?.fieldValueByName?.name?.trim();
    const color = node?.fieldValueByName?.color?.trim();
    lanes.push({
      project,
      ...(status ? { status } : {}),
      ...(status && color ? { color: color.toUpperCase() } : {}),
    });
  }
  return lanes;
}

const WORDY = /[\p{L}\p{N}]/u;

/**
 * The first letter of the status's last word, upper-cased: "In Progress" is P.
 * Words split on whitespace, punctuation and symbols (so emoji are skipped). A
 * Japanese name has no spaces, so it is its first character. Undefined when
 * nothing letter-like is there.
 */
export function statusLetter(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const words = status
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((word) => WORDY.test(word));
  const last = words[words.length - 1];
  if (last === undefined) return undefined;
  const first = Array.from(last).find((c) => WORDY.test(c));
  return first?.toLocaleUpperCase();
}

/** The board the badge speaks for: one named like the repository, else the first with a status. */
export function primaryLane(
  lanes: readonly ProjectLane[] | undefined,
  repository?: string,
): ProjectLane | undefined {
  if (!lanes?.length) return undefined;
  const withStatus = lanes.filter((l) => statusLetter(l.status) !== undefined);
  const named = repository
    ? withStatus.find(
        (l) => l.project.toLowerCase() === repository.toLowerCase(),
      )
    : undefined;
  return named ?? withStatus[0];
}

/** "Projects: DevHub Roadmap — In Review; Triage". */
export function projectsTooltip(lanes: readonly ProjectLane[]): string {
  const parts = lanes.map((l) =>
    l.status ? `${l.project} — ${l.status}` : l.project,
  );
  return `Projects: ${parts.join("; ")}`;
}

/** Shown in the tooltip when the token cannot read Projects. */
export const PROJECT_SCOPE_HINT =
  "Project status unavailable: run `gh auth refresh -s read:project`";

/** GitHub colour name to a theme token (CSS variable name). */
const COLOR_TOKENS: Readonly<Record<string, string>> = {
  GREEN: "--status-idle",
  BLUE: "--status-waiting",
  YELLOW: "--status-working",
  ORANGE: "--status-working",
  RED: "--danger",
  PINK: "--danger",
  PURPLE: "--status-done",
};

/** Token for a GitHub colour name; undefined (muted) when unknown or GRAY. */
export function laneColorToken(color: string | undefined): string | undefined {
  return color ? COLOR_TOKENS[color.toUpperCase()] : undefined;
}
