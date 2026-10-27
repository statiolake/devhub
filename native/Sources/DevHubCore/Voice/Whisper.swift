// Port of apps/desktop/src/main/voice/whisper.ts and whisperServer.ts.
//
// The bundled speech recogniser: whisper.cpp's `whisper-cli` as
// `devhub-whisper`, and its `whisper-server` as `devhub-whisper-server`, with
// the model beside them (`scripts/build_whisper.py`). Nothing leaves the Mac:
// the programs are built without a network client, and the server listens on
// 127.0.0.1 only, on a port chosen free just before it starts, with every
// route under a random path — so the path is the key.
//
// Dictation streams through the server, which keeps the model loaded: the
// utterance being spoken is transcribed about once a second, and each
// utterance once more when it ends (`DictationStream`). A directory built
// before the server existed has only the CLI, and with it dictation still
// works, transcribed once when the recording ends.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// How one transcription is decoded.
public struct TranscribeOptions: Equatable, Sendable {
    public var language: VoiceLanguage
    /// Text the audio continues, for context.
    public var prompt: String?
    /// A tentative pass over an utterance still being spoken: the cheapest
    /// decode will do, since the committed pass follows.
    public var partial: Bool

    public init(language: VoiceLanguage, prompt: String? = nil, partial: Bool = false) {
        self.language = language
        self.prompt = prompt
        self.partial = partial
    }
}

/// Something that turns 16 kHz mono 16-bit PCM into words.
public protocol Transcriber: AnyObject, Sendable {
    /// Whether it is cheap enough to run over and over while the person speaks.
    var live: Bool { get }
    func transcribe(_ pcm: [UInt8], _ options: TranscribeOptions) async throws -> String
}

/// The failure a recogniser reports, in its own words.
public struct VoiceFailure: Error, Equatable, Sendable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// Where a recogniser is, and what it holds.
public struct WhisperInstall: Equatable, Sendable {
    public var binary: String
    public var model: String
    /// `devhub-whisper-server`, when the directory has it.
    public var server: String?

    public init(binary: String, model: String, server: String? = nil) {
        self.binary = binary
        self.model = model
        self.server = server
    }
}

public enum Whisper {
    public static let binary = "devhub-whisper"
    public static let serverBinary = "devhub-whisper-server"
    /// The model `scripts/build_whisper.py` installs by default.
    public static let model = "ggml-small.bin"
    /// Every model it can install, the default first.
    public static let models = [model, "ggml-large-v3-turbo-q5_0.bin"]
    static let statement = "whisper.json"

    /// Where a recogniser may be, most specific first: `DEVHUB_WHISPER_DIR`,
    /// the app's `Contents/Resources/whisper`, and a source run's `dist/whisper`.
    public static func candidates(resources: String?, environment: [String: String], repository: String? = nil) -> [String] {
        var found: [String] = []
        if let named = environment["DEVHUB_WHISPER_DIR"], !named.isEmpty { found.append(named) }
        if let resources { found.append(Path.join(resources, "whisper")) }
        if let repository { found.append(Path.join(Path.join(repository, "dist"), "whisper")) }
        return found
    }

    /// The model file a directory's statement names, when it names a plain
    /// file name; nil for no statement or a strange one.
    public static func statedModel(_ directory: String, read: (String) -> String? = { try? String(contentsOfFile: $0, encoding: .utf8) }) -> String? {
        guard let text = read(Path.join(directory, statement)), let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let model = object["model"] as? String, model.hasSuffix(".bin"), !model.contains("/")
        else { return nil }
        return model
    }

    /// The first candidate that holds both the program and a model.
    public static func locate(
        _ candidates: [String], exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        stated: (String) -> String? = { statedModel($0) }
    ) -> WhisperInstall? {
        for directory in candidates {
            let program = Path.join(directory, binary)
            guard exists(program) else { continue }
            let named = stated(directory)
            let model = ((named.map { [$0] } ?? []) + models).map { Path.join(directory, $0) }.first(where: exists)
            if let model {
                let server = Path.join(directory, serverBinary)
                return WhisperInstall(binary: program, model: model, server: exists(server) ? server : nil)
            }
        }
        return nil
    }

    /// A RIFF/WAVE file around 16-bit mono PCM: the 44-byte canonical header.
    public static func wavFile(_ pcm: [UInt8], sampleRate: Int = VoiceAudio.sampleRate) -> [UInt8] {
        var header: [UInt8] = []
        func ascii(_ text: String) { header += Array(text.utf8) }
        func u32(_ value: Int) { let v = UInt32(value); header += [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8(v >> 24)] }
        func u16(_ value: Int) { let v = UInt16(value); header += [UInt8(v & 0xFF), UInt8(v >> 8)] }
        ascii("RIFF"); u32(36 + pcm.count); ascii("WAVE")
        ascii("fmt "); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
        ascii("data"); u32(pcm.count)
        return header + pcm
    }

    /// Why a recording is not one to transcribe, or nil when it is.
    public static func recordingRefusal(_ pcm: [UInt8]) -> String? {
        if pcm.count % 2 != 0 { return "The recording is not 16-bit audio." }
        if pcm.isEmpty { return "Nothing was recorded." }
        if pcm.count > VoiceAudio.maxSeconds * VoiceAudio.sampleRate * 2 {
            return "A recording is at most \(VoiceAudio.maxSeconds / 60) minutes long."
        }
        return nil
    }

    /// The command line for one recording.
    public static func cliArgs(model: String, wav: String, outputBase: String, language: VoiceLanguage, threads: Int) -> [String] {
        ["-m", model, "-f", wav, "-l", language.rawValue, "-t", String(max(1, min(8, threads))), "-nt", "-np", "-otxt", "-of", outputBase]
    }

    /// CPU threads for the server: half the cores, between 2 and 4.
    public static func serverThreads(_ cores: Int) -> Int { max(2, min(4, cores / 2)) }

    /// The server's command line; `-fa` (flash attention) said so a default
    /// changing upstream does not quietly make dictation slower.
    public static func serverArgs(model: String, port: Int, path: String, threads: Int) -> [String] {
        ["-m", model, "--host", "127.0.0.1", "--port", String(port), "--request-path", path, "-t", String(serverThreads(threads)), "-fa", "-nt"]
    }

    /// The form fields of one transcription: temperature 0, no timestamps; a
    /// tentative pass greedy with no fallback, the committed one with it.
    public static func inferenceFields(_ options: TranscribeOptions) -> [(String, String)] {
        var fields: [(String, String)] = [
            ("response_format", "text"), ("no_timestamps", "true"), ("temperature", "0"),
            ("temperature_inc", options.partial ? "0" : "0.2"), ("best_of", options.partial ? "1" : "2"),
            ("language", options.language.rawValue),
        ]
        if let prompt = options.prompt { fields.append(("prompt", prompt)) }
        return fields
    }

    /// A recording of `seconds` seconds is given this long before it is given up on.
    public static func transcriptionDeadlineMs(_ seconds: Double) -> Double { 60_000 + seconds * 2_000 }

    private static let nonSpeech = TextPattern("^\\s*(\\[[^\\]]*\\]|\\([^)]*\\)|（[^）]*）|【[^】]*】|\\*[^*]*\\*|[♪〜~]+)\\s*$")
    private static let hallucinations = [
        TextPattern("^(最後まで)?ご(視聴|清聴)(いただき|頂き)?(、)?(本当に|誠に)?ありがとうございま(した|す)[。！!」\"]*$"),
        TextPattern("^(ぜひ)?チャンネル登録(を)?(よろしく)?(お願い(いた)?します|お願いしま〜す)[。！!]*$"),
        TextPattern("^(thank you|thanks) (so much )?for watching[.!]*$", options: [.caseInsensitive]),
    ]

    /// Whether one segment of a transcript is not words the person said.
    public static func isNonSpeech(_ segment: String) -> Bool {
        let trimmed = segment.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty || nonSpeech.matches(trimmed) || hallucinations.contains { $0.matches(trimmed) }
    }

    /// The words a transcript holds, as one paragraph: segments joined with a
    /// space between Latin text and with nothing where either side is Japanese.
    public static func cleanTranscript(_ raw: String) -> String {
        let segments = raw.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !isNonSpeech($0) }
        var text = ""
        for segment in segments { text = SpokenText.join(text, segment) }
        return text
    }
}

/// One transcription at a time: the GPU is one GPU.
actor TranscriptionQueue {
    private var tail: Task<Void, Never>?

    func run<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = tail
        let task = Task<T, Error> {
            await previous?.value
            return try await work()
        }
        tail = Task { _ = try? await task.value }
        return try await task.value
    }
}

/// The per-recording CLI: the fallback, run once when the recording ends.
public final class WhisperCLI: Transcriber, @unchecked Sendable {
    public let live = false
    private let install: WhisperInstall
    private let queue = TranscriptionQueue()

    public init(_ install: WhisperInstall) { self.install = install }

    public func transcribe(_ pcm: [UInt8], _ options: TranscribeOptions) async throws -> String {
        let install = self.install
        return try await queue.run {
            let directory = (NSTemporaryDirectory() as NSString).appendingPathComponent("devhub-voice-\(UUID().uuidString)")
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(atPath: directory) }
            let wav = Path.join(directory, "recording.wav")
            let outputBase = Path.join(directory, "transcript")
            try Data(Whisper.wavFile(pcm)).write(to: URL(fileURLWithPath: wav))
            let seconds = Double(pcm.count) / 2 / Double(VoiceAudio.sampleRate)
            let deadline = Whisper.transcriptionDeadlineMs(seconds)
            let answer: ExecAnswer
            do {
                answer = try await BoundedExec.run(
                    argv: [install.binary] + Whisper.cliArgs(
                        model: install.model, wav: wav, outputBase: outputBase, language: options.language,
                        threads: ProcessInfo.processInfo.activeProcessorCount),
                    cwd: nil, environment: ProcessInfo.processInfo.environment, timeoutMs: Int(deadline),
                    limits: ExecLimits(stdoutBytes: 64 * 1024, stderrBytes: 4000))
            } catch ExecFailure.timedOut {
                throw VoiceFailure("The recogniser took longer than \(Int((deadline / 1000).rounded())) seconds and was stopped.")
            } catch let failure as ExecFailure {
                throw VoiceFailure("The recogniser could not be started: \(failure)")
            }
            guard answer.code == 0 else {
                let tail = answer.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
                let shown = tail.count > 400 ? "…\(tail.suffix(400))" : tail
                throw VoiceFailure("The recogniser stopped (\(answer.signal ?? "exit code \(answer.code.map(String.init) ?? "?")"))\(shown.isEmpty ? "." : ": \(shown)")")
            }
            let text = (try? String(contentsOfFile: "\(outputBase).txt", encoding: .utf8)) ?? ""
            return Whisper.cleanTranscript(text)
        }
    }
}

/// What the server needs of the machine; a test's own.
public protocol WhisperServerHost: Sendable {
    /// Start the server; the handle stops it.
    func spawn(_ binary: String, _ args: [String]) throws -> WhisperServerProcess
    func freePort() throws -> Int
    func secret() -> String
    /// One HTTP request: the status and the body.
    func request(_ url: URL, method: String, body: Data?, contentType: String?, timeoutSeconds: Double) async throws -> (Int, Data)
}

/// A running server process.
public protocol WhisperServerProcess: AnyObject, Sendable {
    var exited: String? { get }
    var stderrTail: String { get }
    func stop()
}

/// The recogniser kept loaded: started lazily, stopped after `idleMs` with
/// nothing asked; one that exits or stops answering is started again by the
/// next request.
public actor WhisperServer: Transcriber {
    public nonisolated let live = true
    private let install: WhisperInstall
    private let host: any WhisperServerHost
    private let idleMs: Double
    private let startupMs: Double

    private struct Running {
        let process: WhisperServerProcess
        let base: String
        var ready: Task<Void, Error>
    }

    private var running: Running?
    private var idle: Task<Void, Never>?
    private let queue = TranscriptionQueue()

    public init(_ install: WhisperInstall, host: any WhisperServerHost = LocalWhisperServerHost(), idleMs: Double = 10 * 60_000, startupMs: Double = 90_000) {
        self.install = install
        self.host = host
        self.idleMs = idleMs
        self.startupMs = startupMs
    }

    /// Start the server if it is not running; returns when it answers.
    public func warm() async throws {
        touch()
        try await ensure().value
    }

    public var started: Bool { running != nil }

    public nonisolated func transcribe(_ pcm: [UInt8], _ options: TranscribeOptions) async throws -> String {
        try await queue.run { try await self.request(pcm, options) }
    }

    public func stop() {
        idle?.cancel()
        idle = nil
        running?.process.stop()
        running?.ready.cancel()
        running = nil
    }

    private func touch() {
        idle?.cancel()
        let idleMs = self.idleMs
        idle = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(idleMs * 1_000_000))
            if Task.isCancelled { return }
            await self?.stop()
        }
    }

    private func ensure() throws -> Task<Void, Error> {
        if let running, running.process.exited == nil { return running.ready }
        running = nil
        let path = "/\(host.secret())"
        let port = try host.freePort()
        let base = "http://127.0.0.1:\(port)\(path)"
        let process = try host.spawn(
            install.server ?? install.binary,
            Whisper.serverArgs(model: install.model, port: port, path: path, threads: ProcessInfo.processInfo.activeProcessorCount))
        let host = self.host
        let startupMs = self.startupMs
        let ready = Task<Void, Error> {
            let deadline = Date().addingTimeInterval(startupMs / 1000)
            while Date() < deadline && process.exited == nil {
                if let url = URL(string: "\(base)/health"),
                   let (status, _) = try? await host.request(url, method: "GET", body: nil, contentType: nil, timeoutSeconds: 2),
                   status == 200
                {
                    return
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            process.stop()
            let tail = String(process.stderrTail.trimmingCharacters(in: .whitespacesAndNewlines).suffix(400))
            let gone = process.exited ?? "did not start within \(Int(startupMs / 1000)) seconds"
            throw VoiceFailure("The recogniser \(gone)\(tail.isEmpty ? "." : ": \(tail)")")
        }
        running = Running(process: process, base: base, ready: ready)
        return ready
    }

    private func dropIfCurrent(_ base: String) {
        if running?.base == base { stop() }
    }

    private func request(_ pcm: [UInt8], _ options: TranscribeOptions) async throws -> String {
        touch()
        let ready = try ensure()
        guard let base = running?.base else { throw VoiceFailure("The recogniser was stopped.") }
        do {
            try await ready.value
        } catch {
            dropIfCurrent(base)
            throw error
        }
        let boundary = "devhub-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8))
        body.append(Data(Whisper.wavFile(pcm)))
        body.append(Data("\r\n".utf8))
        for (name, value) in Whisper.inferenceFields(options) { field(name, value) }
        body.append(Data("--\(boundary)--\r\n".utf8))
        let seconds = Double(pcm.count) / 2 / Double(VoiceAudio.sampleRate)
        let deadline = (Whisper.transcriptionDeadlineMs(seconds) - 50_000) / 1000
        let status: Int
        let answer: Data
        do {
            guard let url = URL(string: "\(base)/inference") else { throw VoiceFailure("The recogniser has no address.") }
            (status, answer) = try await host.request(
                url, method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)", timeoutSeconds: deadline)
        } catch {
            // A server that does not answer is a server that is wedged.
            dropIfCurrent(base)
            throw VoiceFailure("The recogniser did not answer: \(error)")
        }
        let text = String(decoding: answer, as: UTF8.self)
        if status != 200 || text.trimmingCharacters(in: .whitespaces).hasPrefix("{\"error\"") {
            throw VoiceFailure("The recogniser failed: \(String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(400)))")
        }
        touch()
        return Whisper.cleanTranscript(text)
    }
}

/// This Mac: a child process, a free loopback port, and URLSession.
public struct LocalWhisperServerHost: WhisperServerHost {
    public init() {}

    public func spawn(_ binary: String, _ args: [String]) throws -> WhisperServerProcess {
        try LocalWhisperProcess(binary, args)
    }

    public func freePort() throws -> Int {
        #if os(Linux)
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        #else
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        #endif
        guard fd >= 0 else { throw VoiceFailure("No port could be found for the recogniser.") }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { throw VoiceFailure("No port could be found for the recogniser.") }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        return Int(UInt16(bigEndian: address.sin_port))
    }

    public func secret() -> String {
        (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    public func request(_ url: URL, method: String, body: Data?, contentType: String?, timeoutSeconds: Double) async throws -> (Int, Data) {
        var request = URLRequest(url: url, timeoutInterval: timeoutSeconds)
        request.httpMethod = method
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "content-type") }
        request.httpBody = body
        return try await withCheckedThrowingContinuation { continuation in
            let task = URLSession.shared.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: VoiceFailure((error as NSError).localizedDescription))
                    return
                }
                continuation.resume(returning: ((response as? HTTPURLResponse)?.statusCode ?? 0, data ?? Data()))
            }
            task.resume()
        }
    }
}

final class LocalWhisperProcess: WhisperServerProcess, @unchecked Sendable {
    private let child: SpawnedChild
    private let reader: DescriptorReader
    private let output: DescriptorReader
    private let state = Guarded<(exited: String?, stderr: String)>((nil, ""))

    init(_ binary: String, _ args: [String]) throws {
        do {
            child = try SpawnedChild.spawn(
                executable: binary, args: args, env: ProcessInfo.processInfo.environment, cwd: nil, pipeStdin: false)
        } catch {
            throw VoiceFailure("The recogniser could not be started: \(error)")
        }
        let state = self.state
        reader = DescriptorReader(
            child.stderr, queue: DispatchQueue(label: "devhub.whisper-server"),
            onChunk: { chunk in state.with { $0.stderr = String(($0.stderr + String(decoding: chunk, as: UTF8.self)).suffix(4000)) } },
            onEnd: {})
        reader.start()
        // Drained and dropped: the server writes nothing there worth keeping,
        // and a pipe nobody reads would stop it once full.
        output = DescriptorReader(child.stdout, queue: DispatchQueue(label: "devhub.whisper-server.out"), onChunk: { _ in }, onEnd: {})
        output.start()
        child.whenExited { code, signal in
            state.with { $0.exited = "stopped (\(signal.map { "signal \($0)" } ?? "exit code \(code.map(String.init) ?? "?")"))" }
        }
    }

    var exited: String? { state.with { $0.exited } }
    var stderrTail: String { state.with { $0.stderr } }

    func stop() {
        if child.isRunning { child.signalGroup(SIGTERM) }
        reader.stop()
        output.stop()
    }
}
