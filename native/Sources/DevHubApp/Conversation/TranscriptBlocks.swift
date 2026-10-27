// The embeds that are blocks of an answer or a call: a fenced code block
// (CodeBlock.tsx), a Markdown table, a row of images and an image the Agent
// linked (EntryParts.tsx `ImageView`, Markdown.tsx), and the box to message a
// subagent (SubagentMessage.tsx).

import AppKit
import DevHubCore

// MARK: - Code

/// A fenced block: its language and Copy over its lines, the lines kept whole
/// and scrolled sideways, coloured once the fence has closed.
@MainActor
final class CodeBlockView: NSView, EmbedContent {
    private var style: ConversationStyle
    private weak var host: EmbedHost?
    private let resized: () -> Void
    private let language = NSTextField(labelWithString: "")
    private var copyButton: ConversationButton!
    private let scroll = SidewaysScrollView()
    private let text = NSTextView()
    private var code = ""
    private var info: String?
    private var settled = false
    private var colouring: CodeColouring?
    private var copiedTimer: Timer?
    private var asked: String?

    init(style: ConversationStyle, host: EmbedHost?, resized: @escaping () -> Void) {
        self.style = style
        self.host = host
        self.resized = resized
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = CGFloat(DevHubTheme.Radius.panel)
        layer?.borderWidth = 1
        layer?.masksToBounds = true
        language.isSelectable = false
        addSubview(language)
        copyButton = ConversationButton(label: "Copy", icon: .copy, look: .quiet, size: style.em(0.8), style: style) { [weak self] in
            guard let self else { return }
            if self.host?.copyToPasteboard(self.code) == true {
                self.copyButton.isDone = true
                self.copiedTimer?.invalidate()
                self.copiedTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated { self?.copyButton.isDone = false }
                }
            }
        }
        copyButton.setAccessibilityLabel("Copy code")
        addSubview(copyButton)
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = false
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.horizontalScrollElasticity = .allowed
        scroll.verticalScrollElasticity = .none
        scroll.scrollerStyle = .overlay
        text.isEditable = false
        text.isSelectable = true
        text.drawsBackground = false
        text.isHorizontallyResizable = true
        text.isVerticallyResizable = false
        text.textContainer?.widthTracksTextView = false
        text.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.lineFragmentPadding = 0
        scroll.documentView = text
        addSubview(scroll)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    private var headerHeight: CGFloat { ceil(style.em(0.8) * 1.4) + 4 + 4 + 1 }
    private var padY: CGFloat { style.px(8) }
    private var padX: CGFloat { style.px(12) }
    private var lineHeight: CGFloat { ceil(style.em(0.88) * 1.5) }

    func height(forWidth width: CGFloat) -> CGFloat {
        let lines = max(1, code.components(separatedBy: "\n").count)
        let scroller: CGFloat = textWidth > width - 2 * padX ? 12 : 0
        return headerHeight + 2 * padY + CGFloat(lines) * lineHeight + scroller + 2
    }

    private var textWidth: CGFloat { text.textStorage.map { ceil($0.size().width) } ?? 0 }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        guard case let .code(info, code, settled) = kind else { return }
        let changed = code != self.code || info != self.info || settled != self.settled
        self.code = code
        self.info = info
        self.settled = settled
        layer?.backgroundColor = style.sunken.cgColor
        layer?.borderColor = style.lineSoft.cgColor
        language.font = style.mono(style.em(0.8))
        language.textColor = style.ink(.secondary)
        language.stringValue = info.flatMap { $0.split(separator: " ").first.map(String.init) } ?? ""
        copyButton.style = style
        copyButton.size = style.em(0.8)
        let grammar = settled ? CodeGrammar.of(info: info) : nil
        if let grammar {
            colouring = CodeHighlighter.shared.colouringOf(code, grammar)
            if colouring == nil, asked != code {
                asked = code
                let wanted = code
                Task.detached(priority: .userInitiated) {
                    let made = CodeHighlighter.shared.highlight(wanted, grammar)
                    await MainActor.run { [weak self] in
                        guard let self, self.code == wanted else { return }
                        self.colouring = made
                        self.fill()
                    }
                }
            }
        } else {
            colouring = nil
        }
        if changed || true { fill() }
        if changed { resized() }
    }

    private func fill() {
        let font = style.mono(style.em(0.88))
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        let tab = (" " as NSString).size(withAttributes: [.font: font]).width * 4
        paragraph.defaultTabInterval = tab
        paragraph.tabStops = []
        let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: style.ink(.primary), .paragraphStyle: paragraph]
        let out = NSMutableAttributedString()
        if let colouring {
            for (index, line) in colouring.enumerated() {
                for token in line {
                    var attributes = base
                    if let colour = style.code(light: token.light, dark: token.dark) { attributes[.foregroundColor] = colour }
                    out.append(NSAttributedString(string: token.text, attributes: attributes))
                }
                if index < colouring.count - 1 { out.append(NSAttributedString(string: "\n", attributes: base)) }
            }
        } else {
            out.append(NSAttributedString(string: code, attributes: base))
        }
        text.textStorage?.setAttributedString(out)
        text.selectedTextAttributes = [.backgroundColor: style.tokens.selection.nsColor]
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let header = headerHeight
        let languageSize = language.intrinsicContentSize
        language.frame = NSRect(x: padX, y: (header - languageSize.height) / 2, width: max(0, bounds.width - padX - 100), height: languageSize.height)
        let copySize = copyButton.intrinsicContentSize
        copyButton.frame = NSRect(x: bounds.width - copySize.width - style.px(4), y: (header - copySize.height) / 2, width: copySize.width, height: copySize.height)
        scroll.frame = NSRect(x: 0, y: header, width: bounds.width, height: max(0, bounds.height - header))
        let lines = max(1, code.components(separatedBy: "\n").count)
        let height = CGFloat(lines) * lineHeight + 2 * padY
        text.textContainerInset = NSSize(width: padX, height: padY)
        text.frame = NSRect(x: 0, y: 0, width: max(scroll.contentSize.width, textWidth + 2 * padX + 4), height: height)
        text.minSize = NSSize(width: scroll.contentSize.width, height: height)
    }

    override func draw(_ dirtyRect: NSRect) {
        style.wash.setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: headerHeight - 1).fill()
        style.lineSoft.setFill()
        NSRect(x: 0, y: headerHeight - 1, width: bounds.width, height: 1).fill()
    }

    /// The selection in the block, if any (a copyButton from inside it).
    var selectedText: String? {
        let range = text.selectedRange()
        guard range.length > 0 else { return nil }
        return (text.string as NSString).substring(with: range)
    }
}

/// A scroll that only goes sideways: a vertical scroll over it is the transcript's.
final class SidewaysScrollView: NSScrollView {
    override func scrollWheel(with event: NSEvent) {
        if abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX) {
            nextResponder?.scrollWheel(with: event)
        } else {
            super.scrollWheel(with: event)
        }
    }
}

// MARK: - Tables

/// A Markdown table: the header on the wash, rows under hairlines, cells that wrap.
@MainActor
final class TableEmbedView: NSView, EmbedContent {
    private var style: ConversationStyle
    private weak var host: EmbedHost?
    private var align: [MarkdownAlign?] = []
    private var rows: [[[DocRun]]] = []
    private var cells: [[NSAttributedString]] = []
    private var layoutCache: (width: CGFloat, columns: [CGFloat], heights: [CGFloat])?

    init(style: ConversationStyle, host: EmbedHost?) {
        self.style = style
        self.host = host
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = CGFloat(DevHubTheme.Radius.panel)
        layer?.borderWidth = 1
        layer?.masksToBounds = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    private var padX: CGFloat { style.em(0.95 * 0.8) }
    private var padY: CGFloat { style.em(0.95 * 0.4) }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        guard case let .table(align, rows) = kind else { return }
        self.align = align
        self.rows = rows
        layer?.borderColor = style.lineSoft.cgColor
        let renderer = TranscriptRenderer(style: style, width: 1000, embeds: NullEmbeds.shared)
        cells = rows.enumerated().map { index, row in
            row.enumerated().map { column, runs in
                let text = NSMutableAttributedString()
                for run in runs {
                    var run = run
                    run.style.size *= 0.95
                    if index == 0 { run.style.bold = true }
                    text.append(renderer.runText(run, inherited: nil))
                }
                let paragraph = NSMutableParagraphStyle()
                switch column < align.count ? align[column] : nil {
                case .center?: paragraph.alignment = .center
                case .right?: paragraph.alignment = .right
                default: paragraph.alignment = .left
                }
                paragraph.lineHeightMultiple = 1.2
                text.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: text.length))
                return text
            }
        }
        layoutCache = nil
        needsDisplay = true
        setAccessibilityElement(true)
        setAccessibilityRole(.table)
    }

    private func measure(_ width: CGFloat) -> (columns: [CGFloat], heights: [CGFloat]) {
        if let cache = layoutCache, cache.width == width { return (cache.columns, cache.heights) }
        let count = max(1, align.count)
        var natural = Array(repeating: CGFloat(0), count: count)
        for row in cells {
            for (column, cell) in row.enumerated() where column < count {
                natural[column] = max(natural[column], ceil(cell.size().width) + 2 * padX)
            }
        }
        let total = natural.reduce(0, +)
        var columns = natural
        if total > width {
            // Shared out as a browser's auto layout does: in proportion, none narrower than its padding and a word.
            let floor = 2 * padX + style.em(3)
            columns = natural.map { max(floor, $0 * width / max(total, 1)) }
        } else if total < width, total > 0 {
            columns = natural.map { $0 + ($0 / total) * (width - total) }
        }
        var heights: [CGFloat] = []
        for row in cells {
            var height: CGFloat = 0
            for (column, cell) in row.enumerated() where column < count {
                let inner = max(10, columns[column] - 2 * padX)
                height = max(height, ceil(cell.boundingRect(with: NSSize(width: inner, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading]).height))
            }
            heights.append(height + 2 * padY + 1)
        }
        layoutCache = (width, columns, heights)
        return (columns, heights)
    }

    func height(forWidth width: CGFloat) -> CGFloat {
        measure(width).heights.reduce(0, +) + 1
    }

    override func draw(_ dirtyRect: NSRect) {
        let (columns, heights) = measure(bounds.width)
        var y: CGFloat = 0
        for (index, row) in cells.enumerated() {
            let height = heights[index]
            if index == 0 {
                style.wash.setFill()
                NSRect(x: 0, y: 0, width: bounds.width, height: height).fill()
            }
            var x: CGFloat = 0
            for (column, cell) in row.enumerated() where column < columns.count {
                cell.draw(with: NSRect(x: x + padX, y: y + padY, width: columns[column] - 2 * padX, height: height - 2 * padY), options: [.usesLineFragmentOrigin, .usesFontLeading])
                x += columns[column]
            }
            if index < cells.count - 1 {
                style.lineSoft.setFill()
                NSRect(x: 0, y: y + height - 1, width: bounds.width, height: 1).fill()
            }
            y += height
        }
    }

    override func mouseUp(with event: NSEvent) {
        // A link in a cell: followed.
        let point = convert(event.locationInWindow, from: nil)
        let (columns, heights) = measure(bounds.width)
        var y: CGFloat = 0
        for (index, row) in rows.enumerated() where index < heights.count {
            defer { y += heights[index] }
            guard point.y >= y, point.y < y + heights[index] else { continue }
            var x: CGFloat = 0
            for (column, runs) in row.enumerated() where column < columns.count {
                defer { x += columns[column] }
                guard point.x >= x, point.x < x + columns[column] else { continue }
                if let link = runs.compactMap(\.link).first { host?.follow(link) }
            }
        }
    }
}

/// A renderer's embeds when it only draws runs.
@MainActor
final class NullEmbeds: EmbedStore {
    static let shared = NullEmbeds()
    private let inner = TranscriptEmbeds()
    func attachment(for embed: DocEmbed, style: ConversationStyle) -> NSTextAttachment { NSTextAttachment() }
    func inline(_ inline: DocInline, size: CGFloat, color: NSColor, style: ConversationStyle) -> NSTextAttachment {
        inner.inline(inline, size: size, color: color, style: style)
    }
}

// MARK: - Images

/// Images in a row of thumbnails, each opening to itself at the column's width.
@MainActor
final class ImageStripView: NSView, EmbedContent {
    private var style: ConversationStyle
    private let resized: () -> Void
    private var images: [ImageRef] = []
    private var tiles: [ImageTile] = []
    private var open: Int?

    init(style: ConversationStyle, resized: @escaping () -> Void) {
        self.style = style
        self.resized = resized
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        guard case .images(let images) = kind else { return }
        if images != self.images {
            self.images = images
            for tile in tiles { tile.removeFromSuperview() }
            tiles = images.enumerated().map { index, image in
                let tile = ImageTile(image: image, style: style) { [weak self] in self?.toggle(index) }
                addSubview(tile)
                return tile
            }
        }
        for tile in tiles { tile.style = style }
        needsLayout = true
    }

    private func toggle(_ index: Int) {
        open = open == index ? nil : index
        for (at, tile) in tiles.enumerated() { tile.whole = at == open }
        resized()
        needsLayout = true
    }

    private func frames(_ width: CGFloat) -> [NSRect] {
        var frames: [NSRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
        let gap = style.px(8)
        for tile in tiles {
            let size = tile.size(forWidth: width)
            if tile.whole || (x > 0 && x + size.width > width) {
                if x > 0 { y += line + gap; x = 0; line = 0 }
            }
            frames.append(NSRect(x: x, y: y, width: size.width, height: size.height))
            line = max(line, size.height)
            if tile.whole { y += line + gap; x = 0; line = 0 } else { x += size.width + gap }
        }
        return frames
    }

    func height(forWidth width: CGFloat) -> CGFloat { frames(width).map(\.maxY).max() ?? 0 }

    override func layout() {
        super.layout()
        for (tile, frame) in zip(tiles, frames(bounds.width)) { tile.frame = frame }
    }
}

/// One image: a thumbnail (`max-width: 12em; max-height: 8em`), or itself whole; one the view cannot read is named.
@MainActor
final class ImageTile: NSView {
    let image: ImageRef
    var style: ConversationStyle { didSet { needsDisplay = true } }
    var whole = false { didSet { needsDisplay = true } }
    private let toggle: () -> Void
    private var picture: NSImage?
    private var loading = false
    private let thumbnailScale: CGFloat

    init(image: ImageRef, style: ConversationStyle, thumbnail: CGFloat = 1, toggle: @escaping () -> Void) {
        self.image = image
        self.style = style
        self.toggle = toggle
        thumbnailScale = thumbnail
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel(image.label)
        toolTip = image.label
        load()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    private func load() {
        switch ImageSourceReading.readable(image) {
        case .bytes(let data)?: picture = NSImage(data: data)
        case .url(let url)?:
            guard let address = URL(string: url) else { return }
            loading = true
            Task { [weak self] in
                let data = try? await URLSession.shared.data(from: address).0
                await MainActor.run {
                    guard let self else { return }
                    self.loading = false
                    self.picture = data.flatMap { NSImage(data: $0) }
                    self.needsDisplay = true
                    (self.superview as? ImageStripView)?.needsLayout = true
                }
            }
        case nil: break
        }
    }

    func size(forWidth width: CGFloat) -> NSSize {
        guard let picture, picture.size.width > 0, picture.size.height > 0 else {
            let words = ImageSourceReading.missing(image) as NSString
            let size = words.size(withAttributes: [.font: style.sans(style.em(0.85))])
            return NSSize(width: min(width, ceil(size.width) + 2 * style.px(8)), height: ceil(size.height) + 2 * style.px(4))
        }
        let most = whole ? NSSize(width: width, height: .greatestFiniteMagnitude) : NSSize(width: style.em(12) * thumbnailScale, height: style.em(8) * thumbnailScale)
        let scale = min(1, most.width / picture.size.width, most.height / picture.size.height)
        return NSSize(width: max(8, floor(picture.size.width * scale)), height: max(8, floor(picture.size.height * scale)))
    }

    override func resetCursorRects() {
        guard picture != nil else { return }
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func mouseUp(with event: NSEvent) {
        if picture != nil { toggle() }
    }

    override func draw(_ dirtyRect: NSRect) {
        let box = bounds.insetBy(dx: 0.5, dy: 0.5)
        let radius = CGFloat(DevHubTheme.Radius.control)
        let path = NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius)
        guard let picture else {
            let words = (loading ? "Loading \(image.label)…" : ImageSourceReading.missing(image)) as NSString
            style.line.setStroke()
            path.setLineDash([3, 2], count: 2, phase: 0)
            path.stroke()
            words.draw(at: NSPoint(x: style.px(8), y: style.px(4)), withAttributes: [.font: style.sans(style.em(0.85)), .foregroundColor: style.ink(.tertiary)])
            return
        }
        NSGraphicsContext.saveGraphicsState()
        path.addClip()
        style.sunken.setFill()
        box.fill()
        picture.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
        style.lineSoft.setStroke()
        path.stroke()
    }
}

/// `![alt](src)`: an https image the Agent linked, opened like the others.
@MainActor
final class RemoteImageView: NSView, EmbedContent {
    private var style: ConversationStyle
    private let resized: () -> Void
    private var tile: ImageTile?
    private var source = ""

    init(style: ConversationStyle, resized: @escaping () -> Void) {
        self.style = style
        self.resized = resized
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        guard case let .remoteImage(source, alt) = kind else { return }
        if source != self.source {
            self.source = source
            tile?.removeFromSuperview()
            let made = ImageTile(image: ImageRef(mediaType: "image/*", source: .url(source), label: alt.isEmpty ? source : alt), style: style) { [weak self] in
                guard let self, let tile = self.tile else { return }
                tile.whole.toggle()
                self.resized()
                self.needsLayout = true
            }
            addSubview(made)
            tile = made
        }
        tile?.style = style
        needsLayout = true
    }

    func height(forWidth width: CGFloat) -> CGFloat { tile?.size(forWidth: width).height ?? 0 }

    override func layout() {
        super.layout()
        guard let tile else { return }
        tile.frame = NSRect(origin: .zero, size: tile.size(forWidth: bounds.width))
    }
}

// MARK: - A subagent's message box

/// Saying something to one subagent, from where its work is drawn. Return is a
/// new line and ⌘Return sends; the text is cleared once the subagent has it.
@MainActor
final class SubagentMessageView: NSView, EmbedContent {
    private var style: ConversationStyle
    private weak var host: EmbedHost?
    private let field = ComposerTextView.make()
    private let scroll = NSScrollView()
    private var send: ConversationButton!
    private var entry: EntryId?
    private var label = ""

    init(style: ConversationStyle, host: EmbedHost?) {
        self.style = style
        self.host = host
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = CGFloat(DevHubTheme.Radius.control)
        layer?.borderWidth = 1
        scroll.documentView = field
        scroll.hasVerticalScroller = false
        scroll.drawsBackground = false
        addSubview(scroll)
        field.onSubmit = { [weak self] in self?.submit() }
        field.onChange = { [weak self] in self?.send.isEnabled = !(self?.field.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
        send = ConversationButton(label: "", icon: .send, look: .round(danger: false), size: style.em(0.9), style: style) { [weak self] in self?.submit() }
        send.isEnabled = false
        addSubview(send)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }

    func height(forWidth width: CGFloat) -> CGFloat { max(style.em(2.2), min(style.em(8), field.contentHeight + style.px(8) * 2)) }

    func update(_ kind: DocEmbedKind, style: ConversationStyle) {
        self.style = style
        guard case let .subagentMessage(entry, label) = kind else { return }
        self.entry = entry
        self.label = label
        layer?.borderColor = style.line.cgColor
        layer?.backgroundColor = style.surface.cgColor
        field.apply(style)
        field.placeholder = "Message \(label) directly"
        field.setAccessibilityLabel("Message to \(label)")
        send.style = style
        send.setAccessibilityLabel("Send to \(label)")
        send.toolTip = "Send to this subagent (\(ComposerWords.sendKey))"
    }

    private func submit() {
        let line = field.string
        guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let entry else { return }
        Task { [weak self] in
            guard let self else { return }
            if await self.host?.instruct(entry, line) == true, self.field.string == line {
                self.field.string = ""
                self.send.isEnabled = false
            }
        }
    }

    override func layout() {
        super.layout()
        let side = style.em(1.8)
        let pad = style.px(8)
        send.frame = NSRect(x: bounds.width - side - pad / 2, y: bounds.height - side - pad / 2, width: side, height: side)
        scroll.frame = NSRect(x: pad, y: pad / 2, width: max(0, bounds.width - side - 2 * pad), height: max(0, bounds.height - pad))
        field.frame.size.width = scroll.contentSize.width
    }
}
