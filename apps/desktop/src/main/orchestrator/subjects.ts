/**
 * The one subject key the orchestrator's stores share — the triage's
 * (`triage.ts`, `subjectOf` in `events.ts`): `item OWNER/REPO#N` (an Issue
 * and a pull request alike), `agent <id>`, `esc <N>`, `req <N>`. The memos
 * (`memos.ts`) and the work an agent did (`work.ts`) are kept under it, so a
 * line, a priority, a memo and the agent to resume all name a subject the
 * same way.
 *
 * On the command line a subject is named as the event lines name it —
 * `issue=acme/app#12`, `pr=acme/app#9`, `agent=ab12cd34`, `esc=3`, `req=2`
 * — or by an item's URL, or `acme/app#12`; `ws=<w>` names the work of a
 * Workspace (resolved by the caller, `OrchestratorService.resolveSubject`).
 */

/** An item key's repository compared without case, as GitHub does. */
export function normalSubject(key: string): string {
	return key.startsWith("item ") ? key.toLowerCase() : key;
}

/** `https://github.com/o/r/issues/12` (or `/pull/12`): the item it names. */
export function itemOfUrl(
	url: string,
): { readonly ref: string; readonly kind: "issue" | "pr" } | undefined {
	const match =
		/^https?:\/\/[^/]+\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/iu.exec(
			url.trim(),
		);
	if (match === null) return undefined;
	return {
		ref: `${match[1]!}/${match[2]!}#${match[4]!}`,
		kind: match[3]!.toLowerCase() === "pull" ? "pr" : "issue",
	};
}

/** The key of an item `OWNER/REPO#N`. */
export function itemKey(ref: string): string {
	return normalSubject(`item ${ref}`);
}

/**
 * How a key is said on the command line: `issue=` / `pr=` for an item (by
 * `kind` when known: the key itself does not say which), `agent=`, `esc=`,
 * `req=`.
 */
export function subjectToken(key: string, kind?: "issue" | "pr"): string {
	const space = key.indexOf(" ");
	if (space < 0) return key;
	const head = key.slice(0, space);
	const rest = key.slice(space + 1);
	switch (head) {
		case "item":
			return `${kind ?? "issue"}=${rest}`;
		case "agent":
			return `agent=${rest}`;
		case "esc":
			return `esc=${rest}`;
		case "req":
			return `req=${rest}`;
		default:
			return key;
	}
}

/**
 * A subject as typed, read as far as it can be without live state: an
 * item (`issue=`, `pr=`, a URL, `OWNER/REPO#N`), `esc=N`, `req=N`, or an
 * agent (`agent=ID`, possibly a prefix: the caller resolves it). `ws=` and
 * anything else: undefined.
 */
export type TypedSubject =
	| {
			readonly kind: "item";
			readonly key: string;
			readonly itemKind?: "issue" | "pr";
	  }
	| { readonly kind: "esc" | "req"; readonly key: string }
	| { readonly kind: "agent"; readonly id: string }
	| { readonly kind: "ws"; readonly workspace: string };

export function readSubject(text: string): TypedSubject | undefined {
	const typed = text.trim();
	const url = itemOfUrl(typed);
	if (url !== undefined)
		return { kind: "item", key: itemKey(url.ref), itemKind: url.kind };
	if (/^[\w.-]+\/[\w.-]+#\d+$/u.test(typed))
		return { kind: "item", key: itemKey(typed) };
	const match = /^(esc|issue|pr|agent|req|ws)=(.+)$/u.exec(typed);
	if (match === null) return undefined;
	const [, head, value] = match;
	switch (head) {
		case "esc":
		case "req":
			return /^\d+$/u.test(value!)
				? { kind: head, key: `${head} ${String(Number(value))}` }
				: undefined;
		case "issue":
		case "pr":
			return /^[\w.-]+\/[\w.-]+#\d+$/u.test(value!)
				? { kind: "item", key: itemKey(value!), itemKind: head }
				: undefined;
		case "ws":
			return { kind: "ws", workspace: value! };
		default:
			return /^[0-9a-z-]+$/iu.test(value!)
				? { kind: "agent", id: value! }
				: undefined;
	}
}
