/**
 * General → 音声入力: voice input turned on and off, its model chosen, and
 * the models on this Mac managed.
 *
 * Unlike every other value in this window, the switch is not applied where
 * it is clicked: turning voice input on downloads its model, and that is a
 * question (`VoiceConsentPicker`) — the switch stays off until the person
 * says ダウンロード, and キャンセル leaves it off. The download is main's; this
 * shows its progress, a failure with 再試行, and 中止. Turning it off asks
 * whether to delete the model as well, and deleting one asks first.
 *
 * What is on and which model is `[voice]` in `settings.toml`; it is written
 * by main (`VoiceSetupApi`), and the snapshot that follows shows it. The model
 * popup is an ordinary value while voice input is off; while it is on,
 * choosing a model that is not here asks before downloading it.
 */

import { useEffect, useState } from "react";
import type { SettingsConfig } from "../ipc/settings";
import {
  chosenModel,
  consentFor,
  downloadPercent,
  megabytes,
  type VoiceModelId,
  type VoiceModelWire,
  type VoiceResult,
  type VoiceSetupApi,
  type VoiceSetupWire,
} from "../ipc/voice";
import {
  VoiceConsentPicker,
  VoiceDeletePicker,
  VoiceDisablePicker,
} from "../shell/voice/VoiceConsent";
import { Group, Popup, Row } from "./controls";

type Sheet =
  | {
      readonly kind: "consent";
      readonly model: VoiceModelId;
      readonly turningOn: boolean;
    }
  | { readonly kind: "disable" }
  | { readonly kind: "delete"; readonly model: VoiceModelId };

function described(model: VoiceModelWire): string {
  return `${model.label}（${model.file}、${model.size}）`;
}

export function VoiceGroup({
  client,
  config,
  update,
}: {
  readonly client: VoiceSetupApi;
  readonly config: SettingsConfig;
  readonly update: (next: SettingsConfig) => void;
}) {
  const [setup, setSetup] = useState<VoiceSetupWire>();
  const [sheet, setSheet] = useState<Sheet>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    const unsubscribe = client.onChanged((next) => {
      if (live) setSetup(next);
    });
    void client.get().then((next) => {
      if (live) setSetup(next);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client]);

  if (setup === undefined) return null;

  const act = (work: Promise<VoiceResult<VoiceSetupWire>>) => {
    setError(undefined);
    void work.then(
      (result) => {
        if (result.ok) setSetup(result.value);
        else setError(result.reason);
      },
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
  };

  const model = chosenModel(setup);
  /** Turn on (or switch to) `id`: straight away when it is here, else ask. */
  const choose = (id: VoiceModelId, turningOn: boolean) => {
    const wanted = setup.models.find((each) => each.id === id);
    if (
      wanted !== undefined &&
      (wanted.state.kind === "ready" ||
        (setup.override !== undefined && id === setup.model))
    ) {
      act(client.enable(id));
    } else setSheet({ kind: "consent", model: id, turningOn });
  };
  const downloaded = setup.models.filter((each) => each.state.kind === "ready");
  const consent =
    sheet?.kind === "consent" ? consentFor(setup, sheet.model) : undefined;
  const deleting =
    sheet?.kind === "delete"
      ? setup.models.find((each) => each.id === sheet.model)
      : undefined;

  return (
    <Group
      heading="音声入力"
      note={
        setup.recogniser
          ? "コンポーザーのマイク（⌘⇧M）で話した言葉を文字にします。音声認識はこの Mac の中だけで動き、音声が外に送られることはありません。認識モデルは DevHub に同梱されていないため、オンにしたときに一度だけダウンロードします（確認してから）。"
          : "この DevHub には音声認識のプログラムが入っていないため、音声入力は使えません。"
      }
    >
      <Row
        label="音声入力"
        help={
          setup.enabled
            ? undefined
            : "オフです。オンにすると、モデルがまだなければダウンロードするか確認します。"
        }
      >
        <input
          type="checkbox"
          className="mac-switch"
          aria-label="音声入力"
          checked={setup.enabled}
          disabled={!setup.recogniser}
          onChange={(event) => {
            if (event.target.checked) choose(setup.model, true);
            else setSheet({ kind: "disable" });
          }}
        />
      </Row>
      <Row
        label="モデル"
        help="small は軽く、日本語の口述に十分です（既定）。large-v3-turbo はより正確ですが重く、GPU を多く使います。"
      >
        <Popup
          label="音声認識モデル"
          value={setup.model}
          options={setup.models.map(
            (each) => [each.id, `${each.label}（${each.size}）`] as const,
          )}
          onChange={(id) => {
            if (id === setup.model) return;
            if (setup.enabled) choose(id, false);
            else update({ ...config, voice: { ...config.voice, model: id } });
          }}
        />
      </Row>
      {model !== undefined ? (
        <Row label="状態" help={error}>
          <ModelStatus
            setup={setup}
            model={model}
            onDownload={() => {
              setSheet({ kind: "consent", model: model.id, turningOn: false });
            }}
            onRetry={() => {
              act(client.retry());
            }}
            onCancel={() => {
              act(client.cancelDownload());
            }}
          />
        </Row>
      ) : null}
      {downloaded.length > 0 ? (
        <Row label="保存済み" help={`保存先: ${setup.directory}`}>
          <ul className="sf-voice-models">
            {downloaded.map((each) => (
              <li key={each.id}>
                <span>{described(each)}</span>
                <button
                  type="button"
                  className="mac-button"
                  onClick={() => {
                    setSheet({ kind: "delete", model: each.id });
                  }}
                >
                  削除…
                </button>
              </li>
            ))}
          </ul>
        </Row>
      ) : null}

      {consent !== undefined && sheet?.kind === "consent" ? (
        <VoiceConsentPicker
          consent={consent}
          turningOn={sheet.turningOn && !setup.enabled}
          onDownload={() => {
            setSheet(undefined);
            act(client.enable(sheet.model));
          }}
          onCancel={() => {
            setSheet(undefined);
          }}
        />
      ) : null}
      {sheet?.kind === "disable" ? (
        <VoiceDisablePicker
          models={downloaded.map(described)}
          onDisable={(deleteModels) => {
            setSheet(undefined);
            act(client.disable(deleteModels));
          }}
          onCancel={() => {
            setSheet(undefined);
          }}
        />
      ) : null}
      {deleting !== undefined ? (
        <VoiceDeletePicker
          model={described(deleting)}
          onDelete={() => {
            setSheet(undefined);
            act(client.deleteModel(deleting.id));
          }}
          onCancel={() => {
            setSheet(undefined);
          }}
        />
      ) : null}
    </Group>
  );
}

/** Where the chosen model is: here, downloading, failed, or not yet. */
function ModelStatus({
  setup,
  model,
  onDownload,
  onRetry,
  onCancel,
}: {
  readonly setup: VoiceSetupWire;
  readonly model: VoiceModelWire;
  readonly onDownload: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
}) {
  if (setup.override !== undefined)
    return (
      <span className="sf-voice-status">
        開発用のモデルを使っています:{" "}
        <code className="mac-mono">{setup.override}</code>
      </span>
    );
  const state = model.state;
  switch (state.kind) {
    case "ready":
      return (
        <span className="sf-voice-status">
          ダウンロード済み（{model.size}）
        </span>
      );
    case "absent":
      return (
        <span className="sf-voice-status">
          未ダウンロード（{model.size}、{model.host}）
          {setup.enabled ? (
            <button type="button" className="mac-button" onClick={onDownload}>
              ダウンロード…
            </button>
          ) : null}
        </span>
      );
    case "downloading": {
      const percent = downloadPercent(state.received, state.total);
      return (
        <span className="sf-voice-status">
          <progress
            aria-label="ダウンロードの進み具合"
            max={100}
            {...(percent === undefined ? {} : { value: percent })}
          />
          {percent === undefined
            ? `${megabytes(state.received)} ダウンロード済み`
            : `${String(percent)}%（${megabytes(state.received)} / ${megabytes(state.total!)}）`}
          <button type="button" className="mac-button" onClick={onCancel}>
            中止
          </button>
        </span>
      );
    }
    case "verifying":
      return <span className="sf-voice-status">確認しています…</span>;
    case "failed":
      return (
        <span className="sf-voice-status" data-failed="">
          ダウンロードに失敗しました: {state.reason}
          <button type="button" className="mac-button" onClick={onRetry}>
            再試行
          </button>
        </span>
      );
  }
}
