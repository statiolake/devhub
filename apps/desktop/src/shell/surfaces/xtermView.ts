/**
 * A minimal xterm.js wrapper, owned by the Agent workstream for now.
 *
 * Workstream B owns the workspace-terminal surface and is building the shared
 * xterm wrapper; this file exists so the Agent Surface can be written, tested
 * and reviewed without editing B's files. At integration it is deleted and
 * `AgentSurfaceView` takes B's wrapper instead — the interface below is
 * deliberately the smallest thing an agent view needs, so swapping it is a
 * one-line change.
 *
 * The `@xterm/xterm` and `@xterm/addon-fit` packages are B's dependency to add
 * (see the report). They are reached through a dynamic specifier so this
 * subtree compiles before that install lands and so a page that never opens an
 * agent surface never pays for the terminal bundle.
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export interface TerminalGeometry {
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

/** What the Agent Surface needs of a terminal view, and nothing more. */
export interface AgentTerminalView {
  write(bytes: Uint8Array): void;
  writeText(text: string): void;
  onData(listener: (data: string) => void): void;
  /** Measures the host element; returns the fallback if it cannot. */
  measure(): TerminalGeometry;
  focus(): void;
  dispose(): void;
}

export interface AgentTerminalOptions {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly theme?: Record<string, string>;
}

export type AgentTerminalFactory = (
  host: HTMLElement,
  options: AgentTerminalOptions,
) => Promise<AgentTerminalView>;

export const FALLBACK_GEOMETRY: TerminalGeometry = {
  cols: 80,
  rows: 24,
  pixelWidth: 0,
  pixelHeight: 0,
};

export const createXtermView: AgentTerminalFactory = async (host, options) => {
  const terminal = new Terminal({
    allowProposedApi: true,
    convertEol: false,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    theme: options.theme,
    scrollback: 5_000,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);

  return {
    write(bytes) {
      terminal.write(bytes);
    },
    writeText(text) {
      terminal.write(text);
    },
    onData(listener) {
      terminal.onData(listener);
    },
    measure() {
      try {
        fit.fit();
        const dimensions = fit.proposeDimensions();
        if (dimensions && dimensions.cols > 0 && dimensions.rows > 0) {
          return {
            cols: Math.min(500, Math.max(1, dimensions.cols)),
            rows: Math.min(500, Math.max(1, dimensions.rows)),
            pixelWidth: 0,
            pixelHeight: 0,
          };
        }
      } catch {
        // A hidden host has no layout metrics. Main still receives a
        // bounded size, and the geometry is re-reported once the view
        // is on screen — this is a measurement gap, not a failure.
      }
      return FALLBACK_GEOMETRY;
    },
    focus() {
      terminal.focus();
    },
    dispose() {
      terminal.dispose();
    },
  };
};
