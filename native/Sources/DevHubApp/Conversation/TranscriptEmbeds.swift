// The views drawn inside the transcript's text: what a paragraph cannot be.
//
// Each embed is an attachment character whose view TextKit 2 places in the
// line (`EmbedAttachment`, `NSTextAttachmentViewProvider`). The transcript
// keeps one attachment per embed key across renders (`TranscriptEmbeds`), so
// an embed's view — a code block's scroll, a request card's half-written
// answer, a "Copied" on a button — outlives the deltas that re-render the
// entry it is in. A view that changes its height says so, and the transcript
// lays its line out again.

import AppKit
import DevHubCore

/// What an embed asks of the surface it is in.
@MainActor
protocol EmbedHost: AnyObject {
    func performAction(_ action: DocAction)
    func follow(_ link: DocLink)
    func copyToPasteboard(_ text: String) -> Bool
    func answer(_ request: PendingRequest, _ answer: RequestAnswer) async -> Bool
    func instruct(_ subagent: EntryId, _ text: String) async -> Bool
    func focusComposer()
    func activityText() -> (label: String, meta: String, phase: String)?
    func embedResized(_ key: String)
}

/// A view drawn in the text: its height for a width, and its content kept current.
@MainActor
protocol EmbedContent: NSView {
    func height(forWidth width: CGFloat) -> CGFloat
    func update(_ kind: DocEmbedKind, style: ConversationStyle)
}

final class EmbedAttachment: NSTextAttachment {
    nonisolated(unsafe) var key: String
    nonisolated(unsafe) private(set) var kind: DocEmbedKind
    nonisolated(unsafe) var content: any EmbedContent
    /// The paragraph's indents, from the container's edges.
    nonisolated(unsafe) var insets: (left: CGFloat, right: CGFloat) = (0, 0)
    /// A fixed size (an inline mark), instead of the column's width.
    nonisolated(unsafe) var fixed: CGSize?
    nonisolated(unsafe) var baseline: CGFloat = 0

    @MainActor
    init(key: String, kind: DocEmbedKind, content: any EmbedContent) {
        self.key = key
        self.kind = kind
        self.content = content
        super.init(data: nil, ofType: nil)
        allowsTextAttachmentView = true
        // Not the placeholder page TextKit draws for an attachment with no image.
        image = Self.clear
    }

    nonisolated(unsafe) static let clear: NSImage = {
        let image = NSImage(size: NSSize(width: 1, height: 1))
        return image
    }()

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    @MainActor
    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.kind = kind
        content.update(kind, style: style)
    }

    override func viewProvider(for parentView: NSView?, location: any NSTextLocation, textContainer: NSTextContainer?) -> NSTextAttachmentViewProvider? {
        nonisolated(unsafe) var provider: NSTextAttachmentViewProvider?
        nonisolated(unsafe) let parent = parentView, container = textContainer, at = location, attachment = self
        MainActor.assumeIsolated {
            let made = EmbedViewProvider(textAttachment: attachment, parentView: parent, textLayoutManager: container?.textLayoutManager, location: at)
            made.tracksTextAttachmentViewBounds = true
            provider = made
        }
        return provider
    }

    @MainActor
    func size(in container: NSTextContainer?) -> CGSize {
        if let fixed { return fixed }
        let width = max(40, (container?.size.width ?? 600) - 2 * (container?.lineFragmentPadding ?? 0) - insets.left - insets.right)
        return CGSize(width: width, height: ceil(content.height(forWidth: width)))
    }
}

final class EmbedViewProvider: NSTextAttachmentViewProvider {
    override func loadView() {
        nonisolated(unsafe) let provider = self
        MainActor.assumeIsolated {
            guard let attachment = provider.textAttachment as? EmbedAttachment else { return }
            provider.view = attachment.content
        }
    }

    override func attachmentBounds(
        for attributes: [NSAttributedString.Key: Any], location: any NSTextLocation, textContainer: NSTextContainer?,
        proposedLineFragment: CGRect, position: CGPoint
    ) -> CGRect {
        nonisolated(unsafe) let provider = self, container = textContainer
        return MainActor.assumeIsolated {
            guard let attachment = provider.textAttachment as? EmbedAttachment else { return CGRect.zero }
            let size = attachment.size(in: container)
            return CGRect(x: 0, y: attachment.baseline, width: size.width, height: size.height)
        }
    }
}

// MARK: - The store

@MainActor
final class TranscriptEmbeds: EmbedStore {
    weak var host: EmbedHost?
    private var attachments: [String: EmbedAttachment] = [:]
    private var used: Set<String> = []
    private var marks: [String: NSTextAttachment] = [:]

    func attachment(for embed: DocEmbed, style: ConversationStyle) -> NSTextAttachment {
        used.insert(embed.key)
        if let kept = attachments[embed.key], Self.sameView(kept.kind, embed.kind) {
            if kept.kind != embed.kind { kept.update(embed.kind, style: style) }
            return kept
        }
        let content = makeContent(embed, style: style)
        let made = EmbedAttachment(key: embed.key, kind: embed.kind, content: content)
        content.update(embed.kind, style: style)
        attachments[embed.key] = made
        return made
    }

    /// Whether an embed of `new` can be drawn by the view made for `old`.
    static func sameView(_ old: DocEmbedKind, _ new: DocEmbedKind) -> Bool {
        switch (old, new) {
        case (.code, .code), (.table, .table), (.math, .math), (.images, .images), (.remoteImage, .remoteImage), (.activity, .activity),
             (.rule, .rule), (.actions, .actions), (.confirm, .confirm), (.subagentActions, .subagentActions):
            return true
        case let (.request(a), .request(b)): return a.id == b.id
        case let (.subagentMessage(a, _), .subagentMessage(b, _)): return a == b
        default: return false
        }
    }

    /// An embed of a section kept as it was is still in use.
    @discardableResult
    func markUsed(_ key: String) -> Bool { used.insert(key).inserted }

    /// The renders of a whole transcript are in: what they did not use goes.
    func beginRender() { used = [] }
    func endRender() {
        for key in attachments.keys where !used.contains(key) { attachments[key] = nil }
    }

    /// Restyle every view kept (a change of appearance or size).
    func restyle(_ style: ConversationStyle) {
        marks = [:]
        for attachment in attachments.values { attachment.content.update(attachment.kind, style: style) }
    }

    func view(for key: String) -> EmbedContent? { attachments[key]?.content }

    var requestCards: [RequestCardView] { attachments.values.compactMap { $0.content as? RequestCardView } }

    private func makeContent(_ embed: DocEmbed, style: ConversationStyle) -> EmbedContent {
        let resized: () -> Void = { [weak self, key = embed.key] in self?.host?.embedResized(key) }
        switch embed.kind {
        case .code: return CodeBlockView(style: style, host: host, resized: resized)
        case .table: return TableEmbedView(style: style, host: host)
        case .math: return MathEmbedView(style: style)
        case .request(let request): return RequestCardView(request: request, style: style, host: host, resized: resized)
        case .images: return ImageStripView(style: style, resized: resized)
        case .remoteImage: return RemoteImageView(style: style, resized: resized)
        case .activity: return ActivityLineView(style: style, host: host)
        case .subagentMessage: return SubagentMessageView(style: style, host: host)
        case .rule: return RuleEmbedView(style: style)
        case .actions: return ActionsEmbedView(style: style, host: host)
        case .confirm: return ConfirmEmbedView(style: style, host: host, resized: resized)
        case .subagentActions: return SubagentActionsView(style: style, host: host)
        }
    }

    // MARK: Inline marks

    func inline(_ inline: DocInline, size: CGFloat, color: NSColor, style: ConversationStyle) -> NSTextAttachment {
        switch inline {
        case .status(.running):
            let view = SpinnerMark(style: style, side: size)
            let made = EmbedAttachment(key: "spinner", kind: .rule, content: view)
            made.fixed = CGSize(width: size, height: size)
            made.baseline = -(size - style.body.capHeight * size / style.fontSize) / 2
            return made
        case .streamingDot:
            let side = size * 0.55
            let view = PulseMark(style: style, side: side)
            let made = EmbedAttachment(key: "dot", kind: .rule, content: view)
            made.fixed = CGSize(width: side + size * 0.3, height: side)
            made.baseline = size * 0.05
            return made
        default:
            break
        }
        let key = "\(inline)|\(size)|\(color.description)|\(style.dark)"
        if let kept = marks[key] { return kept }
        let drawn = InlineMarks.image(inline, size: size, color: color, style: style)
        let attachment = NSTextAttachment()
        attachment.image = drawn.image
        attachment.bounds = CGRect(x: 0, y: drawn.baseline, width: drawn.image.size.width, height: drawn.image.size.height)
        marks[key] = attachment
        return attachment
    }
}

// MARK: - Inline marks

@MainActor
enum InlineMarks {

    /// An image drawn now, in a flipped context at twice its size (a mark in the text).
    static func drawn(_ size: NSSize, _ draw: (NSRect) -> Void) -> NSImage {
        let scale: CGFloat = 2
        let width = max(1, Int(ceil(size.width * scale))), height = max(1, Int(ceil(size.height * scale)))
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return NSImage(size: size) }
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: scale, y: -scale)
        let graphics = NSGraphicsContext(cgContext: context, flipped: true)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        draw(NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        guard let image = context.makeImage() else { return NSImage(size: size) }
        return NSImage(cgImage: image, size: size)
    }
    static func image(_ inline: DocInline, size: CGFloat, color: NSColor, style: ConversationStyle) -> (image: NSImage, baseline: CGFloat) {
        let capMiddle = style.body.capHeight * size / style.fontSize / 2
        func centred(_ side: CGFloat) -> CGFloat { capMiddle - side / 2 }
        switch inline {
        case .status(let state):
            let (glyph, ink): (String, NSColor) = {
                switch state {
                case .succeeded: return ("✓", style.ink(.statusIdle))
                case .failed, .denied: return ("✕", style.ink(.statusError))
                case .interrupted: return ("–", style.tokens.waiting.nsColor)
                case .idle: return ("◦", style.ink(.statusIdle))
                case .unknown: return ("?", style.ink(.tertiary))
                case .running: return ("•", style.ink(.tertiary))
                }
            }()
            return (text(glyph, size: size, ink: ink, box: size, style: style), centred(size))
        case .checklist(let status):
            let side = 0.8 * size
            let image = drawn(NSSize(width: side, height: side)) { rect in
                let box = rect.insetBy(dx: 0.75, dy: 0.75)
                let path = NSBezierPath(roundedRect: box, xRadius: 3, yRadius: 3)
                path.lineWidth = 1.5
                switch status {
                case .pending:
                    style.ink(.tertiary).setStroke()
                case .inProgress:
                    style.ink(.statusWorking).setFill()
                    NSBezierPath(rect: NSRect(x: box.minX, y: box.minY, width: box.width / 2, height: box.height)).fill()
                    style.ink(.statusWorking).setStroke()
                case .completed:
                    style.ink(.statusIdle).setFill()
                    path.fill()
                    style.ink(.statusIdle).setStroke()
                }
                path.stroke()
            }
            return (image, centred(side) - 0.1 * size)
        case .checkbox(let checked):
            let side = 0.9 * size
            let image = drawn(NSSize(width: side, height: side)) { rect in
                let box = rect.insetBy(dx: 0.75, dy: 0.75)
                let path = NSBezierPath(roundedRect: box, xRadius: 3, yRadius: 3)
                path.lineWidth = 1
                if checked {
                    style.tokens.accent.nsColor.setFill()
                    path.fill()
                    GlyphPainter.draw(ConversationIcons.drawing(.check), in: box.insetBy(dx: 1, dy: 1), color: .white, stroke: 2)
                } else {
                    style.line.setStroke()
                    style.surface.setFill()
                    path.fill()
                    path.stroke()
                }
            }
            return (image, centred(side))
        case let .optionMark(_, picked):
            return (text(picked ? "✓" : "", size: size, ink: style.tokens.accent.nsColor, box: size * 1.1, style: style), centred(size))
        case .icon(let icon):
            let image = drawn(NSSize(width: size, height: size)) { rect in
                GlyphPainter.draw(ConversationIcons.drawing(icon), in: rect, color: color, stroke: ConversationIcons.stroke)
            }
            return (image, centred(size))
        case let .chevron(open, _):
            let side = size * 0.9
            let image = drawn(NSSize(width: side, height: side)) { rect in
                GlyphPainter.draw(ConversationIcons.drawing(open ? .chevronDown : .chevronRight), in: rect, color: color, stroke: ConversationIcons.stroke)
            }
            return (image, centred(side))
        case .math(let tex):
            let font = style.mono(size * 0.92, italic: true)
            return (text(tex, size: size * 0.92, ink: color, box: nil, style: style, font: font), style.body.descender * size / style.fontSize)
        case .background:
            let image = drawn(NSSize(width: size, height: size)) { rect in
                GlyphPainter.draw(ConversationIcons.drawing(.clock), in: rect, color: color, stroke: ConversationIcons.stroke)
            }
            return (image, centred(size))
        case .streamingDot:
            return (NSImage(size: NSSize(width: 1, height: 1)), 0)
        }
    }

    /// A glyph in a box (`box` square), or text at its natural width.
    static func text(_ glyph: String, size: CGFloat, ink: NSColor, box: CGFloat?, style: ConversationStyle, font: NSFont? = nil) -> NSImage {
        let face = font ?? style.sans(size)
        let attributes: [NSAttributedString.Key: Any] = [.font: face, .foregroundColor: ink]
        let natural = (glyph as NSString).size(withAttributes: attributes)
        let canvas = box.map { NSSize(width: $0, height: $0) } ?? NSSize(width: ceil(natural.width), height: ceil(natural.height))
        return drawn(canvas) { rect in
            (glyph as NSString).draw(
                at: NSPoint(x: (rect.width - natural.width) / 2, y: (rect.height - natural.height) / 2), withAttributes: attributes)
        }
    }
}

/// The running mark: a ring with a bright arc, turning.
@MainActor
final class SpinnerMark: NSView, EmbedContent {
    private var style: ConversationStyle
    private let side: CGFloat
    private var timer: Timer?
    private var angle: CGFloat = 0

    init(style: ConversationStyle, side: CGFloat) {
        self.style = style
        self.side = side
        super.init(frame: NSRect(x: 0, y: 0, width: side, height: side))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func height(forWidth width: CGFloat) -> CGFloat { side }
    func update(_ kind: DocEmbedKind, style: ConversationStyle) { self.style = style; needsDisplay = true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate()
        timer = nil
        guard window != nil, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let made = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.angle += .pi * 2 / (0.8 * 30)
                self.needsDisplay = true
            }
        }
        RunLoop.main.add(made, forMode: .common)
        timer = made
    }

    override func draw(_ dirtyRect: NSRect) {
        let ring = 0.7 * side
        let rect = NSRect(x: (bounds.width - ring) / 2, y: (bounds.height - ring) / 2, width: ring, height: ring).insetBy(dx: 0.75, dy: 0.75)
        let working = style.tokens.statusWorking
        let whole = NSBezierPath(ovalIn: rect)
        whole.lineWidth = 1.5
        working.faded(0.3).setStroke()
        whole.stroke()
        let arc = NSBezierPath()
        let centre = NSPoint(x: rect.midX, y: rect.midY)
        let start = angle * 180 / .pi
        arc.appendArc(withCenter: centre, radius: rect.width / 2, startAngle: start, endAngle: start + 90)
        arc.lineWidth = 1.5
        working.nsColor.setStroke()
        arc.stroke()
    }
}

/// The streaming caret: a dot that pulses.
@MainActor
final class PulseMark: NSView, EmbedContent {
    private var style: ConversationStyle
    private let side: CGFloat
    private var timer: Timer?
    private var phase: CGFloat = 0

    init(style: ConversationStyle, side: CGFloat) {
        self.style = style
        self.side = side
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    func height(forWidth width: CGFloat) -> CGFloat { side }
    func update(_ kind: DocEmbedKind, style: ConversationStyle) { self.style = style; needsDisplay = true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate()
        timer = nil
        guard window != nil else { return }
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if reduce { return }
        let made = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.phase += 1.0 / (1.1 * 30)
                if self.phase > 1 { self.phase -= 1 }
                self.needsDisplay = true
            }
        }
        RunLoop.main.add(made, forMode: .common)
        timer = made
    }

    override func draw(_ dirtyRect: NSRect) {
        // 0.25 → 1 → 0.25 over 1.1s, eased.
        let wave = (1 - cos(phase * 2 * .pi)) / 2
        let alpha = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 1 : 0.25 + 0.75 * wave
        style.ink(.primary).withAlphaComponent(alpha).setFill()
        let x = bounds.width - side
        NSBezierPath(ovalIn: NSRect(x: x, y: (bounds.height - side) / 2, width: side, height: side)).fill()
    }
}

// MARK: - Simple embeds

/// A thematic break: a hairline across the column.
@MainActor
final class RuleEmbedView: NSView, EmbedContent {
    private var style: ConversationStyle
    init(style: ConversationStyle) {
        self.style = style
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    func height(forWidth width: CGFloat) -> CGFloat { 1 }
    func update(_ kind: DocEmbedKind, style: ConversationStyle) { self.style = style; needsDisplay = true }
    override func draw(_ dirtyRect: NSRect) {
        style.lineSoft.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
    }
}

/// `$$…$$`: the TeX, centred, in the monospace face (no typesetter is drawn natively).
@MainActor
final class MathEmbedView: NSView, EmbedContent {
    private var style: ConversationStyle
    private var tex = ""

    init(style: ConversationStyle) {
        self.style = style
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    private var attributed: NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        return NSAttributedString(string: tex, attributes: [
            .font: style.mono(style.em(0.95), italic: true), .foregroundColor: style.ink(.primary), .paragraphStyle: paragraph,
        ])
    }

    func height(forWidth width: CGFloat) -> CGFloat {
        ceil(attributed.boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height) + 4
    }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        if case .math(let value) = kind { tex = value }
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel(tex)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        attributed.draw(with: NSRect(x: 0, y: 2, width: bounds.width, height: bounds.height - 2), options: [.usesLineFragmentOrigin])
    }
}

/// A message's quiet row of actions: Copy, Rewind, Show all.
@MainActor
final class ActionsEmbedView: NSView, EmbedContent {
    private var style: ConversationStyle
    private weak var host: EmbedHost?
    private let row = FlowRow()
    private var buttons: [DocActionButton] = []
    private var hideWhileStreaming = false
    private var copiedTimer: Timer?

    init(style: ConversationStyle, host: EmbedHost?) {
        self.style = style
        self.host = host
        super.init(frame: .zero)
        addSubview(row)
        row.spacing = 2
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func height(forWidth width: CGFloat) -> CGFloat { max(style.em(1.7), row.height(forWidth: width)) }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        guard case let .actions(buttons, align, hide) = kind else { return }
        hideWhileStreaming = hide
        row.align = align
        isHidden = hide
        if buttons == self.buttons, row.items.count == buttons.count {
            for case let button as ConversationButton in row.items { button.style = style; button.size = style.em(0.8) }
            return
        }
        self.buttons = buttons
        row.items = buttons.map { spec in
            let button = ConversationButton(label: spec.label, icon: spec.icon, look: .quiet, size: style.em(0.8), style: style)
            button.toolTip = spec.tooltip
            if let accessibility = spec.accessibility { button.setAccessibilityLabel(accessibility) }
            button.onPress = { [weak self, weak button] in
                guard let self, let button else { return }
                if case .copy(_, let text) = spec.action {
                    if self.host?.copyToPasteboard(text) == true { self.markCopied(button) }
                } else {
                    self.host?.performAction(spec.action)
                }
            }
            return button
        }
        alphaValue = 0.7
    }

    private func markCopied(_ button: ConversationButton) {
        button.isDone = true
        copiedTimer?.invalidate()
        copiedTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak button] _ in
            MainActor.assumeIsolated { button?.isDone = false }
        }
    }

    /// The message is pointed at: the row at full strength.
    func setEmphasised(_ on: Bool) { alphaValue = on ? 1 : 0.7 }

    override func layout() {
        super.layout()
        let height = row.height(forWidth: bounds.width)
        row.frame = NSRect(x: 0, y: (bounds.height - height) / 2, width: bounds.width, height: height)
    }
}

/// The confirmation under a message: the note, Rewind, Cancel.
@MainActor
final class ConfirmEmbedView: NSView, EmbedContent {
    private var style: ConversationStyle
    private weak var host: EmbedHost?
    private let note = NSTextField(wrappingLabelWithString: "")
    private var go: ConversationButton?
    private var cancel: ConversationButton?
    private let resized: () -> Void
    /// Instead of the host's actions (a background task's Stop).
    var onGo: (() -> Void)?
    var onCancel: (() -> Void)?

    init(style: ConversationStyle, host: EmbedHost?, resized: @escaping () -> Void) {
        self.style = style
        self.host = host
        self.resized = resized
        super.init(frame: .zero)
        note.isSelectable = false
        addSubview(note)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Rewind to here")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    private var buttonsWidth: CGFloat { (go?.intrinsicContentSize.width ?? 0) + (cancel?.intrinsicContentSize.width ?? 0) + style.px(8) * 2 }

    func height(forWidth width: CGFloat) -> CGFloat {
        let noteWidth = max(120, width - buttonsWidth)
        let text = note.attributedStringValue.boundingRect(with: NSSize(width: noteWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height
        return style.px(4) + max(ceil(text), go?.intrinsicContentSize.height ?? 20)
    }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        guard case let .confirm(words, goSpec, cancelSpec) = kind else { return }
        note.font = style.sans(style.em(0.85))
        note.textColor = style.ink(.secondary)
        note.stringValue = words
        go?.removeFromSuperview()
        cancel?.removeFromSuperview()
        let size = style.em(0.85)
        let goButton = ConversationButton(label: goSpec.label, look: .bordered, size: size, style: style) { [weak self] in
            if let go = self?.onGo { go() } else { self?.host?.performAction(goSpec.action) }
        }
        let cancelButton = ConversationButton(label: cancelSpec.label, look: .bordered, size: size, style: style) { [weak self] in
            if let cancel = self?.onCancel { cancel() } else { self?.host?.performAction(cancelSpec.action) }
        }
        addSubview(goButton)
        addSubview(cancelButton)
        go = goButton
        cancel = cancelButton
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let top = style.px(4)
        var x = bounds.width
        for button in [cancel, go].compactMap({ $0 }) {
            let size = button.intrinsicContentSize
            x -= size.width
            button.frame = NSRect(x: x, y: top, width: size.width, height: size.height)
            x -= style.px(8)
        }
        note.frame = NSRect(x: 0, y: top + 2, width: max(0, x), height: bounds.height - top)
    }
}

/// A subagent card's actions: beside the conversation, and maximize.
@MainActor
final class SubagentActionsView: NSView, EmbedContent {
    private var style: ConversationStyle
    private weak var host: EmbedHost?
    private let row = FlowRow()

    init(style: ConversationStyle, host: EmbedHost?) {
        self.style = style
        self.host = host
        super.init(frame: .zero)
        row.align = .trailing
        addSubview(row)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func height(forWidth width: CGFloat) -> CGFloat { row.items.isEmpty ? 0 : row.height(forWidth: width) + 2 }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        guard case let .subagentActions(entry, label, canBeside, beside, canMaximize) = kind else { return }
        var items: [NSView] = []
        if canBeside {
            let button = ConversationButton(label: "", icon: .column, look: .icon, size: style.fontSize, style: style) { [weak self] in
                self?.host?.performAction(.setBeside(entry, !beside))
            }
            button.isOn = beside
            button.setAccessibilityLabel("Show \(label) beside the conversation")
            button.toolTip = beside ? "Beside the conversation: press to put it back here" : "Show beside the conversation"
            items.append(button)
        }
        if canMaximize {
            let button = ConversationButton(label: "", icon: .maximize, look: .icon, size: style.fontSize, style: style) { [weak self] in
                self?.host?.performAction(.maximize(entry))
            }
            button.setAccessibilityLabel("Maximize \(label)")
            button.toolTip = "Fill the pane with this subagent"
            items.append(button)
        }
        row.items = items
        needsLayout = true
    }

    override func layout() {
        super.layout()
        row.frame = NSRect(x: 0, y: 2, width: bounds.width, height: max(0, bounds.height - 2))
    }
}

/// The line under a running turn: dots, what the Agent is doing, how long, how much.
@MainActor
final class ActivityLineView: NSView, EmbedContent {
    private var style: ConversationStyle
    private weak var host: EmbedHost?
    private var timer: Timer?
    private var tick: CGFloat = 0

    init(style: ConversationStyle, host: EmbedHost?) {
        self.style = style
        self.host = host
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func height(forWidth width: CGFloat) -> CGFloat { ceil(style.em(0.9) * 1.6) }
    func update(_ kind: DocEmbedKind, style: ConversationStyle) { self.style = style; needsDisplay = true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate()
        timer = nil
        guard window != nil else { return }
        let made = Timer(timeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.tick += 1.0 / 20
                self.needsDisplay = true
            }
        }
        RunLoop.main.add(made, forMode: .common)
        timer = made
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let words = host?.activityText() else { return }
        setAccessibilityLabel(words.label)
        let size = style.em(0.9)
        let dot = size * 0.35
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let ink = words.phase == "permission" ? style.ink(.statusWaiting) : style.ink(.statusWorking)
        var x: CGFloat = 0
        let mid = bounds.height / 2
        for index in 0..<3 {
            let phase = (tick / 1.2 - CGFloat(index) * 0.15).truncatingRemainder(dividingBy: 1)
            let wave = reduce ? 1 : (1 - cos(max(0, phase) * 2 * .pi)) / 2
            ink.withAlphaComponent(0.3 + 0.7 * wave).setFill()
            NSBezierPath(ovalIn: NSRect(x: x, y: mid - dot / 2, width: dot, height: dot)).fill()
            x += dot + size * 0.2
        }
        x += style.px(8) - size * 0.2
        let label = NSAttributedString(string: words.label, attributes: [.font: style.sans(size), .foregroundColor: style.ink(.secondary)])
        let labelSize = label.size()
        label.draw(at: NSPoint(x: x, y: mid - labelSize.height / 2))
        x += labelSize.width + style.px(8)
        let meta = NSAttributedString(string: words.meta, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: size * 0.9, weight: .regular), .foregroundColor: style.ink(.tertiary),
        ])
        meta.draw(at: NSPoint(x: x, y: mid - meta.size().height / 2))
    }
}
