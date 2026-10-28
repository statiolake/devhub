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
 * What every GUI Agent is told about rich output: the transcript draws a
 * closed block of each previewable kind (`shell/conversation/previewKinds.ts`)
 * as what it says — a picture, a deck, a change, a page, a chart — and embeds
 * a local file written as a Markdown image (`FileEmbed.tsx`), redrawn when
 * the file changes. So the Agent is told which fences and files those are,
 * and when to use which: a small or one-off picture inline, one that is being
 * revised as a file it embeds (so it is not written out again each time);
 * SVG for a figure, Vega-Lite for a chart, Marp for slides and HTML for a
 * document, a diff for a proposed change, and never ASCII art. Everything is
 * drawn as an image or in a frame that loads nothing, so it is asked to be
 * self-contained in order to draw at all.
 */
export const RICH_OUTPUT_INSTRUCTIONS = [
	"Rich output: DevHub draws closed ```svg, ```mermaid, ```markdown, ```marp (Marp slides, `marp: true` front matter), ```diff, ```html and ```vega-lite (JSON spec) blocks, and embeds a local file written as ![alt](path), the path as for a file link — PNG/JPEG (e.g. from matplotlib), .svg, .md (Marp too), .mmd, .diff, .html, .vl.json — redrawn when the file changes.",
	"Keep them self-contained: no scripts or external resources (chart data inline in values).",
	"A diagram or figure: an inline ```svg first; once it is being revised, write the SVG to a file and embed it.",
	"A chart or graph: inline ```vega-lite, or embed a script's output (a PNG, a spec file).",
	"Slides: Marp, best as a .md file embedded. A write-up or document: HTML, best as a file embedded. A proposed change: ```diff.",
	"Never ASCII art: anything picture-like is SVG. Unasked, draw only where a picture explains better than prose, and keep it small.",
].join(" ");

/**
 * Everything DevHub appends to a GUI Agent's instructions, in this order:
 * Claude's `--append-system-prompt` and Codex's `developerInstructions`.
 * One line: it is a command-line argument, and an Agent host is handed its
 * CLI's arguments one per line (`hostLink.ts`).
 */
export const GUI_AGENT_INSTRUCTIONS = [
	FILE_LINK_INSTRUCTIONS,
	RICH_OUTPUT_INSTRUCTIONS,
].join(" ");
