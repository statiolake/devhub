/**
 * Workspaces for tests that need a model, which is always made with its
 * Scratch: today's daily folder, an ordinary Workspace.
 */

import { randomUUID } from "node:crypto";
import { AppModel } from "./appModel.js";
import {
  displayPath,
  Workspace,
  workspaceId,
  workspaceLocation,
} from "./domain.js";

/** Where the tests' Scratch lives. Not a real folder; nothing touches it. */
export const SCRATCH_PATH = "/scratch-test/junk/20260923";

export function localWorkspace(
  path: string,
  id: string = randomUUID(),
): Workspace {
  return new Workspace(
    workspaceId(id),
    workspaceLocation({ kind: "local", path }),
    displayPath(path),
  );
}

export function scratchWorkspace(path: string = SCRATCH_PATH): Workspace {
  return localWorkspace(path);
}

/** A model whose only Workspace is its Scratch. */
export function scratchModel(path: string = SCRATCH_PATH): AppModel {
  return new AppModel(scratchWorkspace(path));
}
