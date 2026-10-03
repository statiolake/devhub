// @vitest-environment jsdom

/**
 * Dictation into the composer (`dictation.ts`, `useDictation.ts`).
 *
 * The arithmetic first — 48 kHz down to Whisper's 16, floats to 16-bit, and
 * where the words land among what was typed — and then the composer: the
 * microphone is there only when the page can dictate, says why when the build
 * has no recogniser, records on a click or ⌘⇧M, sends one 16 kHz recording to
 * main when it stops, puts the transcript in at the caret without sending it,
 * throws a recording away on Esc without stopping the turn, and hands a
 * refusal to the page's root.
 *
 * jsdom has no microphone and no Web Audio, so both are stood in for: the
 * fake processor is fed chunks by the test, as the audio thread would.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { VoiceApi } from "../../ipc/voice";
import { EMPTY_SESSION } from "../../model/conversation";
import {
  concatenate,
  downsample,
  insertDictation,
  isDictationKey,
  level,
  nextLanguage,
  pcm16,
  savedLanguage,
} from "./dictation";
import { draw, fakeActions, installResizeObserver } from "./surfaceTestKit";
import { transcriptOf } from "./transcriptFixtures";

describe("the recording, as Whisper reads it", () => {
  it("brings 48 kHz down to 16 kHz, averaging each interval", () => {
    const samples = Float32Array.from([0, 0.3, 0.6, 1, 1, 1, -1, -1, -1.0]);
    const out = downsample(samples, 48_000);
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo(0.3);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(-1);
  });

  it("brings 44.1 kHz to the length 16 kHz has for the same time", () => {
    expect(downsample(new Float32Array(44_100), 44_100).length).toBe(16_000);
  });

  it("leaves 16 kHz as it is and refuses to invent samples", () => {
    const samples = new Float32Array(10);
    expect(downsample(samples, 16_000)).toBe(samples);
    expect(() => downsample(samples, 8_000)).toThrow(/upsample/);
  });

  it("writes 16-bit little-endian, clipping what is out of range", () => {
    const bytes = pcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    const view = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(12);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32768);
    expect(view.getInt16(6, true)).toBe(32767);
    expect(view.getInt16(8, true)).toBe(-32768);
    expect(view.getInt16(10, true)).toBe(16384);
  });

  it("joins chunks in the order they came", () => {
    expect([
      ...concatenate([Float32Array.from([1, 2]), Float32Array.from([3])]),
    ]).toEqual([1, 2, 3]);
  });

  it("reads silence as no level and speech as some", () => {
    expect(level(new Float32Array(100))).toBe(0);
    expect(level(new Float32Array(100).fill(0.1))).toBeGreaterThan(0.5);
    expect(level(new Float32Array(100).fill(1))).toBe(1);
  });
});

describe("where the words land", () => {
  it("puts English after English with a space, and the caret after it", () => {
    expect(insertDictation("Fix the", 7, 7, "login bug")).toEqual({
      text: "Fix the login bug",
      caret: 17,
    });
  });

  it("puts a space on both sides in the middle of Latin text", () => {
    expect(insertDictation("ab", 1, 1, "x").text).toBe("a x b");
  });

  it("puts no space where either side is Japanese", () => {
    expect(insertDictation("これを", 3, 3, "直して").text).toBe("これを直して");
    expect(insertDictation("README を", 8, 8, "update").text).toBe(
      "README をupdate",
    );
    expect(insertDictation("README", 6, 6, "を更新").text).toBe("READMEを更新");
  });

  it("adds nothing where there is already whitespace, or nothing at all", () => {
    expect(insertDictation("Fix ", 4, 4, "it").text).toBe("Fix it");
    expect(insertDictation("", 0, 0, "Hello").text).toBe("Hello");
  });

  it("replaces the selection", () => {
    expect(insertDictation("say WORD now", 4, 8, "this")).toEqual({
      text: "say this now",
      caret: 8,
    });
  });
});

describe("the shortcut and the language", () => {
  const key = (init: Partial<Parameters<typeof isDictationKey>[0]>) =>
    isDictationKey({
      code: "KeyM",
      metaKey: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      ...init,
    });

  it("is ⌘⇧M by its physical key, and nothing else", () => {
    expect(key({})).toBe(true);
    expect(key({ shiftKey: false })).toBe(false);
    expect(key({ altKey: true })).toBe(false);
    expect(key({ code: "KeyN" })).toBe(false);
  });

  it("cycles Auto, Japanese, English", () => {
    expect(nextLanguage("auto")).toBe("ja");
    expect(nextLanguage("ja")).toBe("en");
    expect(nextLanguage("en")).toBe("auto");
  });

  it("reads anything it did not write, or a storage that throws, as auto", () => {
    expect(savedLanguage({ getItem: () => "ja" })).toBe("ja");
    expect(savedLanguage({ getItem: () => "fr" })).toBe("auto");
    expect(savedLanguage(undefined)).toBe("auto");
    expect(
      savedLanguage({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBe("auto");
  });
});

// --- the composer -------------------------------------------------------------

interface FakeProcessor {
  onaudioprocess: ((event: unknown) => void) | null;
}

let processor: FakeProcessor | undefined;
let tracksStopped = 0;

function installAudio() {
  processor = undefined;
  tracksStopped = 0;
  const stream = {
    getTracks: () => [{ stop: () => void tracksStopped++ }],
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
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
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

/** One chunk from the microphone, as the audio thread would hand it over. */
function hear(samples: number) {
  act(() =>
    processor!.onaudioprocess!({
      inputBuffer: {
        getChannelData: () => new Float32Array(samples).fill(0.2),
      },
    }),
  );
}

function fakeVoice(overrides: Partial<VoiceApi> = {}): VoiceApi {
  return {
    status: vi.fn(() => Promise.resolve({ available: true as const })),
    requestMicrophone: vi.fn(() =>
      Promise.resolve({ ok: true as const, value: true }),
    ),
    transcribe: vi.fn(() =>
      Promise.resolve({ ok: true as const, value: "直して" }),
    ),
    ...overrides,
  };
}

const READY = transcriptOf([
  { type: "session", session: EMPTY_SESSION },
  { type: "state", state: { phase: "ready", turn: "none" } },
]);

function composer(): HTMLTextAreaElement {
  return screen.getByLabelText("Message to the Agent");
}

describe("dictating in the composer", () => {
  beforeAll(() => {
    installResizeObserver();
    Element.prototype.scrollIntoView = vi.fn();
  });
  beforeEach(installAudio);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("draws no microphone where the page cannot dictate", () => {
    draw(READY);
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("says why when this build has no recogniser", async () => {
    const voice = fakeVoice({
      status: () =>
        Promise.resolve({
          available: false as const,
          reason: "No recogniser.",
        }),
    });
    draw(READY, fakeActions({ voice }));
    const button = screen.getByRole("button", { name: "Dictate" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute("title", "No recogniser.");
  });

  it("records, sends 16 kHz to main, and puts the words at the caret unsent", async () => {
    const voice = fakeVoice();
    const actions = fakeActions({ voice });
    draw(READY, actions);
    fireEvent.change(composer(), { target: { value: "これを" } });
    composer().setSelectionRange(3, 3);

    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictating" });
    hear(4800);
    hear(4800);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictating" }));

    await waitFor(() => expect(composer().value).toBe("これを直して"));
    expect(voice.transcribe).toHaveBeenCalledTimes(1);
    const [pcm, language] = vi.mocked(voice.transcribe).mock.calls[0]!;
    // 9600 samples at 48 kHz is 3200 at 16 kHz, two bytes each.
    expect(pcm.byteLength).toBe(6400);
    expect(language).toBe("auto");
    expect(tracksStopped).toBe(1);
    expect(actions.send).not.toHaveBeenCalled();
  });

  it("starts and stops on ⌘⇧M", async () => {
    const voice = fakeVoice({
      transcribe: vi.fn(() =>
        Promise.resolve({ ok: true as const, value: "hello" }),
      ),
    });
    draw(READY, fakeActions({ voice }));
    const shortcut = { code: "KeyM", key: "M", metaKey: true, shiftKey: true };
    fireEvent.keyDown(composer(), shortcut);
    await screen.findByRole("button", { name: "Stop dictating" });
    hear(4800);
    fireEvent.keyDown(composer(), shortcut);
    await waitFor(() => expect(composer().value).toBe("hello"));
  });

  it("throws the recording away on Esc, and does not stop the turn", async () => {
    const voice = fakeVoice();
    const actions = fakeActions({ voice });
    draw(
      transcriptOf([
        { type: "session", session: EMPTY_SESSION },
        { type: "state", state: { phase: "ready", turn: "running" } },
      ]),
      actions,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictating" });
    hear(4800);
    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(actions.interrupt).not.toHaveBeenCalled();
    expect(tracksStopped).toBe(1);
  });

  it("hands a refused microphone to the page's root", async () => {
    const voice = fakeVoice({
      requestMicrophone: () =>
        Promise.resolve({ ok: false as const, reason: "Not allowed." }),
    });
    const actions = fakeActions({ voice });
    draw(READY, actions);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(
        new Error("Not allowed."),
      ),
    );
    expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled();
  });

  it("listens for the language chosen beside it", async () => {
    const voice = fakeVoice();
    draw(READY, fakeActions({ voice }));
    fireEvent.click(
      screen.getByRole("button", { name: "Dictation language: Auto" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictating" });
    hear(4800);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictating" }));
    await waitFor(() => expect(voice.transcribe).toHaveBeenCalled());
    expect(vi.mocked(voice.transcribe).mock.calls[0]![1]).toBe("ja");
  });
});
