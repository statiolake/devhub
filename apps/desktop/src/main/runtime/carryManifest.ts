/**
 * The record on a host of what DevHub carried there, and what the next sync
 * has to send (`docs/remote-neovim-config.md`, "The transport").
 *
 * `~/.devhub-server/nvim-config/manifest`: a few `# key value` lines about
 * the sync, then one line per carried unit — its name, its digest and the
 * directory it is in on the host, tab-separated. It is the last thing a sync
 * writes, by a rename, so a dropped connection leaves the old manifest and
 * the next sync sends those units again.
 */

export const MANIFEST_VERSION = "devhub-nvim-config 1";

export interface ManifestUnit {
	readonly name: string;
	readonly digest: string;
	/** Where the unit is on the host: an absolute path. */
	readonly destination: string;
}

export interface Manifest {
	/** Which DevHub on which Mac wrote it: "last sync wins" names the loser. */
	readonly source: string;
	readonly units: readonly ManifestUnit[];
	/** Other `# key value` lines: the plugin count, the bytes, the time. */
	readonly facts: Readonly<Record<string, string>>;
}

export const EMPTY_MANIFEST: Manifest = { source: "", units: [], facts: {} };

export function formatManifest(manifest: Manifest): string {
	const lines = [`# ${MANIFEST_VERSION}`, `# source ${manifest.source}`];
	for (const [key, value] of Object.entries(manifest.facts)) {
		lines.push(`# ${key} ${value.replaceAll("\n", " ")}`);
	}
	for (const unit of [...manifest.units].sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		lines.push(`${unit.name}\t${unit.digest}\t${unit.destination}`);
	}
	return `${lines.join("\n")}\n`;
}

/** A manifest read back; anything unreadable is a unit the next sync sends. */
export function parseManifest(text: string): Manifest {
	let source = "";
	const facts: Record<string, string> = {};
	const units: ManifestUnit[] = [];
	for (const line of text.split("\n")) {
		if (line.startsWith("# ")) {
			const body = line.slice(2);
			const space = body.indexOf(" ");
			if (space <= 0) continue;
			const key = body.slice(0, space);
			const value = body.slice(space + 1);
			if (key === "source") source = value;
			else if (key !== "devhub-nvim-config") facts[key] = value;
			continue;
		}
		const [name, digest, destination] = line.split("\t");
		if (
			name === undefined ||
			name === "" ||
			digest === undefined ||
			!/^[0-9a-f]{64}$/u.test(digest) ||
			destination === undefined ||
			!destination.startsWith("/")
		) {
			continue;
		}
		units.push({ name, digest, destination });
	}
	return { source, units, facts };
}

export interface ManifestDiff {
	/** Units the host does not have as they are here. */
	readonly send: readonly ManifestUnit[];
	/** Directories on the host that held a unit this Mac no longer has there. */
	readonly remove: readonly string[];
	/** Units already there, byte for byte. */
	readonly kept: readonly ManifestUnit[];
}

/**
 * What a sync does: send every unit whose digest or place differs, and remove
 * every directory the host's manifest names that no local unit is going to.
 */
export function diffManifest(
	local: readonly ManifestUnit[],
	remote: Manifest,
): ManifestDiff {
	const there = new Map(remote.units.map((unit) => [unit.name, unit]));
	const send: ManifestUnit[] = [];
	const kept: ManifestUnit[] = [];
	for (const unit of local) {
		const existing = there.get(unit.name);
		if (
			existing !== undefined &&
			existing.digest === unit.digest &&
			existing.destination === unit.destination
		) {
			kept.push(unit);
		} else {
			send.push(unit);
		}
	}
	const destinations = new Set(local.map((unit) => unit.destination));
	const remove = remote.units
		.map((unit) => unit.destination)
		.filter((destination) => !destinations.has(destination));
	return { send, remove: [...new Set(remove)], kept };
}
