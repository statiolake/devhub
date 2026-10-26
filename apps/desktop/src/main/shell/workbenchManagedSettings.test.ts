import { describe, expect, it } from "vitest";
import {
	MANAGED_SETTINGS_CHANNEL,
	MANAGED_SETTINGS_REQUEST,
	managedSettingsOf,
	WorkbenchManagedSettings,
	type ManagedSettings,
	type ManagedSettingsReceiver,
} from "./workbenchManagedSettings.js";

function receiver() {
	const sent: { channel: string; args: unknown[] }[] = [];
	let destroyed = false;
	let onDestroyed: (() => void) | undefined;
	const contents: ManagedSettingsReceiver = {
		send(channel, ...args) {
			sent.push({ channel, args });
		},
		isDestroyed: () => destroyed,
		once(_event, listener) {
			onDestroyed = listener;
		},
	};
	return {
		contents,
		sent,
		destroy() {
			destroyed = true;
			onDestroyed?.();
		},
	};
}

function ipc() {
	const listeners = new Map<
		string,
		(event: { readonly sender: ManagedSettingsReceiver }) => void
	>();
	return {
		on(
			channel: string,
			listener: (event: { readonly sender: ManagedSettingsReceiver }) => void,
		) {
			listeners.set(channel, listener);
		},
		ask(sender: ManagedSettingsReceiver) {
			listeners.get(MANAGED_SETTINGS_REQUEST)?.({ sender });
		},
	};
}

describe("the theme a workbench is told to wear", () => {
	it("is DevHub's two themes, auto-detected, and the one for now", () => {
		expect(
			managedSettingsOf({
				dark: "Monokai",
				light: "Light 2026",
				current: "Monokai",
			}),
		).toEqual({
			"window.autoDetectColorScheme": true,
			"workbench.preferredDarkColorTheme": "Monokai",
			"workbench.preferredLightColorTheme": "Light 2026",
			"workbench.colorTheme": "Monokai",
		});
	});
});

describe("telling the workbenches", () => {
	it("answers a workbench that asks, and tells it again on a change", () => {
		let settings: ManagedSettings = { "workbench.colorTheme": "A" };
		const managed = new WorkbenchManagedSettings(() => settings);
		const bus = ipc();
		managed.listen(bus);
		const one = receiver();
		bus.ask(one.contents);
		expect(one.sent).toEqual([
			{
				channel: MANAGED_SETTINGS_CHANNEL,
				args: [{ "workbench.colorTheme": "A" }],
			},
		]);
		settings = { "workbench.colorTheme": "B" };
		managed.changed();
		expect(one.sent.at(-1)?.args).toEqual([{ "workbench.colorTheme": "B" }]);
		// Nothing moved: nothing is sent.
		managed.changed();
		expect(one.sent).toHaveLength(2);
	});

	it("forgets a workbench that went away", () => {
		let settings: ManagedSettings = { "workbench.colorTheme": "A" };
		const managed = new WorkbenchManagedSettings(() => settings);
		const bus = ipc();
		managed.listen(bus);
		const one = receiver();
		bus.ask(one.contents);
		bus.ask(one.contents);
		expect(one.sent).toHaveLength(2);
		one.destroy();
		settings = { "workbench.colorTheme": "B" };
		managed.changed();
		expect(one.sent).toHaveLength(2);
	});
});
