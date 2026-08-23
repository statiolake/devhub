import type { ReactElement } from "react";
import { SettingsApp } from "../settings/SettingsApp";
import type { SettingsClient } from "../settings/client";
import type { SettingsSnapshot } from "../generated/settings";
import { SettingsFixtureDriver } from "./settings-driver";
import {
  settingsFixtureSnapshots,
  type SettingsFixtureName,
} from "./settings-route";

interface SettingsFixtureClient {
  readonly client: SettingsClient;
  readonly emit: (snapshot: SettingsSnapshot) => void;
}

function createSettingsFixtureClient(
  snapshot: SettingsSnapshot,
): SettingsFixtureClient {
  let listener: ((next: SettingsSnapshot) => void) | undefined;
  const client: SettingsClient = {
    getSnapshot: async () => snapshot,
    save: async () => snapshot,
    reload: async () => snapshot,
    recheck: async () => snapshot,
    openLogFolder: async () => undefined,
    applySocketChange: async () => snapshot,
    subscribe: async (next) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
  };
  return { client, emit: (next) => listener?.(next) };
}

export function renderSettingsFixture(name: SettingsFixtureName): ReactElement {
  const fixtureClient = createSettingsFixtureClient(
    settingsFixtureSnapshots[name],
  );
  return (
    <>
      <SettingsApp client={fixtureClient.client} />
      <SettingsFixtureDriver name={name} emit={fixtureClient.emit} />
    </>
  );
}
