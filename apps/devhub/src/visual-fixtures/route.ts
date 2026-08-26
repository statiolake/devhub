import type { AppSnapshot } from "../generated/app-shell";
import {
  agentSnapshot,
  closingFailedSnapshot,
  editorFailedSnapshot,
  globalSnapshot,
  unavailableSnapshot,
  workspaceSnapshot,
} from "./app-shell";

export const FIXTURE_NAMES = [
  "global",
  "workspace",
  "agent",
  "unavailable",
  "closing-failed",
  "editor-failed",
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export const fixtureSnapshots: Readonly<Record<FixtureName, AppSnapshot>> = {
  global: globalSnapshot,
  workspace: workspaceSnapshot,
  agent: agentSnapshot,
  unavailable: unavailableSnapshot,
  "closing-failed": closingFailedSnapshot,
  "editor-failed": editorFailedSnapshot,
};

/**
 * Resolves the development-only visual route. An absent query leaves the real
 * native shell active. Malformed, duplicate, and unknown fixture queries also
 * keep the real native shell active rather than silently faking a state.
 */
export function parseFixtureQuery(search: string): FixtureName | undefined {
  const values = new URLSearchParams(search).getAll("fixture");
  if (values.length === 0) return undefined;
  if (values.length !== 1) return undefined;
  return (FIXTURE_NAMES as readonly string[]).includes(values[0])
    ? (values[0] as FixtureName)
    : undefined;
}
