import { describe, expect, it } from "vitest";
import {
	MAX_VSIX_BYTES,
	OpenVsxClient,
	OpenVsxError,
	type Fetch,
} from "./openVsx.js";

const NORD = {
	url: "https://open-vsx.org/api/arcticicestudio/nord-visual-studio-code",
	files: {
		download:
			"https://open-vsx.org/api/arcticicestudio/nord-visual-studio-code/0.19.0/file/arcticicestudio.nord-visual-studio-code-0.19.0.vsix",
	},
	name: "nord-visual-studio-code",
	namespace: "arcticicestudio",
	version: "0.19.0",
	displayName: "Nord",
	description: "An arctic, north-bluish clean and elegant theme.",
	downloadCount: 123456,
};

function fake(answer: (url: string) => Response | Promise<Response>): {
	fetch: Fetch;
	urls: string[];
} {
	const urls: string[] = [];
	return {
		urls,
		fetch: async (url) => {
			urls.push(url);
			return answer(url);
		},
	};
}

describe("Open VSX", () => {
	it("searches the Themes category and reads the results", async () => {
		const { fetch, urls } = fake(() =>
			Response.json({
				offset: 0,
				totalSize: 2,
				extensions: [NORD, { name: "broken" }, { ...NORD, namespace: "../x" }],
			}),
		);
		const found = await new OpenVsxClient(fetch).searchThemes(" nord ");
		const asked = new URL(urls[0]!);
		expect(asked.origin + asked.pathname).toBe(
			"https://open-vsx.org/api/-/search",
		);
		expect(asked.searchParams.get("category")).toBe("Themes");
		expect(asked.searchParams.get("query")).toBe("nord");
		expect(asked.searchParams.get("sortBy")).toBe("relevance");
		expect(found.totalSize).toBe(2);
		expect(found.themes).toEqual([
			{
				namespace: "arcticicestudio",
				name: "nord-visual-studio-code",
				version: "0.19.0",
				displayName: "Nord",
				description: NORD.description,
				downloadCount: 123456,
				download: NORD.files.download,
			},
		]);
	});

	it("lists the most downloaded when nothing is typed", async () => {
		const { fetch, urls } = fake(() => Response.json({ extensions: [] }));
		await new OpenVsxClient(fetch).searchThemes("");
		const asked = new URL(urls[0]!);
		expect(asked.searchParams.has("query")).toBe(false);
		expect(asked.searchParams.get("sortBy")).toBe("downloadCount");
	});

	it("turns every failure into a sentence", async () => {
		const offline = new OpenVsxClient(() =>
			Promise.reject(new TypeError("fetch failed")),
		);
		await expect(offline.searchThemes("x")).rejects.toThrow(
			/could not reach Open VSX: fetch failed/,
		);
		const down = new OpenVsxClient(
			fake(
				() =>
					new Response("", { status: 503, statusText: "Service Unavailable" }),
			).fetch,
		);
		await expect(down.searchThemes("x")).rejects.toThrow(
			"Open VSX answered 503 Service Unavailable.",
		);
		const odd = new OpenVsxClient(fake(() => new Response("<html>")).fetch);
		await expect(odd.searchThemes("x")).rejects.toThrow(OpenVsxError);
		const refused = new OpenVsxClient(
			fake(() => Response.json({ error: "bad query" })).fetch,
		);
		await expect(refused.searchThemes("x")).rejects.toThrow(
			"Open VSX refused the search: bad query",
		);
		const slow = new OpenVsxClient(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				}),
			undefined,
			10,
		);
		await expect(slow.searchThemes("x")).rejects.toThrow(
			/did not answer within/,
		);
	});

	it("downloads from its own origin only, and no more than the cap", async () => {
		const { fetch } = fake(() => new Response(new Uint8Array([1, 2, 3])));
		const client = new OpenVsxClient(fetch);
		const theme = {
			...NORD,
			download: NORD.files.download,
			downloadCount: 1,
			description: "",
		};
		expect([...(await client.download(theme))]).toEqual([1, 2, 3]);
		await expect(
			client.download({ ...theme, download: "https://evil.example/x.vsix" }),
		).rejects.toThrow(/only from https:\/\/open-vsx.org/);
		const huge = new OpenVsxClient(
			fake(
				() =>
					new Response("x", {
						headers: { "content-length": String(MAX_VSIX_BYTES + 1) },
					}),
			).fetch,
		);
		await expect(huge.download(theme)).rejects.toThrow(
			/more than DevHub downloads/,
		);
		const streaming = new OpenVsxClient(
			fake(
				() =>
					new Response(
						new ReadableStream({
							pull(controller) {
								controller.enqueue(new Uint8Array(1024 * 1024));
							},
						}),
					),
			).fetch,
		);
		await expect(streaming.download(theme)).rejects.toThrow(
			/larger than DevHub downloads/,
		);
	});
});
