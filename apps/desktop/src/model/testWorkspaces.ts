/**
 * Workspaces for tests that need a model, which is always made with its
 * Scratch: today's daily folder, an ordinary Workspace.
 */

import { randomUUID } from "node:crypto";
import { AppModel } from "./appModel.js";
import { AppCoordinator, type DrawnOrder } from "./coordinator.js";
import {
  displayPath,
  Workspace,
  workspaceId,
  workspaceLocation,
  type WorkspaceId,
} from "./domain.js";
import { drawnWorkspaceOrder } from "./wire.js";

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

/**
 * The Sidebar's order for a model none of whose folders git has answered
 * about: the person's arrangement over the names. The projection's own
 * function, so a test lands where the app would.
 */
export const drawnWithoutGit: DrawnOrder = (snapshot) =>
  drawnWorkspaceOrder(snapshot, () => undefined);

/** `drawnWithoutGit`, read off a model directly. */
export function drawn(model: AppModel): readonly WorkspaceId[] {
  return drawnWithoutGit(model.snapshot());
}

/** A coordinator over `model` that reads the Sidebar's order as the app does. */
export function coordinatorFor(model: AppModel): AppCoordinator {
  return new AppCoordinator(model, drawnWithoutGit);
}
