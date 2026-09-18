/**
 * Cmd+- and Cmd+Shift+-, answered for the Agent panes.
 *
 * The same shape of answer as `editingCommands.ts`, for the same reason and in
 * the same place: a key that has to mean one thing over one surface and
 * nothing at all over another has to be decided **per web contents**, and the
 * layer in front of every surface (`keyboard.ts`) is the only thing that sees
 * which surface a key landed on. A menu accelerator would claim these keys for
 * the whole application and take the workbench's own zoom — VS Code binds
 * Cmd+- and Cmd+Shift+- to zoom the window — away from every editor in it.
 *
 * So the rule is one line long: these keys mean a zoom **only on the Agents
 * page**, and everywhere else they are not touched. A modal is not a special
 * case of that rule, it is the rule: a question that is up holds the keyboard
 * (`keyboardChild`), so the keystroke arrives from the picker's view and never
 * matches here. `appController` asks once more before it acts, because "is a
 * question up" is a fact main owns and not one this module should infer from a
 * URL.
 *
 * # Why this one matches the physical key, when a chord matches the character
 *
 * `model/chordKeys.ts` says at length that a chord's identity is the character
 * the key produced, because `code` names positions by the US layout and a JIS
 * keyboard does not put punctuation where a US one does. Both halves of that
 * are still true, and neither applies here.
 *
 * `Minus` and `Digit0` are in the same physical place on both layouts — it is
 * the bracket and quote keys that move — so there is no position to get wrong.
 * And the *character* is what goes wrong instead: Shift+- is `_` on a US
 * keyboard and `=` on a JIS one, so a binding written as a character would be
 * two different bindings on two keyboards, and the one the person is pressing
 * is the key printed `-` on both. What the person means is the key, so the key
 * is what is matched.
 *
 * # What each one does
 *
 * | Key | |
 * |---|---|
 * | `Cmd+Shift+-` | one step larger |
 * | `Cmd+-` | one step smaller |
 * | `Cmd+Shift+0` | forget the zoom |
 *
 * Plain `Cmd+0` is deliberately not bound. It is the conventional spelling of
 * a reset and it is *also* what a person types by accident reaching for
 * Cmd+Shift+0's neighbours over a terminal, and an unbound key over a terminal
 * is a key the terminal gets — which is the honest answer for a chord DevHub
 * has not claimed.
 */

import type { KeyStroke } from "./chords.js";
import { SHELL_ORIGIN } from "./shellPageProtocol.js";
import type { TerminalZoomDirection } from "../../model/terminalZoom.js";

/** The one page these keys mean anything on. */
const AGENTS_PAGE = `${SHELL_ORIGIN}/agents.html`;

/**
 * What this keystroke means to the Agent panes, or nothing.
 *
 * Nothing for every key on every other surface, and for every chord that is
 * not one of the three. Modifiers are matched exactly, as they are for the
 * editing keys: Cmd+Ctrl+- is not a zoom, and an unclaimed chord has to reach
 * the terminal rather than be swallowed on the way.
 */
export function terminalZoomFor(
	surfaceUrl: string,
	stroke: KeyStroke,
): TerminalZoomDirection | undefined {
	if (!surfaceUrl.startsWith(AGENTS_PAGE)) return undefined;
	if (!stroke.command || stroke.option || stroke.control) return undefined;
	if (stroke.code === "Minus") return stroke.shift ? "in" : "out";
	if (stroke.code === "Digit0" && stroke.shift) return "reset";
	return undefined;
}
