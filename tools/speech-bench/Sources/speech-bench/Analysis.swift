// The SpeechAnalyzer side: choosing the module, making sure its on-device
// assets are installed, and collecting results with their timings.
//
// API as documented for macOS 26.0 (developer.apple.com/documentation/speech
// and WWDC25 session 277). Nothing here is macOS 27-only: the input
// providers and AnalyzerInputConverter that macOS 27 adds are not used.

@preconcurrency import AVFoundation
import CoreMedia
import Foundation
@preconcurrency import Speech

enum BenchError: Error, CustomStringConvertible {
  case message(String)
  var description: String {
    switch self {
    case .message(let text): return text
    }
  }
}

enum Engine: String, Codable {
  /// SpeechTranscriber: the new model, "normal conversation and general
  /// purposes". What this benchmark is about.
  case transcriber
  /// DictationTranscriber: the older system-dictation model, "compatible with
  /// older devices". Apple's fallback; measured for reference.
  case dictation
}

/// One result, flattened from either module's Result type.
struct Item: Sendable {
  let text: String
  let start: Double?
  let end: Double?
  let isFinal: Bool
  /// now() when the result reached us.
  let arrival: Double
}

func seconds(_ time: CMTime) -> Double? {
  guard time.isValid, time.isNumeric else { return nil }
  let value = time.seconds
  return value.isFinite ? value : nil
}

enum Module {
  case transcriber(SpeechTranscriber)
  case dictation(DictationTranscriber)

  var speechModule: any SpeechModule {
    switch self {
    case .transcriber(let module): return module
    case .dictation(let module): return module
    }
  }

  /// The module's results, flattened. Taken before analysis starts.
  func items() -> AsyncThrowingStream<Item, Error> {
    switch self {
    case .transcriber(let module):
      let results = module.results
      return AsyncThrowingStream { continuation in
        let task = Task {
          do {
            for try await result in results {
              continuation.yield(
                Item(
                  text: String(result.text.characters),
                  start: seconds(result.range.start), end: seconds(result.range.end),
                  isFinal: result.isFinal, arrival: now()))
            }
            continuation.finish()
          } catch {
            continuation.finish(throwing: error)
          }
        }
        continuation.onTermination = { _ in task.cancel() }
      }
    case .dictation(let module):
      let results = module.results
      return AsyncThrowingStream { continuation in
        let task = Task {
          do {
            for try await result in results {
              continuation.yield(
                Item(
                  text: String(result.text.characters),
                  start: seconds(result.range.start), end: seconds(result.range.end),
                  isFinal: result.isFinal, arrival: now()))
            }
            continuation.finish()
          } catch {
            continuation.finish(throwing: error)
          }
        }
        continuation.onTermination = { _ in task.cancel() }
      }
    }
  }
}

func makeModule(engine: Engine, locale: Locale, volatile: Bool, fast: Bool) -> Module {
  switch engine {
  case .transcriber:
    var reporting: Set<SpeechTranscriber.ReportingOption> = []
    if volatile { reporting.insert(.volatileResults) }
    if fast { reporting.insert(.fastResults) }
    return .transcriber(
      SpeechTranscriber(
        locale: locale, transcriptionOptions: [], reportingOptions: reporting,
        attributeOptions: [.audioTimeRange]))
  case .dictation:
    var reporting: Set<DictationTranscriber.ReportingOption> = []
    if volatile { reporting.insert(.volatileResults) }
    if fast { reporting.insert(.frequentFinalization) }
    return .dictation(
      DictationTranscriber(
        locale: locale, contentHints: [], transcriptionOptions: [.punctuation],
        reportingOptions: reporting, attributeOptions: [.audioTimeRange]))
  }
}

func supportedLocale(engine: Engine, requested: Locale) async -> Locale? {
  switch engine {
  case .transcriber: return await SpeechTranscriber.supportedLocale(equivalentTo: requested)
  case .dictation: return await DictationTranscriber.supportedLocale(equivalentTo: requested)
  }
}

func supportedLocales(engine: Engine) async -> [Locale] {
  switch engine {
  case .transcriber: return await SpeechTranscriber.supportedLocales
  case .dictation: return await DictationTranscriber.supportedLocales
  }
}

func installedLocales(engine: Engine) async -> [Locale] {
  switch engine {
  case .transcriber: return await SpeechTranscriber.installedLocales
  case .dictation: return await DictationTranscriber.installedLocales
  }
}

func bcp47(_ locales: [Locale]) -> [String] {
  locales.map { $0.identifier(.bcp47) }.sorted()
}

// MARK: - Assets

struct AssetReport: Codable {
  var statusBefore: String
  var statusAfter: String
  /// The locale was in installedLocales before this run.
  var alreadyInstalled: Bool
  /// This run downloaded model assets (never audio: audio is not uploaded).
  var downloaded: Bool
  var downloadSeconds: Double?
  var reservedLocales: [String]
}

/// Makes sure the module's on-device model is installed, downloading it if
/// not. What is downloaded is Apple's language model for the locale; the
/// audio being transcribed is never sent anywhere (see README.md, Privacy).
func ensureAssets(
  engine: Engine, module: any SpeechModule, locale: Locale, out: Printer
) async throws -> AssetReport {
  let id = locale.identifier(.bcp47)
  let alreadyInstalled = bcp47(await installedLocales(engine: engine)).contains(id)

  // An app may keep a limited number of locales (maximumReservedLocales).
  // Asset installation reserves one implicitly; doing it here makes a full
  // reservation list an explicit, explained error instead of a vague one.
  let reserved = bcp47(await AssetInventory.reservedLocales)
  if !reserved.contains(id) {
    do {
      _ = try await AssetInventory.reserve(locale: locale)
    } catch {
      out.status(
        "warning: could not reserve \(id) (\(error)); reserved: \(reserved), "
          + "maximum \(AssetInventory.maximumReservedLocales). Continuing.")
    }
  }

  let before = await AssetInventory.status(forModules: [module])
  var downloaded = false
  var downloadSeconds: Double?
  switch before {
  case .unsupported:
    throw BenchError.message(
      "AssetInventory says \(engine.rawValue) cannot work with locale \(id) on this Mac (status: unsupported)")
  case .installed:
    break
  default:
    out.status(
      "assets for \(id) are not installed (status: \(before)). Downloading Apple's on-device "
        + "speech model for this locale. Only the model is downloaded; no audio is uploaded.")
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
      let started = now()
      let progress = request.progress
      let poll = Task {
        while !Task.isCancelled {
          out.status(String(format: "  downloading model assets: %3.0f%%", progress.fractionCompleted * 100))
          try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
      }
      defer { poll.cancel() }
      try await request.downloadAndInstall()
      downloaded = true
      downloadSeconds = now() - started
      out.status(String(format: "  model assets installed in %.1f s", downloadSeconds ?? 0))
    }
  }
  let after = await AssetInventory.status(forModules: [module])
  return AssetReport(
    statusBefore: "\(before)", statusAfter: "\(after)", alreadyInstalled: alreadyInstalled,
    downloaded: downloaded, downloadSeconds: downloadSeconds,
    reservedLocales: bcp47(await AssetInventory.reservedLocales))
}

// MARK: - Results

struct EventRecord: Codable {
  let kind: String  // "volatile" | "final"
  let text: String
  let audioStart: Double?
  let audioEnd: Double?
  /// Seconds since analysis started.
  let at: Double
  /// Seconds from when the audio up to audioEnd was handed to the analyzer
  /// until this result arrived. Only when audio is fed at real time (mic,
  /// file --realtime); a file analysed flat out has no meaningful one.
  let latency: Double?
}

struct SegmentRecord: Codable {
  let text: String
  let audioStart: Double?
  let audioEnd: Double?
  let finalAt: Double
  let finalLatency: Double?
  let volatileCount: Int
  let firstVolatileAt: Double?
  let firstVolatileLatency: Double?
}

/// Consumes results on one task; read only after that task has finished.
final class Collector: @unchecked Sendable {
  let started: Double
  let feed: FeedLog?
  let out: Printer
  let printVolatile: Bool
  private(set) var events: [EventRecord] = []
  private(set) var segments: [SegmentRecord] = []
  private(set) var finalText = ""
  private(set) var lastArrival: Double?
  private var pending: [(item: Item, latency: Double?)] = []

  init(started: Double, feed: FeedLog?, out: Printer, printVolatile: Bool) {
    self.started = started
    self.feed = feed
    self.out = out
    self.printVolatile = printVolatile
  }

  func latency(_ item: Item) -> Double? {
    guard let feed, let end = item.end, let fed = feed.wallTime(forAudio: end) else { return nil }
    return item.arrival - fed
  }

  func handle(_ item: Item) {
    lastArrival = item.arrival
    let lat = latency(item)
    let at = item.arrival - started
    events.append(
      EventRecord(
        kind: item.isFinal ? "final" : "volatile", text: item.text, audioStart: item.start,
        audioEnd: item.end, at: at, latency: lat))
    let line =
      "audio \(fmt(item.start))–\(fmt(item.end))s  at \(fmt(at))s  latency \(fmt(lat))s  「\(oneLine(item.text))」"
    if item.isFinal {
      // Volatile results that cover any of this final's audio belong to it.
      let end = item.end ?? .infinity
      let mine = pending.filter { ($0.item.start ?? 0) < end }
      pending.removeAll { ($0.item.start ?? 0) < end }
      let first = mine.first
      segments.append(
        SegmentRecord(
          text: item.text, audioStart: item.start, audioEnd: item.end, finalAt: at,
          finalLatency: lat, volatileCount: mine.count,
          firstVolatileAt: first.map { $0.item.arrival - started },
          firstVolatileLatency: first?.latency))
      finalText += item.text
      out.line("[FINAL] " + line)
    } else {
      pending.append((item, lat))
      if printVolatile { out.line("[vol]   " + line) }
    }
  }
}

func fmt(_ value: Double?, _ digits: Int = 2) -> String {
  guard let value, value.isFinite else { return "-" }
  return String(format: "%.\(digits)f", value)
}

func oneLine(_ text: String) -> String {
  text.replacingOccurrences(of: "\n", with: "⏎")
}

struct Stats: Codable {
  let count: Int
  let median: Double?
  let p90: Double?
  let max: Double?

  init(_ values: [Double]) {
    let sorted = values.filter { $0.isFinite }.sorted()
    count = sorted.count
    func at(_ q: Double) -> Double? {
      sorted.isEmpty ? nil : sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * q).rounded()))]
    }
    median = at(0.5)
    p90 = at(0.9)
    max = sorted.last
  }

  var text: String { "median \(fmt(median))s, p90 \(fmt(p90))s, max \(fmt(max))s (n=\(count))" }
}

// MARK: - Output

/// Human-readable lines go to stdout, or to stderr under --json so that
/// stdout holds only the JSON summary.
struct Printer: Sendable {
  let json: Bool

  func line(_ text: String) {
    let data = Data((text + "\n").utf8)
    if json {
      FileHandle.standardError.write(data)
    } else {
      FileHandle.standardOutput.write(data)
    }
  }

  /// Progress and notices: always stderr.
  func status(_ text: String) {
    FileHandle.standardError.write(Data((text + "\n").utf8))
  }
}
