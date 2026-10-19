// Audio plumbing: format conversion, the record of when each piece of audio
// was handed to the analyzer (for latency), WAV saving, and memory readings.

@preconcurrency import AVFoundation
import Darwin
import Foundation

/// Monotonic wall clock in seconds (unaffected by clock changes).
@inline(__always)
func now() -> Double {
  Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
}

/// Converts a stream of buffers to the analyzer's format with one
/// AVAudioConverter, so the resampler keeps its state between buffers.
/// (AnalyzerInputConverter does this for you, but only from macOS 27.)
final class StreamConverter: @unchecked Sendable {
  let from: AVAudioFormat
  let to: AVAudioFormat
  private let converter: AVAudioConverter?
  private let lock = NSLock()

  init(from: AVAudioFormat, to: AVAudioFormat) throws {
    self.from = from
    self.to = to
    if from == to {
      converter = nil
    } else {
      guard let converter = AVAudioConverter(from: from, to: to) else {
        throw BenchError.message("cannot convert \(describe(from)) to \(describe(to))")
      }
      // A stereo interface feeding a mono model: mix, do not drop a channel.
      converter.downmix = true
      self.converter = converter
    }
  }

  /// The buffer in the target format, or nil when the converter has nothing
  /// to give yet (or failed; failures are rare and only lose that buffer).
  func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    lock.lock()
    defer { lock.unlock() }
    guard let converter else { return copy(buffer) }
    let ratio = to.sampleRate / from.sampleRate
    // Slack for what the resampler held back from the previous buffer.
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1024
    guard let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: capacity) else { return nil }
    var consumed = false
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { _, inputStatus in
      if consumed {
        // Not .endOfStream: more audio comes later, keep the resampler state.
        inputStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .error || error != nil { return nil }
    return out.frameLength > 0 ? out : nil
  }

  /// Whatever the resampler still holds, at the end of the input.
  func flush() -> AVAudioPCMBuffer? {
    lock.lock()
    defer { lock.unlock() }
    guard let converter else { return nil }
    guard let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: 4096) else { return nil }
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { _, inputStatus in
      inputStatus.pointee = .endOfStream
      return nil
    }
    if status == .error || error != nil { return nil }
    return out.frameLength > 0 ? out : nil
  }

  /// A tap's buffer is reused once the tap returns: hand the analyzer a copy.
  private func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength)
    else { return nil }
    copy.frameLength = buffer.frameLength
    let source = UnsafeMutableAudioBufferListPointer(
      UnsafeMutablePointer(mutating: buffer.audioBufferList))
    let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for (s, t) in zip(source, target) {
      if let from = s.mData, let to = t.mData {
        memcpy(to, from, Int(min(s.mDataByteSize, t.mDataByteSize)))
      }
    }
    return copy
  }
}

/// When audio up to a given point (in seconds of audio) was handed to the
/// analyzer, by the wall clock. The analyzer's time codes start at 0 with the
/// first input and run on contiguously, because the inputs carry no start
/// time of their own; so audio time = frames fed so far / sample rate.
final class FeedLog: @unchecked Sendable {
  private let lock = NSLock()
  private var ends: [Double] = []
  private var walls: [Double] = []
  private var frames: Int64 = 0
  let sampleRate: Double

  init(sampleRate: Double) {
    self.sampleRate = sampleRate
  }

  func record(frames count: AVAudioFrameCount, at wall: Double) {
    lock.lock()
    frames += Int64(count)
    ends.append(Double(frames) / sampleRate)
    walls.append(wall)
    lock.unlock()
  }

  var audioSeconds: Double {
    lock.lock()
    defer { lock.unlock() }
    return Double(frames) / sampleRate
  }

  var lastWall: Double? {
    lock.lock()
    defer { lock.unlock() }
    return walls.last
  }

  /// The wall time at which the buffer holding audio time `t` was fed.
  func wallTime(forAudio t: Double) -> Double? {
    lock.lock()
    defer { lock.unlock() }
    guard !ends.isEmpty else { return nil }
    // First buffer whose end reaches t (1 ms tolerance for rounding).
    var lo = 0
    var hi = ends.count
    while lo < hi {
      let mid = (lo + hi) / 2
      if ends[mid] + 0.001 < t { lo = mid + 1 } else { hi = mid }
    }
    return lo < walls.count ? walls[lo] : walls.last
  }
}

/// 16-bit PCM WAV in the analyzer's sample rate and channel count, for
/// `mic --save`; compare.py resamples to 16 kHz for whisper.cpp anyway.
final class WavWriter: @unchecked Sendable {
  private let file: AVAudioFile
  private let lock = NSLock()
  let path: String

  init(path: String, format: AVAudioFormat) throws {
    self.path = path
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: format.sampleRate,
      AVNumberOfChannelsKey: format.channelCount,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]
    // The file type follows the extension (.wav → WAVE).
    file = try AVAudioFile(
      forWriting: URL(fileURLWithPath: path), settings: settings,
      commonFormat: format.commonFormat, interleaved: format.isInterleaved)
  }

  func write(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    defer { lock.unlock() }
    try? file.write(from: buffer)
  }

  func close() {
    lock.lock()
    defer { lock.unlock() }
    file.close()
  }
}

func describe(_ format: AVAudioFormat) -> String {
  let common: String
  switch format.commonFormat {
  case .pcmFormatInt16: common = "int16"
  case .pcmFormatInt32: common = "int32"
  case .pcmFormatFloat32: common = "float32"
  case .pcmFormatFloat64: common = "float64"
  default: common = "other"
  }
  let layout = format.isInterleaved ? "interleaved" : "non-interleaved"
  return "\(Int(format.sampleRate)) Hz, \(format.channelCount) ch, \(common), \(layout)"
}

// MARK: - Memory

/// Peak resident set size of this process (ru_maxrss is bytes on macOS).
func peakResidentBytes() -> UInt64 {
  var usage = rusage()
  getrusage(RUSAGE_SELF, &usage)
  return UInt64(max(0, usage.ru_maxrss))
}

/// Current physical footprint (what Activity Monitor's "Memory" shows).
func physicalFootprintBytes() -> UInt64? {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(
    MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
  let result = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
    }
  }
  return result == KERN_SUCCESS ? UInt64(info.phys_footprint) : nil
}

struct ProcessMemory: Codable {
  let name: String
  let pid: Int
  let residentBytes: UInt64
}

/// The model does not run in this process: SpeechAnalyzer hands the audio to
/// a system service, so speech-bench's own memory is small. This lists the
/// processes whose name mentions speech, as a hint at where the model's
/// memory went. A heuristic: Apple does not document the daemon's name.
func speechProcesses() -> [ProcessMemory] {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/ps")
  process.arguments = ["-axo", "pid=,rss=,comm="]
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = FileHandle.nullDevice
  do { try process.run() } catch { return [] }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  let own = ProcessInfo.processInfo.processIdentifier
  var found: [ProcessMemory] = []
  for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
    let parts = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
    guard parts.count == 3, let pid = Int(parts[0]), let rssKB = UInt64(parts[1]) else { continue }
    let name = (String(parts[2]) as NSString).lastPathComponent
    guard pid != own, name.lowercased().contains("speech") else { continue }
    found.append(ProcessMemory(name: name, pid: pid, residentBytes: rssKB * 1024))
  }
  return found.sorted { $0.residentBytes > $1.residentBytes }
}
