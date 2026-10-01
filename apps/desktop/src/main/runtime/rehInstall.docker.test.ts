/**
 * The remote extension host, copied into real containers that have no network,
 * started there, and reached through DevHub's own bridge.
 *
 * Opt-in, because it needs Docker, the images, and a directory of servers
 * (`dist/reh`, as `scripts/build_reh.py` leaves it): what it proves is the one
 * thing the rest of the suite cannot — that a machine with no route anywhere
 * gets a working server out of DevHub alone. Run it as
 *
 *     DEVHUB_REH_BUNDLE=<repo>/dist/reh \
 *       DEVHUB_REH_IMAGES="debian:bookworm-slim alpine:3.20" \
 *       npx vitest run src/main/runtime/rehInstall.docker.test.ts
 *
 * The containers carry the labels `devcontainer up` puts on its own, so the
 * runtime adopts them the way it adopts any running dev container; nothing
 * else about them is special. Each is started with `--network none`.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	devContainerConfigPath,
	workspaceLocation,
} from "../../model/domain.js";
import { ContainerHost, localContainerMachine } from "./container.js";
import {
	BundledRehDelivery,
	parseRehStatement,
	type RehStatement,
} from "./remoteServer.js";

const BUNDLE = process.env["DEVHUB_REH_BUNDLE"];
const IMAGES = (
	process.env["DEVHUB_REH_IMAGES"] ?? "debian:bookworm-slim alpine:3.20"
)
	.split(/\s+/u)
	.filter((image) => image.length > 0);

/** What the bundle says about itself: every server in it states both. */
function statementOf(directory: string): RehStatement {
	const name = readdirSync(directory).find((file) => file.endsWith(".json"));
	const statement =
		name === undefined
			? undefined
			: parseRehStatement(readFileSync(join(directory, name), "utf8"));
	if (statement === undefined) throw new Error(`no statement in ${directory}`);
	return statement;
}

describe.runIf(BUNDLE !== undefined)(
	"a server for a container with no network",
	() => {
		const started: string[] = [];
		afterAll(() => {
			for (const id of started) {
				execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
			}
		});

		for (const image of IMAGES) {
			it(`is copied into ${image}, started, and answers through the bridge`, async () => {
				const directory = BUNDLE ?? "";
				const { commit, identity } = statementOf(directory);
				const folder = `/projects/reh-${image.replace(/[^a-z0-9]/gu, "-")}`;
				const config = `${folder}/.devcontainer/devcontainer.json`;
				const id = execFileSync(
					"docker",
					[
						"run",
						"-d",
						"--network",
						"none",
						"--label",
						`devcontainer.local_folder=${folder}`,
						"--label",
						`devcontainer.config_file=${config}`,
						image,
						"sleep",
						"100000",
					],
					{ encoding: "utf8" },
				).trim();
				started.push(id);
				const delivery = new BundledRehDelivery({
					directory,
					commit,
					identity,
					dataFolderName: ".devhub-server",
					applicationName: "devhub-server",
					packaged: false,
				});
				const scratch = await mkdtemp(join(tmpdir(), "devhub-reh-docker-"));
				const host = new ContainerHost({
					target: {
						location: workspaceLocation({ kind: "local", path: folder }),
						configPath: devContainerConfigPath(config),
					},
					machine: localContainerMachine(
						{ path: "docker" },
						{ path: "devcontainer" },
					),
					buildLog: join(scratch, "build.log"),
					reh: delivery,
				});
				try {
					const endpoint = await host.remoteServer(delivery);
					// `/version` is the server's own answer, through the bridge on
					// this machine, from inside a container that reaches nothing.
					const answer = await fetch(
						`http://127.0.0.1:${String(endpoint.port)}/version`,
					);
					expect(await answer.text()).toBe(commit);
					// Installed under the key that names DevHub's patches too.
					const installed = execFileSync(
						"docker",
						[
							"exec",
							id,
							"sh",
							"-c",
							`cat "$HOME/.devhub-server/bin/${commit}-${identity}/.devhub-installed"`,
						],
						{ encoding: "utf8" },
					);
					expect(installed.trim()).toMatch(/^[0-9a-f]{64}$/u);
					// And a reconnect is the same endpoint, not a second install.
					const again = await host.remoteServer(delivery);
					expect(again.port).toBe(endpoint.port);
				} finally {
					await host.dispose();
					await rm(scratch, { recursive: true, force: true });
				}
			}, 180_000);
		}
	},
);
