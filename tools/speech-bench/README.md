# speech-bench

A standalone tool for measuring Apple's on-device speech-to-text in macOS 26
(`SpeechAnalyzer` + `SpeechTranscriber`, the Speech framework) on Japanese
dictation, side by side with the whisper.cpp build DevHub ships
(`scripts/build_whisper.py`). It exists to answer one question: should DevHub's
dictation use Apple's recogniser, which would mean requiring macOS 26?

It is not part of the app. Nothing in the workspace, the build or CI uses it.

- `speech-bench`: a Swift command-line tool (`Sources/speech-bench`). It
  transcribes a file or the microphone and reports what came back and when.
- `compare.py`: runs speech-bench and whisper.cpp (one or more models) on a
  folder of clips, and prints wall time, real-time factor and character error
  rate (CER) against reference transcripts.

Requirements: macOS 26 or later, Apple Silicon, Xcode 26 or its command-line
tools (Swift 6.2). The M1 MacBook Air is one of the target machines.

## Build

```sh
cd tools/speech-bench
swift build -c release
.build/release/speech-bench locales          # is ja-JP supported here, installed, reserved?
```

The build links `Info.plist` into the binary's `__TEXT,__info_plist` section
(`Package.swift` passes `-Xlinker -sectcreate -Xlinker __TEXT -Xlinker
__info_plist -Xlinker Info.plist`). To check that it is there:

```sh
otool -X -s __TEXT __info_plist .build/release/speech-bench | head
```

## Run

### A file

```sh
.build/release/speech-bench file clip.m4a --locale ja_JP
```

Any format AVAudioFile reads works: wav, m4a, aiff, caf, mp3. Example output
(times depend on the machine):

```
input clip.m4a: 6.12s, 44100 Hz, 1 ch, float32, non-interleaved
engine transcriber, locale ja-JP, assets already installed
analyzer format: 16000 Hz, 1 ch, int16, interleaved; prepared in 0.31s
[vol]   audio 0.00–1.20s  at 0.18s  latency -s  「useDictation の」
[vol]   audio 0.00–2.64s  at 0.29s  latency -s  「useDictation のフックを」
[FINAL] audio 0.00–3.10s  at 0.52s  latency -s  「useDictationのフックを直して。」
...
=== file · transcriber · ja-JP ===
text: useDictationのフックを直して。…
audio 6.12s · wall 0.95s · real-time factor 0.155 · prepare (model load, not in wall) 0.31s · 2 final segment(s)
memory: speech-bench peak RSS 38.2 MB, footprint now 21.0 MB — the model runs in a system process, not here
speech-named processes now: <daemon name> (pid 1234) 412.0 MB
assets: already installed (nothing downloaded)
```

- `[vol]` lines are volatile results: the recogniser's current guess for the
  audio so far, replaced by later ones. `[FINAL]` lines are final for their
  audio range. The full text is the finals concatenated.
- `audio a–b` is the result's range in the audio (`audioTimeRange`); `at` is
  wall time since analysis started.
- By default the file goes through Apple's own path
  (`analyzeSequence(from: AVAudioFile)`), as fast as the machine can, so the
  real-time factor (wall / audio length; below 1 is faster than real time) is
  the throughput number. Latency is meaningless there and shows `-`.
- `--realtime` instead feeds the file in 100 ms pieces at the pace it would be
  spoken, exactly as `mic` feeds the microphone, so the latencies below can be
  measured reproducibly from a recording.
- The first run for a locale may download Apple's model for it. The tool says
  so (`assets for ja-JP are not installed ... Downloading`, then
  `assets: were NOT installed; downloaded ...`). That is the language model
  coming *down* from Apple; no audio goes up. The download happens before the
  timed part, and `prepare` (loading the model before audio arrives) is
  reported apart from `wall` too.

### The microphone

```sh
.build/release/speech-bench mic --locale ja_JP --seconds 15 --save clips/try1.wav
```

Without `--seconds`, it records until Ctrl-C. Results print as they arrive, and
at the end:

```
first volatile latency per segment: median 0.42s, p90 0.71s, max 0.80s (n=4)
final latency per segment:          median 1.35s, p90 2.10s, max 2.20s (n=4)
stop → last final:                  0.48s
```

- latency of a result = when it arrived − when the audio up to its end was
  handed to the analyzer. The microphone's buffers arrive about 100 ms at a
  time and are stamped when they reach the tool, so add up to a buffer's
  length for "since the word was spoken".
- *first volatile latency* is the latency of the first volatile result that
  belongs to a final segment: how soon words appear.
- *final latency* is the final result's latency: how soon they stop changing.
- *stop → last final* is the time from the end of the audio (Ctrl-C, or
  `--seconds` running out) to the last result: what dictation waits for on
  stop. DevHub's whisper-server path re-transcribes the whole recording on
  stop, so this is the number to put next to its stop-to-text time.
- `--save out.wav` writes what was recorded (16-bit PCM in the analyzer's
  sample rate) for reruns with `file` and `compare.py`.

### Options

| option | |
| --- | --- |
| `--locale ID` | default `ja_JP`; matched with `supportedLocale(equivalentTo:)` |
| `--engine transcriber\|dictation` | `SpeechTranscriber` (default: the new model) or `DictationTranscriber` (the older system-dictation model, Apple's fallback for devices or languages the new one does not cover) |
| `--fast` | `.fastResults` (transcriber) / `.frequentFinalization` (dictation): sooner, less accurate |
| `--no-volatile` | final results only |
| `--quiet` | do not print volatile results (still recorded in JSON) |
| `--json` | stdout is one JSON object (texts, segments, every event with its timings, assets, memory); everything else goes to stderr |

### Comparing with whisper.cpp

Build DevHub's whisper first (`scripts/build_whisper.py`, which leaves
`dist/whisper/devhub-whisper`, `devhub-whisper-server` and the large-v3-turbo
model, and caches models in `~/.cache/devhub/whisper/models`). Then:

```sh
tools/speech-bench/compare.py clips/                       # small + large-v3-turbo, whisper-server
tools/speech-bench/compare.py clips/ --model small --model large-v3-turbo --download
tools/speech-bench/compare.py clips/ --whisper-mode both   # also the CLI (model load per clip)
tools/speech-bench/compare.py clips/ --apple-arg=--engine --apple-arg=dictation
tools/speech-bench/compare.py clips/ --out results/run1.json
```

- Clips are any audio files in the folder; `clip.txt` beside `clip.m4a` is its
  reference transcript. Every clip is converted to 16 kHz mono WAV with
  `afconvert` first, and both engines get that same file.
- `--model` takes `small` (ggml-small-q5_1.bin), `large-v3-turbo`
  (ggml-large-v3-turbo-q5_0.bin, what DevHub ships), other aliases listed in
  `--help`, a ggml file name or a path. It looks in `dist/whisper`, the DevHub
  whisper cache and `--models-dir`; `--download` fetches what is missing from
  huggingface.co into the cache.
- `--whisper-bin` / `--whisper-server-bin` point at other binaries (Homebrew's
  `whisper-cli` and `whisper-server` are found on PATH as a last resort).
- whisper-server mode is how DevHub dictates: model loaded once (load time
  printed separately), one warm-up request not counted, then one `/inference`
  per clip with the same fields DevHub sends. CLI mode is DevHub's fallback,
  with the model load in every clip's time.
- CER = edit distance / reference length, in characters, after NFKC, lower
  case, and removing punctuation and spaces from both sides. 「直して。」 for
  「直して」 is no error; 「治して」 is one; 「ユーズディクテーション」 for
  「useDictation」 is many. The totals line is total edits over total reference
  characters, so long clips weigh more.

Example table:

```
engine                       clip          audio s  wall s  RTF    CER    text
apple SpeechTranscriber      cmd-01.wav    2.4      0.41    0.171  0.0%   useDictationのフックを直して。
whisper server small-q5_1    cmd-01.wav    2.4      0.38    0.158  15.0%  ユーズディクテーションのフックを直して
...
totals per engine (CER over all clips with a reference: total edits / total reference characters)
apple SpeechTranscriber            clips 12  audio 140.2s  wall 19.80s  RTF 0.141  CER 6.3% (88/1402)  prepare (not in wall) median 0.30s
whisper server large-v3-turbo-q5_0 clips 12  audio 140.2s  wall 15.10s  RTF 0.108  CER 4.9% (69/1402)  model load 0.85s (not in wall)
```

(The numbers are made up, to show the layout.)

### Recording a test set

```sh
tools/speech-bench/compare.py clips/ --record 6 --name cmd-01 --say "useDictationのフックを直して"
tools/speech-bench/compare.py clips/ --record 60 --name free-01   # asks for the reference afterwards
```

`--record` runs `speech-bench mic --save`, shows the sentence to read, and
writes the sentence (or what you type afterwards) as the reference.

## Suggested test set

Record each with the built-in microphone, in a quiet room and once more with
some background noise (a fan, a café recording). 10 to 20 clips are enough to
see a difference; read the references exactly as written.

Short commands (2–5 s), the composer's everyday input:

- 「このテストを直して」
- 「さっきの変更を元に戻して」
- 「エラーの原因を調べて」
- 「プルリクエストを作って」

Code identifiers mixed into Japanese, where Japanese models usually fail
(katakana for English, split camelCase):

- 「useDictationのフックを直して」
- 「apps/desktop の whisperServer.ts を読んで」
- 「pnpm run lint が落ちてるので見て」
- 「README の Getting Started に macOS 26 の要件を追記して」
- 「SpeechAnalyzer と whisper.cpp を比較するスクリプトを書いて」
- 「getUserMediaのエラーをtry catchで拾って」

Long free speech (30–90 s): explain a bug or a plan the way you would to a
colleague, with fillers and restarts. This exercises segmenting, punctuation
and long-form stability. Write the reference afterwards from the recording.

English-only sentences, one or two, to see that a `ja_JP` session copes with
them (DevHub's composer gets both).

What to compare: CER (overall and on the identifier clips), RTF for
`file`, and for `mic` / `--realtime`: first volatile latency, final latency
and stop → last final, against DevHub's current whisper-server path.

## Permissions

- **Microphone.** macOS asks the *terminal app* (Terminal, iTerm, VS Code's
  terminal), not speech-bench: TCC attributes a command-line tool to the app
  that started it. The first `mic` run triggers the prompt for it; if it was
  denied, allow it in System Settings → Privacy & Security → Microphone and
  restart the terminal. Without access, AVAudioEngine delivers silence or no
  format, and the tool says so.
- **Speech recognition.** Apple's documentation says the speech-recognition
  authorization (`SFSpeechRecognizer.requestAuthorization`, with
  `NSSpeechRecognitionUsageDescription`) is for `SFSpeechRecognizer`, because
  that API may send audio to Apple's servers, and that `SpeechAnalyzer`'s
  transcriber modules do not send audio to Apple's servers
  ([Asking permission to use speech recognition][permission], note at the top).
  speech-bench therefore does not request it. The embedded `Info.plist`
  carries `NSSpeechRecognitionUsageDescription` and
  `NSMicrophoneUsageDescription` anyway, so that if some macOS version does
  check for them, the tool shows a prompt instead of being killed for a
  missing usage string. If you ever see a crash mentioning a privacy usage
  description, check the section is in the binary (`otool` above).
- **Asset reservation.** An app may keep only `AssetInventory.maximumReservedLocales`
  locales reserved; speech-bench reserves the one it uses and prints a warning
  (and continues) if it cannot. `speech-bench locales` lists the reservations.

## Privacy: what is known, and what is not

Known, from Apple:

- `SpeechAnalyzer` / `SpeechTranscriber` run on the device. "SpeechAnalyzer
  transcriber modules don't send audio data of the user's voice to Apple's
  servers." ([Asking permission to use speech recognition][permission])
- The models are system assets managed by `AssetInventory`: downloaded once per
  locale, stored outside the app's memory and storage, and updated by the
  system ([WWDC25 session 277][wwdc]). So the first use of a locale on a Mac
  needs the network, to download the model, and later uses do not. This is
  different from DevHub's whisper.cpp, whose model is in the app bundle and
  which never touches the network (`scripts/build_whisper.py`). Adopting Apple's
  recogniser means a model download from Apple on first use, done by the
  system.
- "Improve Siri & Dictation" (System Settings → Privacy & Security → Analytics
  & Improvements) is an opt-in that lets Apple store and have employees review
  a sample of Siri and **Dictation** audio
  ([Improve Siri and Dictation & Privacy][improve]; [Siri, Dictation &
  Privacy][siri] says that, without it, dictation audio is not stored).

Not known (Apple does not say, as far as this was researched):

- Whether "Improve Siri & Dictation" covers third-party apps' use of the Speech
  framework at all. The Apple pages describe Siri and system Dictation; given
  the statement that SpeechAnalyzer audio is not sent to Apple, there would be
  nothing to sample, but no page says so in terms.
- Whether usage metadata (that a locale was used, model versions, errors) is
  reported through "Share Mac Analytics".
- The name of the system process that runs the model (speech-bench lists
  processes with "speech" in their name, as a hint for the memory reading).

What you can check yourself:

1. Run once with the network on, so the ja-JP model installs
   (`speech-bench locales` then shows it under *installed*).
2. Turn Wi-Fi off (and unplug Ethernet) and run `file` and `mic` again. If
   they work, transcription is on-device for that run.
3. For the network-on case, watch with `nettop -p <pid>` or a firewall such as
   Little Snitch / LuLu while speech-bench runs; look for connections from it
   and from the speech service.
4. Turn off "Improve Siri & Dictation" and "Share Mac Analytics" for the
   test, if you want to be sure nothing optional is shared.

[permission]: https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition
[wwdc]: https://developer.apple.com/videos/play/wwdc2025/277/
[improve]: https://www.apple.com/legal/privacy/data/en/improve-siri-dictation/
[siri]: https://www.apple.com/legal/privacy/data/en/ask-siri-dictation/

## Memory

`peak RSS` is speech-bench's own (`getrusage`), and it is small: the model runs
in a system process, outside the app's memory (WWDC25 session 277). For the
real cost, look at the "speech-named processes" line, or watch Activity Monitor
while a long file runs. compare.py's peak RSS line covers its child processes,
i.e. the largest whisper.cpp run.

## What the code relies on (API notes)

Written against the macOS 26.0 SDK as documented (developer.apple.com/documentation/speech)
and the WWDC25 session's code; it was written on Linux and has not been
compiled here, so expect to fix the odd signature on first build.

- `SpeechTranscriber(locale:transcriptionOptions:reportingOptions:attributeOptions:)`
  with `.volatileResults` and `.audioTimeRange`. The session's presets
  (`.offlineTranscription`, `.progressiveLiveTranscription`) were renamed in
  the release SDK (`.transcription`, `.progressiveTranscription`, …), so the
  explicit initialiser is used.
- `SpeechTranscriber.isAvailable`, `supportedLocale(equivalentTo:)`,
  `supportedLocales` / `installedLocales` (async).
- `AssetInventory.status(forModules:)`, `assetInstallationRequest(supporting:)`
  → `downloadAndInstall()`, `reserve(locale:)`, `reservedLocales`.
- `SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:)`,
  `prepareToAnalyze(in:)`, `analyzeSequence(from: AVAudioFile)` +
  `finalizeAndFinish(through:)` for files, `start(inputSequence:)` +
  `finalizeAndFinishThroughEndOfInput()` for streamed input,
  `AnalyzerInput(buffer:)`.
- Results: `isFinal`, `range` (`CMTimeRange`), `text` (`AttributedString`).
- Microphone: `AVAudioEngine` input tap → one `AVAudioConverter` kept for the
  whole stream (so resampling state carries over) → the analyzer's format.
  macOS 27 adds `CaptureInputSequenceProvider` and `AnalyzerInputConverter`,
  which would replace this; they are not used, so the tool runs on macOS 26.
