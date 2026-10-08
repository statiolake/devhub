// @vitest-environment jsdom

/**
 * Dictation into the composer (`dictation.ts`, `useDictation.ts`).
 *
 * The arithmetic first — 48 kHz down to Whisper's 16, floats to 16-bit, and
 * where the words land among what was typed — and then the composer: the
 * microphone is there only when the page can dictate, says why when the build
 * has no recogniser, records on a click or ⌘⇧M, streams 16 kHz audio to main
 * while it records, puts committed words in at the caret as they come (and
 * shows the tentative ones beside them) without sending, keeps what is typed
 * meanwhile, throws the rest away on Esc without stopping the turn, and hands
 * a refusal to the page's root.
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
import type { VoiceApi, VoiceUpdate } from "../../ipc/voice";
import { EMPTY_SESSION } from "../../model/conversation";
import {
  concatenate,
  dictationFailure,
  downsample,
  insertDictation,
  isDictationKey,
  level,
  nextLanguage,
  pcm16,
  placeDictation,
  shiftAnchor,
  StreamingDownsampler,
  MICROPHONE_DENIED_TITLE,
  savedLanguage,
  VOICE_FAILED_TITLE,
} from "./dictation";
import { toAppError } from "../failure";
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

type UpdateListener = (session: number, update: VoiceUpdate) => void;
let updateListener: UpdateListener | undefined;

/** Main's answer to the running dictation, as it would send it. */
function update(committed: string, tentative = "") {
  act(() => updateListener?.(7, { committed, tentative }));
}

function fakeVoice(overrides: Partial<VoiceApi> = {}): VoiceApi {
  updateListener = undefined;
  return {
    status: vi.fn(() => Promise.resolve({ available: true as const })),
    requestMicrophone: vi.fn(() =>
      Promise.resolve({ ok: true as const, value: true }),
    ),
    warm: vi.fn(),
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

  it("streams 16 kHz to main, and puts the words at the caret unsent", async () => {
    const voice = fakeVoice();
    const actions = fakeActions({ voice });
    draw(READY, actions);
    fireEvent.change(composer(), { target: { value: "これを" } });
    composer().setSelectionRange(3, 3);

    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictating" });
    expect(voice.warm).toHaveBeenCalled();
    expect(voice.begin).toHaveBeenCalledWith("auto");
    // 0.25 s at 16 kHz is sent as soon as it is collected: 12000 at 48 kHz.
    hear(6000);
    expect(voice.audio).not.toHaveBeenCalled();
    hear(6000);
    expect(voice.audio).toHaveBeenCalledTimes(1);
    expect(vi.mocked(voice.audio).mock.calls[0]![1].byteLength).toBe(8000);
    hear(4800);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictating" }));
    // What was left is sent before the end.
    expect(voice.audio).toHaveBeenCalledTimes(2);
    expect(vi.mocked(voice.audio).mock.calls[1]![1].byteLength).toBe(3200);

    await waitFor(() => expect(composer().value).toBe("これを直して"));
    expect(voice.end).toHaveBeenCalledWith(7);
    expect(tracksStopped).toBe(1);
    expect(actions.send).not.toHaveBeenCalled();
  });

  it("puts committed words in as they come, shows tentative ones, and keeps what is typed meanwhile", async () => {
    const voice = fakeVoice({
      end: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          value: "Fix the bug in the parser.",
        }),
      ),
    });
    draw(READY, fakeActions({ voice }));
    fireEvent.change(composer(), { target: { value: "Note: " } });
    composer().setSelectionRange(6, 6);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await screen.findByRole("button", { name: "Stop dictating" });

    update("", "Fix the");
    expect(screen.getByText("Fix the")).toBeInTheDocument();
    expect(composer().value).toBe("Note: ");

    update("Fix the bug", "in");
    await waitFor(() => expect(composer().value).toBe("Note: Fix the bug"));
    expect(screen.getByText("in")).toBeInTheDocument();

    // Typed before where the words go, while dictating.
    fireEvent.change(composer(), { target: { value: "My note: Fix the bug" } });
    update("Fix the bug in the", "parser");
    await waitFor(() =>
      expect(composer().value).toBe("My note: Fix the bug in the"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop dictating" }));
    await waitFor(() =>
      expect(composer().value).toBe("My note: Fix the bug in the parser."),
    );
    expect(screen.queryByText("parser")).toBeNull();
  });

  it("starts and stops on ⌘⇧M", async () => {
    const voice = fakeVoice({
      end: vi.fn(() => Promise.resolve({ ok: true as const, value: "hello" })),
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
    expect(voice.end).not.toHaveBeenCalled();
    expect(voice.cancel).toHaveBeenCalledWith(7);
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
    await waitFor(() => expect(actions.reportFailure).toHaveBeenCalled());
    const reported = toAppError(
      vi.mocked(actions.reportFailure).mock.calls[0]![0],
    );
    expect(reported.summary).toBe(MICROPHONE_DENIED_TITLE);
    expect(reported.detail).toBe("Not allowed.");
    expect(reported.actions).toEqual(["open_microphone_settings"]);
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
    expect(voice.begin).toHaveBeenCalledWith("ja");
  });
});

describe("streaming the recording", () => {
  it("downsamples pieces as one recording, carrying what does not fill a sample", () => {
    const whole = Float32Array.from({ length: 441 * 4 }, (_, i) =>
      Math.sin(i / 7),
    );
    const once = downsample(whole, 44_100);
    const pieces = new StreamingDownsampler(44_100);
    const streamed = concatenate([
      pieces.push(whole.subarray(0, 100)),
      pieces.push(whole.subarray(100, 1000)),
      pieces.push(whole.subarray(1000)),
    ]);
    expect(streamed.length).toBe(once.length);
    for (let i = 0; i < once.length; i++)
      expect(streamed[i]).toBeCloseTo(once[i]!, 1);
  });
});

describe("where streamed words go", () => {
  it("moves the place with edits before it, not after it", () => {
    expect(shiftAnchor("abc", "XXabc", 1)).toBe(3);
    expect(shiftAnchor("abc", "abcYY", 1)).toBe(1);
    expect(shiftAnchor("abc", "abc", 2)).toBe(2);
    // Inside a replaced stretch: after what replaced it.
    expect(shiftAnchor("abcdef", "abZZef", 3)).toBe(4);
  });

  it("replaces the selection first, then follows each phrase", () => {
    let placed = placeDictation(
      "say WORD now",
      { start: 4, end: 8, text: "say WORD now" },
      "hello",
    );
    expect(placed.text).toBe("say hello now");
    placed = placeDictation(placed.text, placed.anchor, "world");
    expect(placed.text).toBe("say hello world now");
    const edited = `> ${placed.text}`;
    placed = placeDictation(edited, placed.anchor, "again");
    expect(placed.text).toBe("> say hello world again now");
  });

  it("joins Japanese phrases with nothing between", () => {
    let placed = placeDictation("", { start: 0, end: 0, text: "" }, "これを");
    placed = placeDictation(placed.text, placed.anchor, "直して");
    expect(placed.text).toBe("これを直して");
  });
});

describe("how a dictation failure reads", () => {
  it("names a refused microphone and offers the Microphone pane", () => {
    const denied = new Error("Permission denied");
    denied.name = "NotAllowedError";
    const error = toAppError(dictationFailure("open", denied));
    expect(error.summary).toBe(MICROPHONE_DENIED_TITLE);
    expect(error.summary).not.toMatch(/native app shell/);
    expect(error.detail).toContain("Permission denied");
    expect(error.detail).toContain("Privacy & Security → Microphone");
    expect(error.actions).toEqual(["open_microphone_settings"]);
  });

  it("calls anything else a voice failure, with no misleading buttons", () => {
    const busy = new Error("Device in use");
    busy.name = "NotReadableError";
    const open = toAppError(dictationFailure("open", busy));
    expect(open.summary).toBe(VOICE_FAILED_TITLE);
    expect(open.detail).toBe(
      "The microphone could not be opened: Device in use",
    );
    expect(open.actions).toEqual([]);
    const heard = toAppError(
      dictationFailure("transcribe", new Error("whisper exited 1")),
    );
    expect(heard.summary).toBe(VOICE_FAILED_TITLE);
    expect(heard.detail).toBe("whisper exited 1");
    expect(heard.actions).toEqual([]);
  });
});
