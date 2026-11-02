/**
 * Open VSX, for colour themes: searching it, and downloading one.
 *
 * The registry DevHub's workbenches already use (`product-overrides.json`'s
 * gallery is Open VSX), through its public REST API
 * (https://open-vsx.org/swagger-ui): `GET /api/-/search` with
 * `category=Themes`, whose answer names each extension's `.vsix` under
 * `files.download`. Asked only when the person searches or installs in
 * Settings — never at startup — and every failure is a sentence for a notice.
 *
 * The download is held to the registry's own origin and a size cap, and is
 * handed back as bytes: whether those bytes are a theme is
 * `themeLibrary.ts`'s question.
 */

export const OPEN_VSX_API = "https://open-vsx.org/api";

/** The most a `.vsix` may be. A theme is kilobytes; some ship screenshots. */
export const MAX_VSIX_BYTES = 25 * 1024 * 1024;

/** How long one request may take. */
export const OPEN_VSX_TIMEOUT_MS = 20_000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** One search result, as Settings lists it. */
export interface OpenVsxTheme {
	readonly namespace: string;
	readonly name: string;
	readonly version: string;
	readonly displayName: string;
	readonly description: string;
	readonly downloadCount: number;
	/** The `.vsix`. */
	readonly download: string;
}

export interface OpenVsxSearch {
	readonly totalSize: number;
	readonly themes: readonly OpenVsxTheme[];
}

/** Open VSX could not be asked, or did not answer usefully. */
export class OpenVsxError extends Error {}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const ID_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function themeOf(value: unknown): OpenVsxTheme | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const fields = value as Record<string, unknown>;
	const namespace = text(fields["namespace"]);
	const name = text(fields["name"]);
	const version = text(fields["version"]);
	const files = fields["files"];
	const download =
		typeof files === "object" && files !== null
			? text((files as Record<string, unknown>)["download"])
			: undefined;
	if (
		namespace === undefined ||
		name === undefined ||
		version === undefined ||
		download === undefined ||
		!ID_PART.test(namespace) ||
		!ID_PART.test(name) ||
		!ID_PART.test(version)
	) {
		return undefined;
	}
	const count = fields["downloadCount"];
	return {
		namespace,
		name,
		version,
		displayName: text(fields["displayName"]) ?? name,
		description: text(fields["description"]) ?? "",
		downloadCount: typeof count === "number" ? count : 0,
		download,
	};
}

export class OpenVsxClient {
	constructor(
		private readonly fetch: Fetch,
		private readonly api: string = OPEN_VSX_API,
		private readonly timeoutMs: number = OPEN_VSX_TIMEOUT_MS,
	) {}

	/**
	 * Colour themes matching `query` (all of them, most downloaded first, when
	 * it is empty).
	 */
	async searchThemes(query: string, size = 30): Promise<OpenVsxSearch> {
		const parameters = new URLSearchParams({
			category: "Themes",
			size: String(size),
			offset: "0",
			sortBy: query.trim() === "" ? "downloadCount" : "relevance",
			sortOrder: "desc",
		});
		if (query.trim() !== "") parameters.set("query", query.trim());
		const response = await this.request(
			`${this.api}/-/search?${parameters.toString()}`,
		);
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new OpenVsxError(
				"Open VSX answered with something that is not JSON.",
			);
		}
		const fields =
			typeof body === "object" && body !== null
				? (body as Record<string, unknown>)
				: {};
		const extensions = fields["extensions"];
		if (!Array.isArray(extensions)) {
			const error = text(fields["error"]);
			throw new OpenVsxError(
				error !== undefined
					? `Open VSX refused the search: ${error}`
					: "Open VSX answered the search without a list of extensions.",
			);
		}
		const themes = extensions
			.map(themeOf)
			.filter((theme): theme is OpenVsxTheme => theme !== undefined);
		const total = fields["totalSize"];
		return {
			totalSize: typeof total === "number" ? total : themes.length,
			themes,
		};
	}

	/**
	 * The `.vsix` of one result. Refused when the link is not on the
	 * registry's own origin, or the file is larger than `MAX_VSIX_BYTES`.
	 */
	async download(theme: OpenVsxTheme): Promise<Buffer> {
		let url: URL;
		try {
			url = new URL(theme.download);
		} catch {
			throw new OpenVsxError(
				`Open VSX gave no usable link for ${theme.namespace}.${theme.name}.`,
			);
		}
		if (url.origin !== new URL(this.api).origin) {
			throw new OpenVsxError(
				`DevHub downloads themes only from ${new URL(this.api).origin}, and ${theme.namespace}.${theme.name} links to ${url.origin}.`,
			);
		}
		const response = await this.request(url.toString());
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (declared > MAX_VSIX_BYTES) {
			throw new OpenVsxError(
				`${theme.namespace}.${theme.name} is ${String(Math.round(declared / 1024 / 1024))} MB, more than DevHub downloads for a theme.`,
			);
		}
		const body = response.body;
		if (!body) return Buffer.alloc(0);
		const chunks: Buffer[] = [];
		let total = 0;
		const reader = body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_VSIX_BYTES) {
				await reader.cancel();
				throw new OpenVsxError(
					`${theme.namespace}.${theme.name} is larger than DevHub downloads for a theme.`,
				);
			}
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks);
	}

	private async request(url: string): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
		}, this.timeoutMs);
		let response: Response;
		try {
			response = await this.fetch(url, {
				signal: controller.signal,
				headers: { Accept: "application/json" },
			});
		} catch (error) {
			throw new OpenVsxError(
				controller.signal.aborted
					? `Open VSX did not answer within ${String(this.timeoutMs / 1000)} seconds.`
					: `DevHub could not reach Open VSX: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) {
			throw new OpenVsxError(
				`Open VSX answered ${String(response.status)} ${response.statusText}`.trim() +
					".",
			);
		}
		return response;
	}
}
