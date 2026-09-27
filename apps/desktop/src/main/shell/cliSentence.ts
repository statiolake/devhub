/**
 * The command line's half of the one error conversion.
 *
 * A failure DevHub knows by name — a `TypedFailure`, which is also what a
 * failure already converted for the page is on its way across IPC, or a
 * `NamedFailure` — is printed as its title and its detail, the same words it
 * is drawn with on a page. It stays that failure: Finder's "Open With DevHub"
 * goes through here too and has no terminal, so its refusal ends at
 * `noteFailure`, which draws it, and must draw it under its own title rather
 * than the app shell's catch-all. Anything else is passed on as it is, with
 * its own message.
 */

import { NamedFailure, TypedFailure } from "../../model/wire.js";

export async function asSentence(run: () => Promise<string>): Promise<string> {
	try {
		return await run();
	} catch (error: unknown) {
		if (error instanceof TypedFailure || error instanceof NamedFailure) {
			throw new TypedFailure(error.wire, { cause: error });
		}
		throw error;
	}
}
