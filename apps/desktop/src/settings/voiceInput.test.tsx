// @vitest-environment jsdom

/**
 * General → 音声入力: the switch asks before it downloads, キャンセル leaves
 * voice input off, and turning it off offers to delete the model.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  VoiceModelState,
  VoiceSetupApi,
  VoiceSetupWire,
} from "../ipc/voice";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

afterEach(() => {
  cleanup();
});

function setupWire(
  enabled: boolean,
  small: VoiceModelState = { kind: "absent" },
): VoiceSetupWire {
  return {
    recogniser: true,
    enabled,
    model: "small",
    directory: "~/Library/Application Support/DevHub/editor/devhub/whisper",
    models: [
      {
        id: "small",
        label: "Whisper small",
        file: "ggml-small.bin",
        size: "466 MiB",
        host: "huggingface.co",
        state: small,
      },
      {
        id: "large-v3-turbo",
        label: "Whisper large-v3-turbo (q5_0)",
        file: "ggml-large-v3-turbo-q5_0.bin",
        size: "547 MiB",
        host: "huggingface.co",
        state: { kind: "absent" },
      },
    ],
  };
}

function fakeVoice(initial: VoiceSetupWire): VoiceSetupApi {
  const answer = (setup: VoiceSetupWire) =>
    Promise.resolve({ ok: true as const, value: setup });
  return {
    get: vi.fn(() => Promise.resolve(initial)),
    onChanged: vi.fn(() => () => undefined),
    enable: vi.fn(() =>
      answer({
        ...setupWire(true, { kind: "downloading", received: 0, total: 100 }),
      }),
    ),
    disable: vi.fn(() => answer(setupWire(false))),
    deleteModel: vi.fn(() => answer(setupWire(false))),
    retry: vi.fn(() => answer(initial)),
    cancelDownload: vi.fn(() => answer(setupWire(false))),
  };
}

async function open(setup: VoiceSetupWire) {
  const voice = fakeVoice(setup);
  const { client } = testClient(testConfig());
  render(<SettingsApp client={{ ...client, voice }} />);
  const toggle = await screen.findByRole("checkbox", { name: "音声入力" });
  return { voice, toggle };
}

describe("turning voice input on", () => {
  it("is off by default", async () => {
    const { toggle } = await open(setupWire(false));
    expect(toggle).not.toBeChecked();
  });

  it("asks first, stating the model, its size, the host, where it goes and that audio stays on the Mac", async () => {
    const { toggle, voice } = await open(setupWire(false));
    fireEvent.click(toggle);
    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText("音声入力をオンにしますか？"),
    ).toBeInTheDocument();
    expect(sheet).toHaveTextContent("Whisper small（ggml-small.bin）");
    expect(sheet).toHaveTextContent("約 466 MiB");
    expect(sheet).toHaveTextContent("huggingface.co");
    expect(sheet).toHaveTextContent(
      "~/Library/Application Support/DevHub/editor/devhub/whisper",
    );
    expect(sheet).toHaveTextContent(
      "音声が Mac の外に送られることはありません",
    );
    expect(voice.enable).not.toHaveBeenCalled();
  });

  it("leaves it off on キャンセル", async () => {
    const { toggle, voice } = await open(setupWire(false));
    fireEvent.click(toggle);
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByText("キャンセル"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(voice.enable).not.toHaveBeenCalled();
    expect(toggle).not.toBeChecked();
  });

  it("turns it on and shows the download on ダウンロード", async () => {
    const { toggle, voice } = await open(setupWire(false));
    fireEvent.click(toggle);
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByText("ダウンロード"));
    await vi.waitFor(() => {
      expect(voice.enable).toHaveBeenCalledWith("small");
    });
    expect(await screen.findByText(/0%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "中止" })).toBeInTheDocument();
  });

  it("turns on without asking when the model is already here", async () => {
    const { toggle, voice } = await open(setupWire(false, { kind: "ready" }));
    fireEvent.click(toggle);
    await vi.waitFor(() => {
      expect(voice.enable).toHaveBeenCalledWith("small");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers a retry when the download failed", async () => {
    const { voice } = await open(
      setupWire(true, { kind: "failed", reason: "接続が切れました。" }),
    );
    expect(await screen.findByText(/接続が切れました。/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await vi.waitFor(() => {
      expect(voice.retry).toHaveBeenCalled();
    });
  });
});

describe("turning voice input off", () => {
  it("offers to delete the model, and deletes it only when that is chosen", async () => {
    const { toggle, voice } = await open(setupWire(true, { kind: "ready" }));
    fireEvent.click(toggle);
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent("オフにする（モデルは残す）");
    fireEvent.click(within(sheet).getByText("オフにしてモデルを削除"));
    await vi.waitFor(() => {
      expect(voice.disable).toHaveBeenCalledWith(true);
    });
  });

  it("asks before deleting a downloaded model", async () => {
    const { voice } = await open(setupWire(true, { kind: "ready" }));
    fireEvent.click(await screen.findByRole("button", { name: "削除…" }));
    const sheet = await screen.findByRole("dialog");
    expect(voice.deleteModel).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByText("削除"));
    await vi.waitFor(() => {
      expect(voice.deleteModel).toHaveBeenCalledWith("small");
    });
  });
});
