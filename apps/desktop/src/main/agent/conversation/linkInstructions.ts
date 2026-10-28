/**
 * What DevHub tells every GUI Agent about naming files: write each file it
 * mentions as a Markdown link to the local path, so the person can click it
 * open in DevHub's editor (`docs/agent-gui.md`, "File paths open in the
 * editor").
 *
 * A bare word is linked only when it names one file, and `a.ts` in a
 * Workspace with three of them names whichever the Agent's directory finds
 * first; a link to GitHub opens the browser, not the file the Agent edited. A
 * Markdown link to the path says which file, and the conversation opens it
 * (`ExternalLink` in `shell/conversation/Markdown.tsx`, read by `pathOfHref`
 * against the Agent's directory).
 *
 * The position is asked for as `#L12` / `#L12-L20` only: the transcript's
 * Markdown drops a target whose first `:` comes before any `/` as an unknown
 * scheme, so `[a.ts:12](a.ts:12)` for a file at the top of the Workspace —
 * and every `file:` URL — would be drawn as a link to nothing. `#L` survives
 * in every path.
 *
 * Only GUI Agents are told: their transcript renders Markdown links, and a
 * terminal's would only show the brackets. Claude gets it as
 * `--append-system-prompt` (`claude/argv.ts`), Codex in the thread's
 * `developerInstructions` (`devhubSkill.ts`, `codexGuiInstructions`). Both
 * are sent again every time the CLI starts or a thread is resumed, so a
 * resumed session is told too.
 */
export const FILE_LINK_INSTRUCTIONS = [
	"File links: this conversation is shown in DevHub, which opens Markdown links to local files in the editor.",
	"Whenever you mention a file, write it as a Markdown link whose target is its local path relative to your working directory (absolute only for files outside it),",
	"with the line as #L42 or a range as #L42-L50, e.g. [src/app.ts:42](src/app.ts#L42) or [README.md](README.md).",
	"Put a target that contains spaces in angle brackets: [my file.ts](<docs/my file.ts#L3>).",
	"Never link a GitHub or other remote URL for a file that is on this machine.",
].join(" ");

/**
 * What every GUI Agent is told about diagrams: the transcript draws a closed
 * ```mermaid block as a diagram and a ```svg block as an image
 * (`shell/conversation/Diagram.tsx`), each with its source a click away. An
 * SVG is drawn as an image, so a script or an external reference in it would
 * do nothing; it is asked to be self-contained so that it draws at all.
 */
export const DIAGRAM_INSTRUCTIONS = [
	"Diagrams: DevHub draws a ```mermaid fenced block as a diagram and a ```svg block (one self-contained <svg>, no scripts or external resources; currentColor follows the theme) as an image.",
	"Use one when a picture explains better than prose (architecture, data flow, a sequence of calls, a state machine), keep it small and focused, and do not draw one where a sentence or a list will do.",
].join(" ");

/**
 * Everything DevHub appends to a GUI Agent's instructions, in this order:
 * Claude's `--append-system-prompt` and Codex's `developerInstructions`.
 * One line: it is a command-line argument, and an Agent host is handed its
 * CLI's arguments one per line (`hostLink.ts`).
 */
export const GUI_AGENT_INSTRUCTIONS = [
	FILE_LINK_INSTRUCTIONS,
	DIAGRAM_INSTRUCTIONS,
].join(" ");
