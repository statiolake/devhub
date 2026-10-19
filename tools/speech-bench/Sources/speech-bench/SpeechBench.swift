// speech-bench: Apple SpeechAnalyzer (macOS 26, on-device) for Japanese
// dictation, measured so it can be compared with whisper.cpp.
//
//   speech-bench file <audio> [--locale ja_JP] [--realtime] [options]
//   speech-bench mic [--locale ja_JP] [--seconds N] [--save out.wav] [options]
//   speech-bench locales [--engine transcriber|dictation]
//
// See README.md.

@preconcurrency import AVFoundation
import Darwin
import Foundation
@preconcurrency import Speech

let usage = """
  usage:
    speech-bench file <wav|m4a|...> [--locale ja_JP] [--realtime] [options]
    speech-bench mic [--locale ja_JP] [--seconds N] [--save out.wav] [options]
    speech-bench locales [--engine transcriber|dictation]

  options:
    --locale ID        locale to transcribe (default ja_JP)
    --engine NAME      transcriber (SpeechTranscriber, default) or dictation
                       (DictationTranscriber, the older system-dictation model)
    --realtime         file: feed the file at real-time pace, as a microphone
                       would, so latencies mean what they mean for mic
    --seconds N        mic: stop after N seconds (default: on Ctrl-C)
    --save PATH        mic: also write what was recorded to PATH (.wav)
    --fast             ask for faster, less accurate results (.fastResults /
                       .frequentFinalization)
    --no-volatile      final results only
    --quiet            do not print volatile results as they come
    --json             print a JSON summary on stdout (everything else on stderr)

  """

struct Options {
  enum Command { case file(String), mic, locales }
  var command: Command
  var locale = "ja_JP"
  var engine = Engine.transcriber
  var realtime = false
  var seconds: Double?
  var save: String?
  var fast = false
  var volatile = true
  var quiet = false
  var json = false

  static func parse(_ arguments: [String]) throws -> Options {
    var rest = arguments[...]
    guard let verb = rest.popFirst() else { throw BenchError.message(usage) }
    var options: Options
    switch verb {
    case "file":
      guard let path = rest.popFirst(), !path.hasPrefix("--") else {
        throw BenchError.message("file: which file?\n\n" + usage)
      }
      options = Options(command: .file(path))
    case "mic": options = Options(command: .mic)
    case "locales": options = Options(command: .locales)
    case "-h", "--help", "help": throw BenchError.message(usage)
    default: throw BenchError.message("unknown command \(verb)\n\n" + usage)
    }
    func value(_ flag: String) throws -> String {
      guard let next = rest.popFirst() else { throw BenchError.message("\(flag) needs a value") }
      return next
    }
    while let flag = rest.popFirst() {
      switch flag {
      case "--locale": options.locale = try value(flag)
      case "--engine":
        let name = try value(flag)
        guard let engine = Engine(rawValue: name) else {
          throw BenchError.message("--engine is transcriber or dictation, not \(name)")
        }
        options.engine = engine
      case "--realtime": options.realtime = true
      case "--seconds":
        let text = try value(flag)
        guard let seconds = Double(text), seconds > 0 else {
          throw BenchError.message("--seconds needs a positive number, not \(text)")
        }
        options.seconds = seconds
      case "--save": options.save = try value(flag)
      case "--fast": options.fast = true
      case "--no-volatile": options.volatile = false
      case "--quiet": options.quiet = true
      case "--json": options.json = true
      default: throw BenchError.message("unknown option \(flag)\n\n" + usage)
      }
    }
    return options
  }
}

struct Latency: Codable {
  let firstVolatile: Stats
  let finalResult: Stats
  /// From the last audio handed to the analyzer (end of speech, Ctrl-C) to
  /// the end of the results: how long dictation waits for its final text.
  let stopToFinal: Double?
}

struct Summary: Codable {
  let mode: String
  let engine: String
  let locale: String
  let input: String?
  let saved: String?
  let analyzerFormat: String
  let assets: AssetReport
  /// prepareToAnalyze: loading the model before audio arrives. Not counted
  /// in wallSeconds.
  let prepareSeconds: Double
  let audioSeconds: Double
  /// From the start of analysis to the last result.
  let wallSeconds: Double
  /// wallSeconds / audioSeconds. Meaningful for `file` without --realtime;
  /// at real-time pace it is ~1 by construction.
  let realTimeFactor: Double?
  let latency: Latency?
  let peakResidentBytes: UInt64
  let physicalFootprintBytes: UInt64?
  /// Processes named like the system's speech service, after the run. The
  /// model lives there, not in speech-bench. Heuristic.
  let speechProcesses: [ProcessMemory]
  let text: String
  let segments: [SegmentRecord]
  let events: [EventRecord]
}

struct Prepared {
  let module: Module
  let locale: Locale
  let format: AVAudioFormat
  let analyzer: SpeechAnalyzer
  let assets: AssetReport
  let prepareSeconds: Double
}

func prepare(_ options: Options, out: Printer) async throws -> Prepared {
  if options.engine == .transcriber && !SpeechTranscriber.isAvailable {
    throw BenchError.message(
      "SpeechTranscriber is not available on this Mac (SpeechTranscriber.isAvailable is false). "
        + "Try --engine dictation.")
  }
  let requested = Locale(identifier: options.locale)
  guard let locale = await supportedLocale(engine: options.engine, requested: requested) else {
    let supported = bcp47(await supportedLocales(engine: options.engine))
    throw BenchError.message(
      "\(options.engine.rawValue) does not support \(options.locale). Supported: "
        + supported.joined(separator: " "))
  }
  let module = makeModule(
    engine: options.engine, locale: locale, volatile: options.volatile, fast: options.fast)
  let assets = try await ensureAssets(
    engine: options.engine, module: module.speechModule, locale: locale, out: out)
  out.status(
    "engine \(options.engine.rawValue), locale \(locale.identifier(.bcp47)), assets "
      + (assets.alreadyInstalled ? "already installed" : (assets.downloaded ? "downloaded now" : assets.statusAfter)))
  // Asked after the assets are in: the format comes from the installed model.
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module.speechModule])
  else {
    throw BenchError.message("SpeechAnalyzer offers no audio format for this module and locale")
  }
  let analyzer = SpeechAnalyzer(modules: [module.speechModule])
  let started = now()
  try await analyzer.prepareToAnalyze(in: format)
  let prepareSeconds = now() - started
  out.status("analyzer format: \(describe(format)); prepared in \(fmt(prepareSeconds))s")
  return Prepared(
    module: module, locale: locale, format: format, analyzer: analyzer, assets: assets,
    prepareSeconds: prepareSeconds)
}

// MARK: - file

func runFile(_ path: String, _ options: Options, out: Printer) async throws -> Summary {
  let url = URL(fileURLWithPath: path)
  let file = try AVAudioFile(forReading: url)
  let audioSeconds = Double(file.length) / file.processingFormat.sampleRate
  out.status("input \(path): \(fmt(audioSeconds))s, \(describe(file.processingFormat))")
  let p = try await prepare(options, out: out)

  let feed = options.realtime ? FeedLog(sampleRate: p.format.sampleRate) : nil
  let items = p.module.items()
  let collector = Collector(started: now(), feed: feed, out: out, printVolatile: !options.quiet)
  let results = Task {
    for try await item in items { collector.handle(item) }
  }

  var inputEnded: Double?
  if options.realtime {
    // Our own feed: 100 ms chunks, converted, paced to the clock.
    let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
    try await p.analyzer.start(inputSequence: stream)
    let converter = try StreamConverter(from: file.processingFormat, to: p.format)
    let chunk = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
    let started = collector.started
    var fedSeconds = 0.0
    while file.framePosition < file.length {
      guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk)
      else { break }
      try file.read(into: buffer, frameCount: chunk)
      if buffer.frameLength == 0 { break }
      fedSeconds += Double(buffer.frameLength) / file.processingFormat.sampleRate
      // The chunk is "spoken" when its last sample would have been captured.
      let due = started + fedSeconds
      let wait = due - now()
      if wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
      if let converted = converter.convert(buffer) {
        feed?.record(frames: converted.frameLength, at: now())
        continuation.yield(AnalyzerInput(buffer: converted))
      }
    }
    if let tail = converter.flush() {
      feed?.record(frames: tail.frameLength, at: now())
      continuation.yield(AnalyzerInput(buffer: tail))
    }
    continuation.finish()
    inputEnded = now()
    try await p.analyzer.finalizeAndFinishThroughEndOfInput()
  } else {
    // Apple's own file path: reads and converts the file itself, flat out.
    if let last = try await p.analyzer.analyzeSequence(from: file) {
      inputEnded = now()
      try await p.analyzer.finalizeAndFinish(through: last)
    } else {
      await p.analyzer.cancelAndFinishNow()
    }
  }
  try await results.value
  let ended = collector.lastArrival ?? now()
  return summarize(
    mode: options.realtime ? "file-realtime" : "file", input: path, saved: nil, options: options,
    prepared: p, collector: collector, audioSeconds: audioSeconds,
    wall: ended - collector.started,
    stopToFinal: options.realtime ? inputEnded.map { ended - $0 } : nil)
}

// MARK: - mic

/// Fires once, from whichever comes first: Ctrl-C or --seconds.
final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var fired = false
  private var waiter: CheckedContinuation<Void, Never>?

  func wait() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      if fired {
        lock.unlock()
        continuation.resume()
      } else {
        waiter = continuation
        lock.unlock()
      }
    }
  }

  func fire() {
    lock.lock()
    if fired {
      lock.unlock()
      return
    }
    fired = true
    let waiter = self.waiter
    self.waiter = nil
    lock.unlock()
    waiter?.resume()
  }
}

func ensureMicrophoneAccess() async throws {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized:
    return
  case .notDetermined:
    if await AVCaptureDevice.requestAccess(for: .audio) { return }
  default:
    break
  }
  throw BenchError.message(
    "no microphone access. Allow your terminal app in System Settings → Privacy & Security → "
      + "Microphone, then restart the terminal.")
}

func runMic(_ options: Options, out: Printer) async throws -> Summary {
  try await ensureMicrophoneAccess()
  let p = try await prepare(options, out: out)

  let engine = AVAudioEngine()
  let input = engine.inputNode
  let inputFormat = input.outputFormat(forBus: 0)
  guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
    throw BenchError.message("the input device reports no audio format (no microphone, or no access)")
  }
  out.status("microphone: \(describe(inputFormat))")
  let converter = try StreamConverter(from: inputFormat, to: p.format)
  let feed = FeedLog(sampleRate: p.format.sampleRate)
  let writer = try options.save.map { try WavWriter(path: $0, format: p.format) }

  let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
  let items = p.module.items()
  let collector = Collector(started: now(), feed: feed, out: out, printVolatile: !options.quiet)
  let results = Task {
    for try await item in items { collector.handle(item) }
  }
  try await p.analyzer.start(inputSequence: stream)

  // The tap's buffer size is a request; macOS often delivers ~100 ms anyway.
  // The time stamp is when the buffer reached us, i.e. a buffer's length
  // after its first sample was spoken — latencies are measured from there.
  input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { buffer, _ in
    let arrived = now()
    guard let converted = converter.convert(buffer) else { return }
    writer?.write(converted)
    feed.record(frames: converted.frameLength, at: arrived)
    continuation.yield(AnalyzerInput(buffer: converted))
  }
  engine.prepare()
  try engine.start()

  let stop = Once()
  signal(SIGINT, SIG_IGN)
  let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
  interrupt.setEventHandler { stop.fire() }
  interrupt.resume()
  if let seconds = options.seconds {
    Task {
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      stop.fire()
    }
    out.status("listening for \(fmt(seconds, 0)) s (Ctrl-C stops early). Speak now.")
  } else {
    out.status("listening. Speak, then press Ctrl-C to stop.")
  }
  await stop.wait()
  interrupt.cancel()
  signal(SIGINT, SIG_DFL)

  input.removeTap(onBus: 0)
  engine.stop()
  if let tail = converter.flush() {
    writer?.write(tail)
    feed.record(frames: tail.frameLength, at: now())
    continuation.yield(AnalyzerInput(buffer: tail))
  }
  continuation.finish()
  let stopped = now()
  try await p.analyzer.finalizeAndFinishThroughEndOfInput()
  try await results.value
  writer?.close()
  if let path = writer?.path { out.status("saved the recording to \(path)") }
  let ended = collector.lastArrival ?? now()
  return summarize(
    mode: "mic", input: nil, saved: writer?.path, options: options, prepared: p,
    collector: collector, audioSeconds: feed.audioSeconds, wall: ended - collector.started,
    stopToFinal: max(0, ended - stopped))
}

// MARK: - summary

func summarize(
  mode: String, input: String?, saved: String?, options: Options, prepared p: Prepared,
  collector: Collector, audioSeconds: Double, wall: Double, stopToFinal: Double?
) -> Summary {
  let realtime = collector.feed != nil
  let latency =
    realtime
    ? Latency(
      firstVolatile: Stats(collector.segments.compactMap(\.firstVolatileLatency)),
      finalResult: Stats(collector.segments.compactMap(\.finalLatency)),
      stopToFinal: stopToFinal)
    : nil
  return Summary(
    mode: mode, engine: options.engine.rawValue, locale: p.locale.identifier(.bcp47), input: input,
    saved: saved, analyzerFormat: describe(p.format), assets: p.assets,
    prepareSeconds: p.prepareSeconds, audioSeconds: audioSeconds, wallSeconds: wall,
    realTimeFactor: audioSeconds > 0 ? wall / audioSeconds : nil, latency: latency,
    peakResidentBytes: peakResidentBytes(), physicalFootprintBytes: physicalFootprintBytes(),
    speechProcesses: speechProcesses(), text: collector.finalText, segments: collector.segments,
    events: collector.events)
}

func megabytes(_ bytes: UInt64?) -> String {
  guard let bytes else { return "-" }
  return String(format: "%.1f MB", Double(bytes) / 1_048_576)
}

func report(_ s: Summary, out: Printer) {
  out.line("")
  out.line("=== \(s.mode) · \(s.engine) · \(s.locale) ===")
  out.line("text: \(s.text)")
  out.line(
    "audio \(fmt(s.audioSeconds))s · wall \(fmt(s.wallSeconds))s · real-time factor \(fmt(s.realTimeFactor, 3))"
      + " · prepare (model load, not in wall) \(fmt(s.prepareSeconds))s · \(s.segments.count) final segment(s)")
  if let latency = s.latency {
    out.line("first volatile latency per segment: \(latency.firstVolatile.text)")
    out.line("final latency per segment:          \(latency.finalResult.text)")
    out.line("stop → last final:                  \(fmt(latency.stopToFinal))s")
  }
  out.line(
    "memory: speech-bench peak RSS \(megabytes(s.peakResidentBytes)), footprint now "
      + "\(megabytes(s.physicalFootprintBytes)) — the model runs in a system process, not here")
  if !s.speechProcesses.isEmpty {
    let list = s.speechProcesses.prefix(5).map { "\($0.name) (pid \($0.pid)) \(megabytes($0.residentBytes))" }
    out.line("speech-named processes now: " + list.joined(separator: ", "))
  }
  let a = s.assets
  if a.downloaded {
    out.line(
      "assets: were NOT installed; downloaded Apple's \(s.locale) model in \(fmt(a.downloadSeconds, 1))s "
        + "(only the model came down; the audio stayed on this Mac)")
  } else {
    out.line("assets: \(a.alreadyInstalled ? "already installed" : "status \(a.statusAfter)") (nothing downloaded)")
  }
  if let saved = s.saved { out.line("recording saved: \(saved)") }
}

func list(_ options: Options, out: Printer) async {
  out.line("SpeechTranscriber.isAvailable: \(SpeechTranscriber.isAvailable)")
  out.line("engine: \(options.engine.rawValue)")
  out.line("supported: " + bcp47(await supportedLocales(engine: options.engine)).joined(separator: " "))
  out.line("installed: " + bcp47(await installedLocales(engine: options.engine)).joined(separator: " "))
  out.line(
    "reserved by this tool: " + bcp47(await AssetInventory.reservedLocales).joined(separator: " ")
      + " (maximum \(AssetInventory.maximumReservedLocales))")
  let requested = Locale(identifier: options.locale)
  let match = await supportedLocale(engine: options.engine, requested: requested)
  out.line("\(options.locale) → \(match.map { $0.identifier(.bcp47) } ?? "not supported")")
}

@main
struct SpeechBench {
  static func main() async {
    let options: Options
    do {
      options = try Options.parse(Array(CommandLine.arguments.dropFirst()))
    } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      exit(2)
    }
    let out = Printer(json: options.json)
    do {
      let summary: Summary
      switch options.command {
      case .locales:
        await list(options, out: out)
        return
      case .file(let path):
        summary = try await runFile(path, options, out: out)
      case .mic:
        summary = try await runMic(options, out: out)
      }
      report(summary, out: out)
      if options.json {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(summary)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
      }
    } catch {
      FileHandle.standardError.write(Data("speech-bench: \(error)\n".utf8))
      exit(1)
    }
  }
}
