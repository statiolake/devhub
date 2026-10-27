// Port of apps/desktop/src/main/voice/dictationStream.test.ts, whisper.test.ts,
// whisperServer.test.ts, apps/desktop/src/model/spokenText.test.ts and
// apps/desktop/src/shell/conversation/dictation.test.ts. The recogniser is a
// fake that names what it was given, so no whisper.cpp is needed; the server
// is driven by a fake host, and a WAV file is fed to the client end to end.
import XCTest
@testable import DevHubCore

private let rate = 16_000

private func tone(_ seconds: Double, amplitude: Double = 0.3) -> [UInt8] {
    let count = Int((seconds * Double(rate)).rounded())
    var bytes: [UInt8] = []
    bytes.reserveCapacity(count * 2)
    for i in 0..<count {
        let value = Int16((sin(Double(i) / Double(rate) * 2 * Double.pi * 220) * amplitude * 32767).rounded())
        let bits = UInt16(bitPattern: value)
        bytes.append(UInt8(bits & 0xFF))
        bytes.append(UInt8(bits >> 8))
    }
    return bytes
}

private func silence(_ seconds: Double) -> [UInt8] { [UInt8](repeating: 0, count: Int((seconds * Double(rate)).rounded()) * 2) }

/// A recogniser that answers how many tenths of a second it heard: `t10` for one second.
final class FakeTranscriber: Transcriber, @unchecked Sendable {
    let live: Bool
    private let lock = NSLock()
    private var recorded: [(seconds: Double, options: TranscribeOptions)] = []
    var failWith: Error?
    init(live: Bool = true) { self.live = live }

    var calls: [(seconds: Double, options: TranscribeOptions)] { lock.withLock { recorded } }

    func transcribe(_ pcm: [UInt8], _ options: TranscribeOptions) async throws -> String {
        let seconds = Double(pcm.count) / 2 / Double(rate)
        lock.withLock { recorded.append((seconds, options)) }
        if let failWith { throw failWith }
        return "t\(Int((seconds * 10).rounded()))"
    }
}

final class Updates: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [VoiceUpdate] = []
    func add(_ update: VoiceUpdate) { lock.withLock { all.append(update) } }
    var list: [VoiceUpdate] { lock.withLock { all } }
}

final class DictationTests: XCTestCase {
    func feed(_ segmenter: inout Segmenter, _ runs: (Double, Int)...) -> [Utterance] {
        var out: [Utterance] = []
        for (level, count) in runs {
            for _ in 0..<count { if let u = segmenter.feed(level) { out.append(u) } }
        }
        return out
    }

    var fixed: VadTuning {
        var tuning = VadTuning()
        tuning.minLevel = 0.03
        return tuning
    }

    func testFramesAre20Ms() { XCTAssertEqual(VoiceLevels.frame, 320) }

    func testStartsOnlyAfter200MsAboveTheStartThreshold() {
        var s = Segmenter(fixed)
        _ = feed(&s, (0, 20), (0.05, 9), (0, 1), (0.05, 9))
        XCTAssertNil(s.open)
        _ = feed(&s, (0.05, 1))
        XCTAssertEqual(s.open, 30 - 15)
    }

    func testKeepsGoingAboveTheEndThresholdAndEndsAfter400MsUnderIt() {
        var s = Segmenter(fixed)
        XCTAssertEqual(feed(&s, (0, 20), (0.05, 20), (0.025, 100)), [])
        XCTAssertEqual(s.open, 5)
        XCTAssertEqual(feed(&s, (0.01, 20)), [Utterance(start: 5, end: 140 + 15, forced: false)])
        XCTAssertNil(s.open)
    }

    func testDoesNotEndAtABreathAndDropsAShortUtterance() {
        var s = Segmenter(fixed)
        XCTAssertEqual(feed(&s, (0.05, 20), (0, 19), (0.05, 20), (0, 19)), [])
        XCTAssertEqual(s.open, 0)
        var short = Segmenter(fixed)
        XCTAssertEqual(feed(&short, (0.05, 10), (0, 30)), [])
        XCTAssertEqual(feed(&short, (0, 20), (0.05, 10), (0, 30)), [Utterance(start: 45, end: 85, forced: false)])
    }

    func testNeverPadsBackIntoTheUtteranceBefore() {
        var s = Segmenter(fixed)
        let a = feed(&s, (0.05, 50), (0, 20))
        let b = feed(&s, (0.05, 50), (0, 20))
        XCTAssertEqual(a.first?.end, 65)
        XCTAssertEqual(b.first?.start, 65)
    }

    func testCutsOneThatRunsTooLongAtItsQuietestFrame() {
        var tuning = fixed
        tuning.maxUtteranceSeconds = 2
        var s = Segmenter(tuning)
        XCTAssertEqual(feed(&s, (0.05, 70), (0.021, 1), (0.05, 29)), [Utterance(start: 0, end: 70, forced: true)])
        XCTAssertEqual(s.open, 70)
        XCTAssertEqual(feed(&s, (0.05, 10), (0, 20)), [Utterance(start: 70, end: 110 + 15, forced: false)])
    }

    func testEndsTheOneBeingSpokenAtTheEndOfTheRecording() {
        var s = Segmenter(fixed)
        _ = feed(&s, (0, 5), (0.05, 12))
        XCTAssertEqual(s.flush(), Utterance(start: 0, end: 17, forced: false))
        XCTAssertNil(s.flush())
    }

    func testFollowsTheNoiseFloorBetweenItsLimits() {
        let tuning = VadTuning()
        XCTAssertEqual(VoiceLevels.thresholds(0, tuning).start, 0.01)
        XCTAssertEqual(VoiceLevels.thresholds(0, tuning).end, 0.02 / 3, accuracy: 1e-6)
        XCTAssertEqual(VoiceLevels.thresholds(0.005, tuning).start, 0.015, accuracy: 1e-6)
        XCTAssertEqual(VoiceLevels.thresholds(1, tuning).start, 0.03)
        var quiet = Segmenter()
        _ = feed(&quiet, (0.001, 100), (0.012, 10))
        XCTAssertNotNil(quiet.open)
        var fan = Segmenter()
        _ = feed(&fan, (0.005, 100), (0.012, 10))
        XCTAssertNil(fan.open)
    }

    // MARK: The stream

    func waitFor(_ condition: @escaping () async -> Bool) async {
        for _ in 0..<400 {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    func testShowsTheUtteranceBeingSpokenAsTentativeOnceASecondIsHeard() async throws {
        let fake = FakeTranscriber()
        let updates = Updates()
        let stream = DictationStream(transcriber: fake, language: .ja) { updates.add($0) }
        await stream.push(tone(0.75))
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(fake.calls.count, 0)
        await stream.push(tone(0.25))
        await waitFor { updates.list.last == VoiceUpdate(committed: "", tentative: "t10") }
        XCTAssertEqual(updates.list.last, VoiceUpdate(committed: "", tentative: "t10"))
        XCTAssertEqual(fake.calls.map(\.options.partial), [true])
    }

    func testCommitsAnUtteranceAtAPauseOnceAndStartsTheNextAfterIt() async throws {
        let fake = FakeTranscriber()
        let updates = Updates()
        let stream = DictationStream(transcriber: fake, language: .ja) { updates.add($0) }
        await stream.push(tone(1))
        await waitFor { fake.calls.count == 1 }
        await stream.push(silence(0.8))
        await waitFor { updates.list.last?.committed == "t13" }
        XCTAssertEqual(updates.list.last, VoiceUpdate(committed: "t13", tentative: ""))
        await stream.push(tone(1.5))
        await waitFor { updates.list.last?.tentative == "t18" }
        XCTAssertEqual(fake.calls.last?.options.prompt, "t13")
        let all = try await stream.finish()
        XCTAssertEqual(all, "t13 t18")
        XCTAssertEqual(updates.list.last, VoiceUpdate(committed: "t13 t18", tentative: ""))
        let calls = fake.calls.map { "\($0.seconds) \($0.options.partial)" }
        XCTAssertEqual(calls, ["1.0 true", "1.3 false", "1.8 true", "1.8 false"])
        let committed = updates.list.map(\.committed)
        for (earlier, later) in zip(committed, committed.dropFirst()) { XCTAssertTrue(later.hasPrefix(earlier)) }
    }

    func testTranscribesNothingOfSilenceOrAClick() async throws {
        let fake = FakeTranscriber()
        let stream = DictationStream(transcriber: fake, language: .en) { _ in }
        await stream.push(silence(5))
        await stream.push(tone(0.1))
        await stream.push(silence(1))
        let all = try await stream.finish()
        XCTAssertEqual(all, "")
        XCTAssertEqual(fake.calls.count, 0)
    }

    func testWithARecogniserTooSlowToRunLiveTranscribesOnceAtTheEnd() async throws {
        let fake = FakeTranscriber(live: false)
        let updates = Updates()
        let stream = DictationStream(transcriber: fake, language: .ja) { updates.add($0) }
        await stream.push(tone(1))
        await stream.push(silence(1))
        await stream.push(tone(1))
        XCTAssertEqual(fake.calls.count, 0)
        let all = try await stream.finish()
        XCTAssertEqual(all, "t30")
        XCTAssertEqual(updates.list, [VoiceUpdate(committed: "t30", tentative: "")])
    }

    func testFailsTheDictationOnceWhenTheRecogniserFails() async throws {
        let fake = FakeTranscriber()
        fake.failWith = VoiceFailure("The recogniser stopped.")
        let stream = DictationStream(transcriber: fake, language: .ja) { _ in }
        await stream.push(tone(1))
        await waitFor { fake.calls.count == 1 }
        try await Task.sleep(nanoseconds: 50_000_000)
        await stream.push(tone(1))
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(fake.calls.count, 1)
        do {
            _ = try await stream.finish()
            XCTFail("the failure was not reported")
        } catch {
            XCTAssertEqual(error as? VoiceFailure, VoiceFailure("The recogniser stopped."))
        }
    }

    func testReportsNothingAfterItIsCancelled() async throws {
        let fake = FakeTranscriber()
        let updates = Updates()
        let stream = DictationStream(transcriber: fake, language: .ja) { updates.add($0) }
        await stream.push(tone(1))
        await stream.cancel()
        await stream.push(tone(1))
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(updates.list, [])
    }

    // MARK: Joining spoken text

    func testSpacesLatinTextAndRunsJapaneseTogether() {
        XCTAssertEqual(SpokenText.join("Fix the", "bug."), "Fix the bug.")
        XCTAssertEqual(SpokenText.join("これを", "直して"), "これを直して")
        XCTAssertEqual(SpokenText.join("", "a"), "a")
        XCTAssertEqual(SpokenText.join("a", ""), "a")
        XCTAssertEqual(SpokenText.join("README を", "読んで"), "README を読んで")
        XCTAssertTrue(SpokenText.isCjk("。"))
        XCTAssertTrue(SpokenText.isCjk("Ａ"))
        XCTAssertFalse(SpokenText.isCjk("a"))
        XCTAssertFalse(SpokenText.needsSpace("a", " "))
    }

    func testPutsWordsWhereTheCaretWasAllowingForTypingSince() {
        XCTAssertEqual(DictationText.insert("Fix the", start: 7, end: 7, words: "bug").text, "Fix the bug")
        XCTAssertEqual(DictationText.insert("Fix the", start: 7, end: 7, words: "bug").caret, 11)
        XCTAssertEqual(DictationText.insert("ab", start: 1, end: 1, words: "X").text, "a X b")
        XCTAssertEqual(DictationText.insert("これ", start: 2, end: 2, words: "を直す").text, "これを直す")
        XCTAssertEqual(DictationText.insert("a selected b", start: 2, end: 10, words: "new").text, "a new b")
        // Typed before the anchor: the next words still land after the last.
        let anchor = DictationText.Anchor(start: 5, end: 5, text: "hello")
        let placed = DictationText.place("well, hello", anchor: anchor, words: "world")
        XCTAssertEqual(placed.text, "well, hello world")
        XCTAssertEqual(placed.anchor.start, placed.caret)
        XCTAssertEqual(DictationText.shiftAnchor("abc", "abXc", 1), 1)
        XCTAssertEqual(DictationText.shiftAnchor("abc", "abXc", 3), 4)
        XCTAssertEqual(DictationText.shiftAnchor("abcdef", "abZef", 3), 3)
    }

    func testTheLanguageLabelCyclesAndRemembersTheDefault() {
        XCTAssertEqual(VoiceLanguage.ja.next, .en)
        XCTAssertEqual(VoiceLanguage.en.next, .auto)
        XCTAssertEqual(VoiceLanguage.auto.next, .ja)
        XCTAssertEqual(VoiceLanguage.saved(nil), .ja)
        XCTAssertEqual(VoiceLanguage.saved("en"), .en)
        XCTAssertEqual(VoiceLanguage.saved("fr"), .ja)
        XCTAssertEqual(VoiceLanguage.ja.label, "日本語")
    }

    func testBringsTheMicrophoneDownTo16kHzWithoutDrift() {
        let input = (0..<4800).map { Float(sin(Double($0) / 10)) }
        let whole = VoiceAudio.downsample(input, from: 48_000)
        var downsampler = StreamingDownsampler(from: 48_000)
        var pieces: [Float] = []
        var at = 0
        for size in [1000, 7, 2048, 1745] {
            pieces += downsampler.push(Array(input[at..<(at + size)]))
            at += size
        }
        XCTAssertEqual(pieces.count, whole.count)
        for (a, b) in zip(pieces, whole) { XCTAssertEqual(a, b, accuracy: 1e-5) }
        XCTAssertEqual(VoiceAudio.pcm16([1, -1, 0, 2]), [0xFF, 0x7F, 0x00, 0x80, 0, 0, 0xFF, 0x7F])
        XCTAssertEqual(VoiceAudio.level([]), 0)
        XCTAssertEqual(VoiceAudio.level([1, -1]), 1)
    }

    // MARK: whisper.ts

    func testLooksWhereTheEnvironmentSaysThenTheBundleThenTheSourceRun() {
        XCTAssertEqual(
            Whisper.candidates(resources: "/A/DevHub.app/Contents/Resources", environment: ["DEVHUB_WHISPER_DIR": "/try"], repository: "/src"),
            ["/try", "/A/DevHub.app/Contents/Resources/whisper", "/src/dist/whisper"])
        let present: Set<String> = ["/b/devhub-whisper", "/b/ggml-large-v3-turbo-q5_0.bin", "/c/devhub-whisper", "/c/ggml-small.bin", "/c/devhub-whisper-server"]
        XCTAssertEqual(
            Whisper.locate(["/a", "/b", "/c"], exists: { present.contains($0) }, stated: { _ in nil }),
            WhisperInstall(binary: "/b/devhub-whisper", model: "/b/ggml-large-v3-turbo-q5_0.bin"))
        XCTAssertEqual(
            Whisper.locate(["/c"], exists: { present.contains($0) }, stated: { _ in nil })?.server, "/c/devhub-whisper-server")
        XCTAssertEqual(Whisper.statedModel("/x", read: { _ in #"{"model":"ggml-small.bin"}"# }), "ggml-small.bin")
        XCTAssertNil(Whisper.statedModel("/x", read: { _ in #"{"model":"../evil.bin"}"# }))
        XCTAssertNil(Whisper.statedModel("/x", read: { _ in nil }))
    }

    func testIsACanonical16kHzMono16BitWav() {
        let wav = Whisper.wavFile([1, 2, 3, 4])
        XCTAssertEqual(wav.count, 48)
        XCTAssertEqual(Array(wav[0..<4]), Array("RIFF".utf8))
        XCTAssertEqual(Array(wav[4..<8]), [40, 0, 0, 0])
        XCTAssertEqual(Array(wav[24..<28]), [0x80, 0x3E, 0, 0])
        XCTAssertEqual(Array(wav[40..<44]), [4, 0, 0, 0])
        XCTAssertEqual(Whisper.recordingRefusal([1]), "The recording is not 16-bit audio.")
        XCTAssertEqual(Whisper.recordingRefusal([]), "Nothing was recorded.")
        XCTAssertNil(Whisper.recordingRefusal([0, 0]))
    }

    func testAsksForPlainTextInTheLanguageChosenWithCappedThreads() {
        XCTAssertEqual(
            Whisper.cliArgs(model: "/m", wav: "/r.wav", outputBase: "/t", language: .ja, threads: 20),
            ["-m", "/m", "-f", "/r.wav", "-l", "ja", "-t", "8", "-nt", "-np", "-otxt", "-of", "/t"])
        XCTAssertEqual(
            Whisper.serverArgs(model: "/m", port: 4567, path: "/abc", threads: 10),
            ["-m", "/m", "--host", "127.0.0.1", "--port", "4567", "--request-path", "/abc", "-t", "4", "-fa", "-nt"])
        XCTAssertEqual(Whisper.serverThreads(2), 2)
        let partial = Dictionary(uniqueKeysWithValues: Whisper.inferenceFields(TranscribeOptions(language: .en, partial: true)))
        XCTAssertEqual(partial["best_of"], "1")
        XCTAssertEqual(partial["temperature_inc"], "0")
        let committed = Dictionary(uniqueKeysWithValues: Whisper.inferenceFields(TranscribeOptions(language: .en, prompt: "so far")))
        XCTAssertEqual(committed["best_of"], "2")
        XCTAssertEqual(committed["prompt"], "so far")
    }

    func testCleansWhatWhisperSaysOverSilence() {
        XCTAssertEqual(Whisper.cleanTranscript("Fix the\nbug.\n"), "Fix the bug.")
        XCTAssertEqual(Whisper.cleanTranscript("これを\n直して\n"), "これを直して")
        XCTAssertEqual(Whisper.cleanTranscript("[BLANK_AUDIO]\nhello (world)\n(keyboard clicking)\n【拍手】\n*sigh*\n♪"), "hello (world)")
        XCTAssertEqual(Whisper.cleanTranscript("ご視聴ありがとうございました\n本題です"), "本題です")
        XCTAssertEqual(Whisper.cleanTranscript("Thanks for watching!"), "")
        XCTAssertEqual(Whisper.cleanTranscript("I said thanks for watching"), "I said thanks for watching")
    }

    // MARK: whisperServer.ts, with a WAV fed to the client

    func testStartsOnceWaitsUntilHealthyAndTranscribesAWav() async throws {
        let host = FakeWhisperHost()
        let server = WhisperServer(WhisperInstall(binary: "/w/devhub-whisper", model: "/w/ggml-small.bin", server: "/w/devhub-whisper-server"), host: host)
        let words = try await server.transcribe(tone(1), TranscribeOptions(language: .en))
        XCTAssertEqual(words, "hello there")
        let again = try await server.transcribe(tone(0.5), TranscribeOptions(language: .ja, partial: true))
        XCTAssertEqual(again, "hello there")
        XCTAssertEqual(host.spawned.count, 1)
        XCTAssertEqual(host.spawned.first?.0, "/w/devhub-whisper-server")
        XCTAssertTrue(host.spawned.first!.1.contains("--request-path"))
        let inference = host.requests.filter { $0.0.path.hasSuffix("/inference") }
        XCTAssertEqual(inference.count, 2)
        // Loopback, under the secret path.
        XCTAssertEqual(inference.first?.0.host, "127.0.0.1")
        XCTAssertTrue(inference.first!.0.path.hasPrefix("/secret"))
        // The body carries the WAV and the fields.
        let body = String(decoding: inference.first!.1, as: UTF8.self)
        XCTAssertTrue(body.contains("RIFF"))
        XCTAssertTrue(body.contains("name=\"language\"\r\n\r\nen"))
        XCTAssertTrue(body.contains("name=\"best_of\"\r\n\r\n2"))
    }

    func testStartsAgainAfterTheProcessDiesAndSaysWhyWhenItCannot() async throws {
        let host = FakeWhisperHost()
        let server = WhisperServer(WhisperInstall(binary: "/w/b", model: "/w/m", server: "/w/s"), host: host, startupMs: 500)
        _ = try await server.transcribe(tone(1), TranscribeOptions(language: .en))
        host.process?.die("stopped (exit code 1)")
        _ = try await server.transcribe(tone(1), TranscribeOptions(language: .en))
        XCTAssertEqual(host.spawned.count, 2)
        host.healthy = false
        host.process?.die("stopped (exit code 1)")
        host.dieOnSpawn = "failed to load model"
        do {
            _ = try await server.transcribe(tone(1), TranscribeOptions(language: .en))
            XCTFail("a server that cannot start answered")
        } catch {
            XCTAssertTrue("\(error)".contains("failed to load model"), "\(error)")
        }
    }

    func testTurnsTheServersErrorAnswerIntoAFailure() async throws {
        let host = FakeWhisperHost()
        host.answer = (200, #"{"error":"bad audio"}"#)
        let server = WhisperServer(WhisperInstall(binary: "/w/b", model: "/w/m", server: "/w/s"), host: host)
        do {
            _ = try await server.transcribe(tone(1), TranscribeOptions(language: .en))
            XCTFail("an error answer was taken for words")
        } catch {
            XCTAssertEqual("\(error)", #"The recogniser failed: {"error":"bad audio"}"#)
        }
    }

    func testAStreamOnTheServerCommitsWhatWasSaid() async throws {
        let host = FakeWhisperHost()
        let server = WhisperServer(WhisperInstall(binary: "/w/b", model: "/w/m", server: "/w/s"), host: host)
        let stream = DictationStream(transcriber: server, language: .en) { _ in }
        await stream.push(tone(1))
        await stream.push(silence(0.8))
        let all = try await stream.finish()
        XCTAssertTrue(all.hasPrefix("hello there"), all)
    }
}

final class FakeWhisperProcess: WhisperServerProcess, @unchecked Sendable {
    private let lock = NSLock()
    private var gone: String?
    private var tail = ""
    var exited: String? { lock.withLock { gone } }
    var stderrTail: String { lock.withLock { tail } }
    func stop() { die("stopped (signal 15)") }
    func die(_ why: String, stderr: String = "") { lock.withLock { gone = why; tail += stderr } }
}

final class FakeWhisperHost: WhisperServerHost, @unchecked Sendable {
    private let lock = NSLock()
    private var spawnedValue: [(String, [String])] = []
    private var requestsValue: [(URL, Data)] = []
    private var processValue: FakeWhisperProcess?
    var healthy = true
    var dieOnSpawn: String?
    var answer: (Int, String) = (200, "hello\nthere\n")

    var spawned: [(String, [String])] { lock.withLock { spawnedValue } }
    var requests: [(URL, Data)] { lock.withLock { requestsValue } }
    var process: FakeWhisperProcess? { lock.withLock { processValue } }

    func spawn(_ binary: String, _ args: [String]) throws -> WhisperServerProcess {
        let process = FakeWhisperProcess()
        if let dieOnSpawn { process.die("stopped (exit code 1)", stderr: dieOnSpawn) }
        lock.withLock {
            spawnedValue.append((binary, args))
            processValue = process
        }
        return process
    }

    func freePort() throws -> Int { 4567 }
    func secret() -> String { "secret" }

    func request(_ url: URL, method: String, body: Data?, contentType: String?, timeoutSeconds: Double) async throws -> (Int, Data) {
        lock.withLock { requestsValue.append((url, body ?? Data())) }
        if url.path.hasSuffix("/health") { return (healthy ? 200 : 503, Data()) }
        return (answer.0, Data(answer.1.utf8))
    }
}
