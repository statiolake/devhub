/**
 * R1.1's complete native-shell wire contract. Rust owns every value; these
 * types only describe the immutable payload crossing the Tauri seam.
 */
export const SHELL_SCHEMA_VERSION = 1 as const;

export type ShellReadiness = "starting" | "ready";

export interface ShellSnapshot {
  readonly schemaVersion: typeof SHELL_SCHEMA_VERSION;
  readonly revision: number;
  readonly productName: string;
  readonly platform: string;
  readonly windowLabel: string;
  readonly readiness: ShellReadiness;
}

export type ShellLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly snapshot: ShellSnapshot }
  | { readonly status: "error"; readonly message: string };
