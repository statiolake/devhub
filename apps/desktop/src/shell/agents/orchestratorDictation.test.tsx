// @vitest-environment jsdom

/**
 * Dictation in the Orchestrator's answer to an escalation: the conversation's
 * own microphone (`FieldDictation.tsx`), on the Agents page's bridge. It is
 * drawn beside Send, puts the words in at the caret unsent and into the kept
 * draft, takes ⌘⇧M in the field, and a press on it or on its waveform is
 * neither a press on the field nor the end of the recording. Esc throws a
 * recording away and stays in the escalation.
 *
 * jsdom has no microphone and no Web Audio, so both are stood in for, as in
 * `conversation/dictation.test.tsx`.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../ipc/appShell";
import { EMPTY_BOARD, type OrchestratorBoardWire } from "../../ipc/contract";
import type { VoiceApi, VoiceUpdate } from "../../ipc/voice";
import { AgentsContext, type AgentsValue } from "./AgentsContext";
import { forgetOrchestratorMemory, memory } from "./orchestratorMemory";
import { OrchestratorBoard } from "./OrchestratorScreen";

interface FakeProcessor {
  onaudioprocess: ((event: unknown) => void) | null;
}

let processor: FakeProcessor | undefined;
let tracksStopped = 0;
const stream = { getTracks: () => [{ stop: () => void tracksStopped++ }] };

function installAudio() {
  processor = undefined;
  tracksStopped = 0;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => Promise.resolve(stream)),
      enumerateDevices: vi.fn(() => Promise.resolve([])),
    },
  });
  class FakeAudioContext {
    readonly sampleRate = 48_000;
    readonly destination = {};
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      const made = { onaudioprocess: null, connect() {}, disconnect() {} };
      processor = made;
      return made;
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        smoothingTimeConstant: 0.8,
        getFloatTimeDomainData(into: Float32Array) {
          into.fill(0.1);
        },
      };
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
}

function hear(samples: number) {
  act(() =>
    processor!.onaudioprocess!({
      inputBuffer: {
        getChannelData: () => new Float32Array(samples).fill(0.2),
      },
    }),
  );
}

type UpdateListener = (session: number, update: VoiceUpdate) => void;
let updateListener: UpdateListener | undefined;

function update(committed: string, tentative = "") {
  act(() => updateListener?.(7, { committed, tentative }));
}

function fakeVoice(): VoiceApi {
  updateListener = undefined;
  return {
    status: vi.fn(() => Promise.resolve({ available: true as const })),
    requestMicrophone: vi.fn(() =>
      Promise.resolve({ ok: true as const, value: true }),
    ),
    warm: vi.fn(() =>
      Promise.resolve({ ok: true as const, value: true as const }),
    ),
    begin: vi.fn(() => Promise.resolve({ ok: true as const, value: 7 })),
    audio: vi.fn(),
    end: vi.fn(() => Promise.resolve({ ok: true as const, value: "直して" })),
    cancel: vi.fn(),
    onUpdate: vi.fn((listener: UpdateListener) => {
      updateListener = listener;
      return () => {
        updateListener = undefined;
      };
    }),
  };
}

const answerEscalation = vi.fn(() => Promise.resolve());

function bridge(voice: VoiceApi | undefined) {
  window.devhub = {
    answerEscalation,
    setOrchestratorPaused: vi.fn(() => Promise.resolve()),
    openExternalUrl: vi.fn(() => Promise.resolve()),
    conversation: { resolvePaths: () => Promise.resolve([]) },
    resolveEscalationPaths: () => Promise.resolve([]),
    readEscalationEmbed: () => Promise.resolve(null),
    escalationEmbedSignature: () => Promise.resolve(null),
    ...(voice === undefined ? {} : { voice }),
  } as unknown as typeof window.devhub;
}

const NOW = Date.now();

const BOARD: OrchestratorBoardWire = {
  ...EMPTY_BOARD,
  revision: 1,
  orchestratorAgentId: "orch",
  needsAnswer: [
    {
      id: 1,
      title: "本番マイグレーションの実行承認",
      state: "needs_answer",
      entries: [
        {
          role: "orchestrator",
          markdown: "列を追加します。",
          at: NOW - 120_000,
          options: ["実行する", "保留"],
        },
      ],
      agents: [],
      links: [],
      createdAt: NOW - 120_000,
      updatedAt: NOW - 120_000,
      stateSince: NOW - 120_000,
    },
  ],
};

/** The board, with escalation #1 open over it. */
function open(voice: VoiceApi | undefined): HTMLTextAreaElement {
  bridge(voice);
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  render(
    <AgentsContext.Provider
      value={
        {
          board: BOARD,
          dispatch: vi.fn().mockResolvedValue(undefined),
          reportFailure: vi.fn(),
        } as unknown as AgentsValue
      }
    >
      <OrchestratorBoard
        snapshot={{ workspaces: [] } as unknown as AppSnapshot}
      />
    </AgentsContext.Provider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /本番マイグレーション/u }),
  );
  return answer();
}

function answer(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Your answer to #1" });
}

describe("dictating an answer to an escalation", () => {
  beforeEach(installAudio);
  afterEach(() => {
    cleanup();
    forgetOrchestratorMemory();
    window.sessionStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("draws the conversation's microphone beside Send, and none where the page cannot dictate", () => {
    open(fakeVoice());
    const box = answer().closest(".conversation-composer-box")!;
    const mic = screen.getByRole("button", { name: "Dictate" });
    expect(box).toContainElement(mic);
    expect(mic).toHaveClass("conversation-dictation");
    expect(
      screen.getByRole("button", { name: "Dictation language: 日本語" }),
    ).toBeInTheDocument();
    cleanup();
    forgetOrchestratorMemory();
    open(undefined);
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("puts the words in at the caret, unsent, and keeps them in the draft", async () => {
    const voice = fakeVoice();
    open(voice);
    fireEvent.change(answer(), { target: { value: "これを今" } });
    answer().setSelectionRange(3, 3);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictating" });
    expect(voice.begin).toHaveBeenCalledWith("ja");
    expect(document.querySelector(".conversation-dictation-wave")).not.toBe(
      null,
    );
    update("", "直");
    expect(screen.getByText("直")).toBeInTheDocument();
    hear(4800);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictating" }));
    await waitFor(() => expect(answer().value).toBe("これを直して今"));
    expect(memory.drafts.get(1)).toBe("これを直して今");
    expect(answerEscalation).not.toHaveBeenCalled();
    expect(tracksStopped).toBe(1);
    // Sent as anything typed: ⌘Return, and back to the board.
    fireEvent.keyDown(answer(), { key: "Enter", metaKey: true });
    expect(answerEscalation).toHaveBeenCalledWith(1, "これを直して今");
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
  });

  it("takes a press on the microphone or the waveform for neither a press on the field nor a stop", async () => {
    const voice = fakeVoice();
    open(voice);
    fireEvent.change(answer(), { target: { value: "これを今" } });
    answer().focus();
    answer().setSelectionRange(3, 3);
    expect(
      fireEvent.mouseDown(screen.getByRole("button", { name: "Dictate" })),
    ).toBe(true);
    expect(answer().selectionStart).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictating" });
    expect(
      fireEvent.mouseDown(
        screen.getByRole("button", { name: "Stop dictating" }),
      ),
    ).toBe(true);
    const wave = document.querySelector(".conversation-dictation-wave")!;
    fireEvent.mouseDown(wave.parentElement!);
    expect(document.activeElement).toBe(answer());
    expect(
      screen.getByRole("button", { name: "Stop dictating" }),
    ).toHaveAttribute("data-phase", "recording");
    expect(voice.cancel).not.toHaveBeenCalled();
    hear(4800);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictating" }));
    await waitFor(() => expect(answer().value).toBe("これを直して今"));
  });

  it("starts and stops on ⌘⇧M in the field", async () => {
    open(fakeVoice());
    const shortcut = { code: "KeyM", key: "M", metaKey: true, shiftKey: true };
    fireEvent.keyDown(answer(), shortcut);
    await screen.findByRole("button", { name: "Stop dictating" });
    hear(4800);
    fireEvent.keyDown(answer(), shortcut);
    await waitFor(() => expect(answer().value).toBe("直して"));
  });

  it("throws a recording away on Esc and stays in the escalation; Esc again goes back", async () => {
    const voice = fakeVoice();
    open(voice);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictating" });
    hear(4800);
    fireEvent.keyDown(answer(), { key: "Escape" });
    expect(voice.cancel).toHaveBeenCalledWith(7);
    expect(voice.end).not.toHaveBeenCalled();
    expect(tracksStopped).toBe(1);
    expect(document.querySelector(".orchestrator-reading")).not.toBeNull();
    expect(answer().value).toBe("");
    fireEvent.keyDown(answer(), { key: "Escape" });
    await waitFor(() =>
      expect(document.querySelector(".orchestrator-reading")).toBeNull(),
    );
  });
});
