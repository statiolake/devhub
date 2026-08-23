import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findSurfaceForRoot, parseSurfaceRegistry } from "../src/registry";

const globalSurface = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const workspaceSurface = "33333333-3333-4333-8333-333333333333";
const workspaceRoot = "/Users/statiolake/DevHub/workspaces/alpha";

function sharedDocument(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "apps/devhub/src-tauri/src/editor/fixtures/surface-registry.v1.json",
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

function sharedText(): string {
  return JSON.stringify(sharedDocument());
}

test("registry resolves global and workspace surfaces using the Rust shape", () => {
  const entries = parseSurfaceRegistry(sharedText());
  assert.ok(entries);
  assert.equal(findSurfaceForRoot(entries, null)?.surface_id, globalSurface);
  assert.equal(
    findSurfaceForRoot(entries, workspaceRoot)?.workspace_id,
    workspaceId,
  );
  assert.equal(findSurfaceForRoot(entries, "/Users/statiolake/other"), null);
});

test("registry requires owner-canonical absolute roots and rejects traversal", () => {
  const entries = parseSurfaceRegistry(
    JSON.stringify({
      version: 1,
      surfaces: [
        {
          workspace_id: workspaceId,
          canonical_root: "/Users/statiolake/project",
          surface_id: workspaceSurface,
        },
      ],
    }),
  );
  assert.equal(entries?.[0].canonical_root, "/Users/statiolake/project");
  assert.equal(
    parseSurfaceRegistry(
      JSON.stringify({
        version: 1,
        surfaces: [
          {
            workspace_id: workspaceId,
            canonical_root: "/Users/statiolake/./project",
            surface_id: workspaceSurface,
          },
        ],
      }),
    ),
    null,
  );
  assert.equal(
    parseSurfaceRegistry(
      JSON.stringify({
        version: 1,
        surfaces: [
          {
            workspace_id: workspaceId,
            canonical_root: "/Users/statiolake/../project",
            surface_id: workspaceSurface,
          },
        ],
      }),
    ),
    null,
  );
});

test("registry fails closed for duplicate global identity, unknown fields, and invalid UTF-8", () => {
  const duplicate = sharedDocument();
  duplicate.surfaces = [
    ...(duplicate.surfaces as unknown[]),
    {
      workspace_id: null,
      canonical_root: null,
      surface_id: "44444444-4444-4444-8444-444444444444",
    },
  ];
  assert.equal(parseSurfaceRegistry(JSON.stringify(duplicate)), null);

  const unknown = sharedDocument();
  unknown.extra = true;
  assert.equal(parseSurfaceRegistry(JSON.stringify(unknown)), null);
  assert.equal(parseSurfaceRegistry(new Uint8Array([0xff, 0xfe])), null);
});
