/**
 * DevHub's answer to "where does this remote workbench connect?".
 *
 * The one thing `extensions/devhub-remote` asks for, and the only place the
 * two halves of a remote window meet: VS Code hands an extension an authority
 * and nothing else, and DevHub holds the connection, the install and the
 * forward. So the extension asks over the control socket and this composes the
 * reply.
 *
 * It answers rather than throws, because a failed resolve has two outcomes and
 * not one. VS Code reads the error class the extension throws: a
 * `TemporarilyNotAvailable` is retried by its reconnect loop and by
 * `_resolveAuthorityInitial`'s five attempts, and a `NotAvailable` makes it
 * give up at once and show the sentence. Which of the two is right is known
 * where the failure happened — see `permanent` in `runtime/remoteServer.ts` —
 * and is carried on the failure rather than read back out of its wording,
 * because a rule applied to wording is wrong the first time somebody rephrases
 * a sentence and wrong in silence.
 */

import type { RemoteResolution } from "../cli/controlServer.js";
import { remoteServerFor } from "../runtime/registry.js";
import { isPermanent } from "../runtime/remoteServer.js";
import { runtimeMachine } from "../runtime/registry.js";

export async function resolveRemoteEndpoint(
	machine: string,
	attempt: number,
): Promise<RemoteResolution> {
	// A name that is not one of the shapes DevHub knows is a request DevHub
	// cannot answer, and no amount of asking again teaches it one.
	let id;
	try {
		id = runtimeMachine(machine);
	} catch (failure: unknown) {
		return { ok: false, message: messageOf(failure), retry: false };
	}
	// Said once per resolve, because "this host is being asked for the fourth
	// time" is the difference between a slow connection and a loop, and there is
	// nowhere else that number exists.
	console.log(
		`[devhub] ${id}: resolving the remote workbench (attempt ${String(attempt)})`,
	);
	try {
		const { host, delivery } = remoteServerFor(id);
		// The first attempt is a window opening; every later one is that window
		// trying to come back. Only the first may start anything — see
		// `RemoteServerHost.prepare`. Without that line a dev container would be
		// restarted by the reconnect loop within seconds of somebody stopping
		// it, and they could never keep it stopped.
		if (attempt <= 1 && host.prepare !== undefined) {
			await host.prepare();
		}
		const endpoint = await host.remoteServer(delivery);
		return {
			ok: true,
			remote: {
				port: endpoint.port,
				connectionToken: endpoint.connectionToken,
				...(endpoint.extensionHostEnv === undefined
					? {}
					: { extensionHostEnv: endpoint.extensionHostEnv }),
			},
		};
	} catch (failure: unknown) {
		const message = messageOf(failure);
		console.warn(
			`[devhub] ${id}: the remote workbench cannot connect: ${message}`,
		);
		return { ok: false, message, retry: !isPermanent(failure) };
	}
}

function messageOf(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}
