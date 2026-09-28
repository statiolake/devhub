/**
 * An MCP elicitation, as both CLIs pass one on: a server asking the person
 * something through the Agent. Each adapter reads its CLI's request into an
 * `Elicitation` and writes an `ElicitationReply` back in its CLI's words;
 * everything between — the card's subject, which answers it offers, what
 * each answer means — is decided here, once, so a Claude elicitation and a
 * Codex one are the same card answered by the same rule.
 *
 * The rule: an elicitation is accepted by submitting its form, whatever
 * fields it has (none makes it a plain confirmation, accepted with nothing
 * filled in; a page to visit is accepted with no content at all). When the
 * CLI offers to remember the acceptance — for this session, or always — each
 * offer is a further way to accept, after the form's own. Declining and
 * cancelling come last.
 *
 * The form's schema is MCP's `requestedSchema`, the same for both CLIs, so it
 * is read here too (`formFields`), failing through the adapter's own reader
 * so a mismatch names the CLI's version.
 */

import type {
	JsonValue,
	RequestAnswer,
	RequestChoice,
	RequestSubject,
} from "../../../model/conversation.js";
import {
	formContent,
	type FormField,
	type FormInput,
	type FormOption,
} from "../../../model/elicitationForm.js";

/** How long an acceptance may be remembered, as MCP tool approvals name it. */
export type Remember = "session" | "always";

export interface Elicitation {
	readonly server: string;
	readonly message: string;
	/** The page to visit, for a URL elicitation; its form then has no fields. */
	readonly url: string | undefined;
	readonly fields: readonly FormField[];
	/**
	 * How long the CLI offers to remember an acceptance, in the order offered.
	 * Only a plain confirmation (a form of no fields) is offered any.
	 */
	readonly remember: readonly Remember[];
}

/** What the person answered, before the adapter spells it in its CLI's words. */
export interface ElicitationReply {
	readonly action: "accept" | "decline" | "cancel";
	/** What was filled in, for an accepted form; undefined for a page to visit, a decline, a cancel. */
	readonly content: { readonly [key: string]: JsonValue } | undefined;
	/** How long the acceptance is to be remembered, when the person chose that. */
	readonly remember: Remember | undefined;
}

const REMEMBER_CHOICES: Readonly<Record<Remember, RequestChoice>> = {
	session: {
		id: "remember:session",
		label: "Accept for this session",
		tone: "allow",
		takesText: false,
	},
	always: {
		id: "remember:always",
		label: "Always accept",
		tone: "allow",
		takesText: false,
	},
};

const DECLINE: RequestChoice = {
	id: "decline",
	label: "Decline",
	tone: "deny",
	takesText: false,
};

const CANCEL: RequestChoice = {
	id: "cancel",
	label: "Cancel",
	tone: "neutral",
	takesText: false,
};

/** The card's subject; its fields are the form the card draws. */
export function elicitationSubject(
	elicitation: Elicitation,
): Extract<RequestSubject, { kind: "elicitation" }> {
	return {
		kind: "elicitation",
		server: elicitation.server,
		message: elicitation.message,
		url: elicitation.url,
		fields: elicitation.fields,
	};
}

/**
 * The answers beside the form's own Accept, which the card puts first: each
 * way of remembering the acceptance the CLI offers, then Decline and Cancel.
 */
export function elicitationChoices(
	elicitation: Elicitation,
): readonly RequestChoice[] {
	return [
		...elicitation.remember.map((remember) => REMEMBER_CHOICES[remember]),
		DECLINE,
		CANCEL,
	];
}

/**
 * What an answer to the card means. An answer the card could not have given
 * — a choice it did not offer, a form sent unfinished — is the caller's
 * mistake, and throws.
 */
export function elicitationReply(
	elicitation: Elicitation,
	answer: RequestAnswer,
	request: string,
): ElicitationReply {
	if (answer.kind === "answers") {
		const { content, problems } = formContent(
			elicitation.fields,
			answer.values,
		);
		if (Object.keys(problems).length > 0)
			throw new Error(
				`the form of elicitation ${request} was sent unfinished: ${JSON.stringify(problems)}`,
			);
		return {
			action: "accept",
			content: elicitation.url === undefined ? content : undefined,
			remember: undefined,
		};
	}
	if (answer.text !== undefined)
		throw new Error(
			`choice ${answer.choiceId} of elicitation ${request} takes no text`,
		);
	const remember = elicitation.remember.find(
		(each) => REMEMBER_CHOICES[each].id === answer.choiceId,
	);
	if (remember !== undefined) {
		if (elicitation.fields.length > 0 || elicitation.url !== undefined)
			throw new Error(
				`elicitation ${request} offers to remember an acceptance, but is not a plain confirmation`,
			);
		return { action: "accept", content: {}, remember };
	}
	switch (answer.choiceId) {
		case DECLINE.id:
			return { action: "decline", content: undefined, remember: undefined };
		case CANCEL.id:
			return { action: "cancel", content: undefined, remember: undefined };
		default:
			throw new Error(
				`elicitation ${request} has no choice ${JSON.stringify(answer.choiceId)}`,
			);
	}
}

// ---------------------------------------------------------------------------
// The form's schema.

/** What the schema is read through: the adapter's reader, whose failure names the CLI's version. */
export interface SchemaReader {
	fail(path: string, expected: string): never;
}

type Fields = Readonly<Record<string, unknown>>;

/**
 * A form's fields from its schema (MCP's `requestedSchema`, a flat object of
 * primitive properties), in the schema's order.
 */
export function formFields(
	reader: SchemaReader,
	value: unknown,
	path: string,
): FormField[] {
	const r = new Read(reader);
	const schema = r.fields(value, path);
	r.oneOf(schema, "type", path, ["object"]);
	const required = new Set(r.strings(schema, "required", path) ?? []);
	const properties = r.fields(schema.properties, `${path}.properties`);
	return Object.entries(properties).map(([key, property]) => {
		const at = `${path}.properties.${key}`;
		const p = r.fields(property, at);
		return {
			key,
			label: r.string(p, "title", at) ?? key,
			description: r.string(p, "description", at),
			required: required.has(key),
			input: formInput(r, p, at),
		};
	});
}

/** One property of a form as the control that fills it in. */
function formInput(r: Read, p: Fields, at: string): FormInput {
	const type = r.oneOf(p, "type", at, [
		"string",
		"number",
		"integer",
		"boolean",
		"array",
	]);
	switch (type) {
		case "string": {
			const byDefault = r.string(p, "default", at);
			const chosen = byDefault === undefined ? [] : [byDefault];
			if (p.oneOf !== undefined)
				return choice(
					false,
					constOptions(r, p, "oneOf", at),
					chosen,
					undefined,
					undefined,
				);
			if (p.enum !== undefined) {
				const names = r.strings(p, "enumNames", at);
				const options = r
					.list(p, "enum", at)
					.map((each, index) => r.item(each, `${at}.enum[${index}]`))
					.map((value, index) => ({ value, label: names?.[index] ?? value }));
				return choice(false, options, chosen, undefined, undefined);
			}
			return {
				kind: "text",
				format:
					p.format === undefined || p.format === null
						? undefined
						: r.oneOf(p, "format", at, ["email", "uri", "date", "date-time"]),
				minLength: r.number(p, "minLength", at),
				maxLength: r.number(p, "maxLength", at),
				default: byDefault,
			};
		}
		case "number":
		case "integer":
			return {
				kind: "number",
				integer: type === "integer",
				minimum: r.number(p, "minimum", at),
				maximum: r.number(p, "maximum", at),
				default: r.number(p, "default", at),
			};
		case "boolean":
			return { kind: "boolean", default: r.boolean(p, "default", at) };
		case "array": {
			const items = r.fields(p.items, `${at}.items`);
			const options =
				items.anyOf !== undefined
					? constOptions(r, items, "anyOf", `${at}.items`)
					: r
							.list(items, "enum", `${at}.items`)
							.map((each, index) => r.item(each, `${at}.items.enum[${index}]`))
							.map((value) => ({ value, label: value }));
			return choice(
				true,
				options,
				r.strings(p, "default", at) ?? [],
				r.number(p, "minItems", at),
				r.number(p, "maxItems", at),
			);
		}
	}
}

function choice(
	multiple: boolean,
	options: readonly FormOption[],
	chosen: readonly string[],
	minItems: number | undefined,
	maxItems: number | undefined,
): FormInput {
	return {
		kind: "choice",
		multiple,
		options,
		minItems,
		maxItems,
		default: chosen,
	};
}

/** Options given as `{ const, title }`. */
function constOptions(
	r: Read,
	o: Fields,
	key: string,
	path: string,
): FormOption[] {
	return r.list(o, key, path).map((option, index) => {
		const at = `${path}.${key}[${index}]`;
		const c = r.fields(option, at);
		return {
			value: r.item(c.const, `${at}.const`),
			label: r.item(c.title, `${at}.title`),
		};
	});
}

/**
 * The few readings a schema takes. A key that is absent and one that is
 * `null` read the same, as undefined; a key of the wrong type fails.
 */
class Read {
	constructor(private readonly reader: SchemaReader) {}

	private mismatch(path: string, expected: string, value: unknown): never {
		const got =
			value === null
				? "null"
				: Array.isArray(value)
					? "an array"
					: `a ${typeof value}`;
		return this.reader.fail(path, `${expected}, got ${got}`);
	}

	fields(value: unknown, path: string): Fields {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return this.mismatch(path, "an object", value);
		return value as Fields;
	}

	oneOf<const T extends string>(
		o: Fields,
		key: string,
		path: string,
		values: readonly T[],
	): T {
		const value = o[key];
		if (
			typeof value === "string" &&
			(values as readonly string[]).includes(value)
		)
			return value as T;
		return this.mismatch(
			`${path}.${key}`,
			`one of ${values.join(" | ")}`,
			value,
		);
	}

	item(value: unknown, path: string): string {
		return typeof value === "string"
			? value
			: this.mismatch(path, "a string", value);
	}

	string(o: Fields, key: string, path: string): string | undefined {
		const value = o[key];
		if (value === undefined || value === null) return undefined;
		return this.item(value, `${path}.${key}`);
	}

	number(o: Fields, key: string, path: string): number | undefined {
		const value = o[key];
		if (value === undefined || value === null) return undefined;
		return typeof value === "number"
			? value
			: this.mismatch(`${path}.${key}`, "a number", value);
	}

	boolean(o: Fields, key: string, path: string): boolean | undefined {
		const value = o[key];
		if (value === undefined || value === null) return undefined;
		return typeof value === "boolean"
			? value
			: this.mismatch(`${path}.${key}`, "a boolean", value);
	}

	list(o: Fields, key: string, path: string): readonly unknown[] {
		const value = o[key];
		return Array.isArray(value)
			? value
			: this.mismatch(`${path}.${key}`, "an array", value);
	}

	strings(o: Fields, key: string, path: string): string[] | undefined {
		const value = o[key];
		if (value === undefined || value === null) return undefined;
		return this.list(o, key, path).map((each, index) =>
			this.item(each, `${path}.${key}[${index}]`),
		);
	}
}
