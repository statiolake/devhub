// Port of apps/desktop/src/shell/conversation/useDictation.ts, the composer's
// dictation controls, and main/voice/voiceIpc.ts: speech typed into whatever
// text the keyboard is in, recognised on this Mac.
//
// ⌘⇧M starts a dictation in the focused text view (an Agent's composer, a
// sheet's field, a Settings field), and stops it; Escape while it records
// throws away what is not in yet. The microphone is opened only after the
// person allowed it; its audio is brought down to 16 kHz mono as it comes
// (`StreamingDownsampler`) and fed to Core's `DictationStream`, whose
// committed words go in at the caret as they settle — at the place the caret
// was, even if the person typed elsewhere since (`DictationText.place`) — and
// whose tentative words stand in a small panel under the text until they do.
// The recogniser is `devhub-whisper` (its server, kept warm, when the bundle
// has one), found beside the app or in `DEVHUB_WHISPER_DIR`.

import AppKit
import AVFoundation
import DevHubCore

@MainActor
final class DictationController {
    enum Phase: Equatable {
        case idle, starting, recording, transcribing
    }

    private(set) var phase: Phase = .idle
    private(set) var level: Double = 0
    private(set) var tentative = ""
    private(set) weak var target: NSTextView?
    private var anchor: DictationText.Anchor?
    private var stream: DictationStream?
    private var session = 0
    private var delivered = 0
    private var engine: AVAudioEngine?
    private var monitor: Any?
    private let hud = DictationPanel()
    private var transcriber: (any Transcriber)?
    private var warmedAt = -Double.infinity
    private var style: ShellStyle
    /// A failure, said where the application says them.
    var onFailure: ((AppError) -> Void)?

    static let languageKey = "devhub.voice.language"

    var language: VoiceLanguage {
        get { VoiceLanguage.saved(UserDefaults.standard.string(forKey: Self.languageKey)) }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: Self.languageKey) }
    }

    init(style: ShellStyle) {
        self.style = style
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                if let server = self?.transcriber as? WhisperServer { Task { await server.stop() } }
            }
        }
    }

    func restyle(_ style: ShellStyle) {
        self.style = style
        hud.restyle(style)
    }

    /// `voice.status`: where the recogniser is, or why there is none.
    static func install() -> WhisperInstall? {
        let resources = Bundle.main.resourcePath
        let beside = Bundle.main.bundleURL.pathExtension == "app" ? nil : (Bundle.main.executablePath as NSString?)?.deletingLastPathComponent
        var candidates = Whisper.candidates(resources: resources, environment: ProcessInfo.processInfo.environment)
        if let beside { candidates.append((beside as NSString).appendingPathComponent("whisper")) }
        return Whisper.locate(candidates)
    }

    static let noRecogniser =
        "This build of DevHub has no speech recogniser: devhub-whisper and its model were not found in dist/whisper. Run python3 scripts/build_whisper.py (or set DEVHUB_WHISPER_DIR), then restart DevHub."
    static let microphoneRefused =
        "DevHub may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone."

    /// ⌘⇧M anywhere in DevHub's windows, and Escape while recording.
    func installKeys() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            nonisolated(unsafe) let incoming = event
            nonisolated(unsafe) var outgoing: NSEvent? = event
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.handle(incoming) { outgoing = nil }
            }
            return outgoing
        }
    }

    private func handle(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
        // `KeyM` by its key code, so a layout or an input method cannot move it.
        if event.keyCode == 0x2E, flags == [.command, .shift] {
            toggle(in: event.window)
            return true
        }
        if event.keyCode == 0x35, flags.isEmpty, phase == .recording {
            if let target, target.hasMarkedText() { return false }
            cancel()
            return true
        }
        return false
    }

    // MARK: Starting and stopping

    func toggle(in window: NSWindow?) {
        switch phase {
        case .idle:
            guard let view = window?.firstResponder as? NSTextView, view.isEditable else {
                NSSound.beep()
                return
            }
            target = view
            Task { await start() }
        case .recording:
            finish()
        case .starting, .transcribing:
            return
        }
    }

    /// Warm the recogniser before the first words, at most once a minute.
    func warm() {
        let now = Date().timeIntervalSince1970
        guard now - warmedAt >= 60, let server = recogniser() as? WhisperServer else { return }
        warmedAt = now
        Task { try? await server.warm() }
    }

    private func recogniser() -> (any Transcriber)? {
        if let transcriber { return transcriber }
        guard let install = Self.install() else { return nil }
        let made: any Transcriber = install.server != nil ? WhisperServer(install) : WhisperCLI(install)
        transcriber = made
        return made
    }

    private func fail(_ title: String, _ detail: String, microphone: Bool) {
        phase = .idle
        tentative = ""
        hud.hide()
        var error = AppError.at(.nativeUnavailable).withSummary(title).withDetail(detail)
        error.actions = microphone ? [.openMicrophoneSettings] : []
        onFailure?(error)
    }

    private func start() async {
        guard let recogniser = recogniser() else {
            return fail(DictationText.voiceFailedTitle, Self.noRecogniser, microphone: false)
        }
        phase = .starting
        warm()
        // `requestMicrophone`: asked once; refused is said with the way to allow it.
        let allowed: Bool
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: allowed = true
        case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .audio)
        default: allowed = false
        }
        guard allowed else {
            return fail(DictationText.microphoneDeniedTitle, Self.microphoneRefused, microphone: true)
        }
        session += 1
        let mine = session
        delivered = 0
        tentative = ""
        if let target {
            let range = target.selectedRange()
            anchor = DictationText.Anchor(start: range.location, end: range.location + range.length, text: target.string)
        }
        let stream = DictationStream(transcriber: recogniser, language: language) { [weak self] update in
            Task { @MainActor in self?.updated(update, session: mine) }
        }
        self.stream = stream
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            self.stream = nil
            return fail(DictationText.voiceFailedTitle, "The microphone could not be opened: it reports no audio format.", microphone: false)
        }
        let feeder = AudioFeeder(stream: stream, sampleRate: format.sampleRate) { [weak self] level, full in
            Task { @MainActor in
                guard let self, self.session == mine else { return }
                self.level = level
                self.hud.show(level: level, tentative: self.tentative, language: self.language, phase: self.phase, below: self.target)
                if full { self.finish() }
            }
        }
        // Called on the audio thread: nothing of the main actor's in it.
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { @Sendable buffer, _ in
            feeder.feed(buffer)
        }
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            self.stream = nil
            let denied = AVCaptureDevice.authorizationStatus(for: .audio) != .authorized
            return fail(
                denied ? DictationText.microphoneDeniedTitle : DictationText.voiceFailedTitle,
                denied
                    ? "The microphone could not be opened: \(error.localizedDescription). Allow DevHub in System Settings → Privacy & Security → Microphone, then try again."
                    : "The microphone could not be opened: \(error.localizedDescription)",
                microphone: denied)
        }
        self.engine = engine
        phase = .recording
        hud.show(level: 0, tentative: "", language: language, phase: phase, below: target)
    }

    private func release() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        level = 0
    }

    /// Stop recording, and put in what is left once it is recognised.
    func finish() {
        guard phase == .recording, let stream else { return }
        release()
        phase = .transcribing
        hud.show(level: 0, tentative: tentative, language: language, phase: phase, below: target)
        let mine = session
        Task { @MainActor [weak self] in
            do {
                let committed = try await stream.finish()
                guard let self, self.session == mine else { return }
                self.deliver(committed)
                self.done()
            } catch {
                guard let self, self.session == mine else { return }
                self.done()
                self.fail(DictationText.voiceFailedTitle, SpokenFailure.said(error), microphone: false)
            }
        }
    }

    /// Escape: what is not in yet is thrown away.
    func cancel() {
        guard phase == .recording || phase == .starting else { return }
        release()
        let stream = self.stream
        Task { await stream?.cancel() }
        session += 1
        done()
    }

    private func done() {
        phase = .idle
        tentative = ""
        stream = nil
        anchor = nil
        hud.hide()
    }

    // MARK: The words

    private func updated(_ update: VoiceUpdate, session mine: Int) {
        guard session == mine else { return }
        deliver(update.committed)
        tentative = update.tentative
        hud.show(level: level, tentative: tentative, language: language, phase: phase, below: target)
    }

    /// What has been committed since the last delivery, into the text.
    private func deliver(_ committed: String) {
        let units = Array(committed.utf16)
        guard units.count > delivered else { return }
        let fresh = String(decoding: units[delivered...], as: UTF16.self).trimmingCharacters(in: .whitespaces)
        delivered = units.count
        guard !fresh.isEmpty, let target else { return }
        let text = target.string
        let at = anchor ?? {
            let range = target.selectedRange()
            return DictationText.Anchor(start: range.location, end: range.location + range.length, text: text)
        }()
        let length = text.utf16.count
        let start = min(length, DictationText.shiftAnchor(at.text, text, at.start))
        let end = max(start, min(length, DictationText.shiftAnchor(at.text, text, at.end)))
        let placed = DictationText.insert(text, start: start, end: end, words: fresh)
        let inserted = String(decoding: Array(placed.text.utf16)[start..<placed.caret], as: UTF16.self)
        let range = NSRange(location: start, length: end - start)
        if target.shouldChangeText(in: range, replacementString: inserted) {
            target.textStorage?.replaceCharacters(in: range, with: inserted)
            target.didChangeText()
        }
        target.setSelectedRange(NSRange(location: placed.caret, length: 0))
        target.scrollRangeToVisible(NSRange(location: placed.caret, length: 0))
        anchor = DictationText.Anchor(start: placed.caret, end: placed.caret, text: target.string)
    }
}

/// The audio thread's side: downsample, convert, send every quarter second.
final class AudioFeeder: @unchecked Sendable {
    private let lock = NSLock()
    private var downsampler: StreamingDownsampler
    private var pending: [Float] = []
    private var sent = 0
    private let stream: DictationStream
    private let report: @Sendable (Double, Bool) -> Void
    private static let sendEvery = VoiceAudio.sampleRate / 4
    private static let limit = VoiceAudio.maxSeconds * VoiceAudio.sampleRate

    init(stream: DictationStream, sampleRate: Double, report: @escaping @Sendable (Double, Bool) -> Void) {
        self.stream = stream
        downsampler = StreamingDownsampler(from: sampleRate)
        self.report = report
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let chunk = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
        let level = VoiceAudio.level(chunk)
        var out: [UInt8]?
        var full = false
        lock.withLock {
            pending += downsampler.push(chunk)
            if pending.count >= Self.sendEvery {
                out = VoiceAudio.pcm16(pending)
                sent += pending.count
                pending = []
            }
            full = sent + pending.count >= Self.limit
        }
        if let out {
            let stream = self.stream
            Task { await stream.push(out) }
        }
        report(level, full)
    }
}

/// The tentative words and the level, in a small panel under the text.
@MainActor
final class DictationPanel {
    private var panel: NSPanel?
    private let label = NSTextField(labelWithString: "")
    private let meter = LevelMeterView()
    private var style: ShellStyle?

    func restyle(_ style: ShellStyle) { self.style = style }

    func show(level: Double, tentative: String, language: VoiceLanguage, phase: DictationController.Phase, below view: NSView?) {
        guard let view, let window = view.window else { return hide() }
        let panel = self.panel ?? make()
        meter.level = level
        meter.recording = phase == .recording
        let words: String
        switch phase {
        case .recording: words = tentative.isEmpty ? "Listening (\(language.label))… \(DictationText.key) stops, Esc discards" : tentative
        case .transcribing: words = tentative.isEmpty ? "Finishing the last words on this Mac…" : tentative
        default: words = "Opening the microphone…"
        }
        label.stringValue = words
        let width: CGFloat = min(480, max(220, ceil(label.intrinsicContentSize.width) + 44))
        let rect = view.convert(view.visibleRect, to: nil)
        let screen = window.convertToScreen(rect)
        panel.setFrame(NSRect(x: screen.minX, y: screen.minY - 30, width: width, height: 26), display: true)
        if panel.parent == nil { window.addChildWindow(panel, ordered: .above) }
        panel.orderFront(nil)
    }

    func hide() {
        guard let panel else { return }
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
    }

    private func make() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 240, height: 26), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.hasShadow = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.ignoresMouseEvents = true
        let content = NSVisualEffectView()
        content.material = .hudWindow
        content.state = .active
        content.wantsLayer = true
        content.layer?.cornerRadius = 8
        content.layer?.masksToBounds = true
        meter.frame = NSRect(x: 10, y: 8, width: 10, height: 10)
        meter.autoresizingMask = [.maxXMargin]
        label.font = ShellStyle.font(12)
        label.lineBreakMode = .byTruncatingHead
        label.frame = NSRect(x: 28, y: 4, width: 200, height: 18)
        label.autoresizingMask = [.width]
        content.addSubview(meter)
        content.addSubview(label)
        panel.contentView = content
        self.panel = panel
        return panel
    }
}

/// `--dictation-level`: a dot that swells with the voice.
@MainActor
final class LevelMeterView: NSView {
    var level: Double = 0 { didSet { needsDisplay = true } }
    var recording = false { didSet { needsDisplay = true } }
    override func draw(_ dirtyRect: NSRect) {
        let scale = 0.5 + 0.5 * min(1, level * 6)
        let side = bounds.width * CGFloat(scale)
        let dot = NSRect(x: bounds.midX - side / 2, y: bounds.midY - side / 2, width: side, height: side)
        (recording ? NSColor.systemRed : NSColor.tertiaryLabelColor).setFill()
        NSBezierPath(ovalIn: dot).fill()
    }
}
