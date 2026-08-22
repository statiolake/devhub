import type { ReactElement } from "react";
import { AppShell } from "../app/AppShell";
import type { AppShellClient } from "../app/client";
import type { AppSnapshot } from "../generated/app-shell";

/**
 * Deterministic visual-test harness. Consumers provide a fake native client;
 * the production shell still receives snapshots through its normal provider.
 */
export function renderAppShellFixture(
  snapshot: AppSnapshot,
  client?: AppShellClient,
): ReactElement {
  const fixtureClient: AppShellClient = client ?? {
    getSnapshot: async () => snapshot,
    subscribe: async () => () => undefined,
    dispatch: async () => ({ kind: "noop", snapshot }),
  };
  return <AppShell client={fixtureClient} />;
}
