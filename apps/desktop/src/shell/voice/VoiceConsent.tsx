/**
 * The questions voice input asks before it changes what is on the Mac,
 * drawn the way DevHub asks every question (`Picker`): a list of answers
 * with the one that changes nothing first, so Return and Escape take it.
 *
 * - `VoiceConsentPicker`: turning voice input on downloads its model. It
 *   says which model, how big, from which host, where it is kept, and that
 *   afterwards it runs on this Mac and no audio leaves it — and downloads
 *   only on ダウンロード. Asked by the main window's modal layer (the
 *   microphone's first press) and by Settings (the switch, or another
 *   model), with the same words.
 * - `VoiceDisablePicker`: turning it off, with the model's space to free.
 * - `VoiceDeletePicker`: deleting a downloaded model.
 */

import { Picker } from "../components/shell/Picker";
import type { VoiceConsentWire } from "../../ipc/voice";

export const DOWNLOAD = "voice:download";

/** The facts the person agrees to, under the list. */
function ConsentFacts({ consent }: { readonly consent: VoiceConsentWire }) {
  return (
    <>
      <ul className="mac-detail-list">
        <li>
          <span>モデル</span>
          <span>
            {consent.label}（{consent.file}）
          </span>
        </li>
        <li>
          <span>サイズ</span>
          <span>約 {consent.size}</span>
        </li>
        <li>
          <span>ダウンロード元</span>
          <span>{consent.host}</span>
        </li>
        <li>
          <span>保存先</span>
          <span>{consent.directory}</span>
        </li>
      </ul>
      <p className="voice-consent-local">
        ダウンロードは一度だけです。そのあと音声認識はこの Mac
        の中だけで動き、音声が Mac の外に送られることはありません。
      </p>
    </>
  );
}

export function VoiceConsentPicker({
  consent,
  turningOn = true,
  onDownload,
  onCancel,
}: {
  readonly consent: VoiceConsentWire;
  /** `false` when voice input is already on and only the model changes. */
  readonly turningOn?: boolean;
  readonly onDownload: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Picker
      title={
        turningOn
          ? "音声入力をオンにしますか？"
          : `${consent.label} に切り替えますか？`
      }
      question={`音声入力には音声認識モデル（${consent.label}、約 ${consent.size}）が必要です。DevHub には同梱されていないため、${consent.host} からダウンロードします。`}
      cancelRow={{
        label: "キャンセル",
        detail: turningOn
          ? "音声入力はオフのままです。何もダウンロードしません。"
          : "モデルはそのままです。何もダウンロードしません。",
      }}
      items={[
        {
          id: DOWNLOAD,
          label: "ダウンロード",
          detail: `約 ${consent.size} をダウンロードして確認し、${turningOn ? "音声入力をオンにします" : "このモデルに切り替えます"}。`,
        },
      ]}
      note={<ConsentFacts consent={consent} />}
      onChoose={({ id }) => {
        if (id === DOWNLOAD) onDownload();
      }}
      onCancel={onCancel}
    />
  );
}

export function VoiceDisablePicker({
  models,
  onDisable,
  onCancel,
}: {
  /** The downloaded models, as `ggml-small.bin（466 MiB）`; none when nothing is on disk. */
  readonly models: readonly string[];
  readonly onDisable: (deleteModels: boolean) => void;
  readonly onCancel: () => void;
}) {
  const has = models.length > 0;
  return (
    <Picker
      title="音声入力をオフにしますか？"
      question={
        has
          ? `ダウンロードした音声認識モデル（${models.join("、")}）を削除すると、その分の空き容量が戻ります。もう一度オンにするときは、またダウンロードします。`
          : "マイクのボタンは、押すとまた音声入力をオンにするか確認します。"
      }
      cancelRow={{ label: "キャンセル", detail: "音声入力はオンのままです。" }}
      items={[
        {
          id: "keep",
          label: has ? "オフにする（モデルは残す）" : "オフにする",
          detail: has
            ? "次にオンにするときはダウンロードせずに使えます。"
            : "何も削除しません。",
        },
        ...(has
          ? [
              {
                id: "delete",
                label: "オフにしてモデルを削除",
                detail: `${models.join("、")} を削除して空き容量を戻します。`,
              },
            ]
          : []),
      ]}
      onChoose={({ id }) => {
        if (id === "keep" || id === "delete") onDisable(id === "delete");
      }}
      onCancel={onCancel}
    />
  );
}

export function VoiceDeletePicker({
  model,
  onDelete,
  onCancel,
}: {
  /** `Whisper small（ggml-small.bin、466 MiB）`. */
  readonly model: string;
  readonly onDelete: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Picker
      title="音声認識モデルを削除しますか？"
      question={`${model} を削除して空き容量を戻します。使うときはまたダウンロードします。`}
      cancelRow={{ label: "キャンセル", detail: "モデルは残ります。" }}
      items={[
        { id: "delete", label: "削除", detail: "このモデルを削除します。" },
      ]}
      onChoose={({ id }) => {
        if (id === "delete") onDelete();
      }}
      onCancel={onCancel}
    />
  );
}
