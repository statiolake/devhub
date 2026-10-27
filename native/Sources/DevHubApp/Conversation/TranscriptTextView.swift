// The transcript: one TextKit 2 text view holding every section of the
// conversation, so a drag selection and a copy run across messages, and a
// scroll is the system's own, pixel for pixel.
//
// Behind the text it paints what the stylesheet draws as boxes and grounds:
// the person's bubble, a tool's sunken body, a subagent's card, a notice's
// tint, a quote's rail, a diff's bands, an inline code's chip, the rules of a
// compaction, the wash under a pointed row, and the find bar's matches. The
// renderer marks each in the text's attributes (`TranscriptRenderer`); this
// view reads them for the part on screen.
//
// It holds the whole transcript, always. TextKit 2 lays out only what is near
// the viewport, and a new transcript replaces only the sections that changed,
// found by their common head and tail, so a delta re-lays the answer it grew.

import AppKit
import DevHubCore

/// What the transcript asks of the surface it is in.
@MainActor
protocol TranscriptViewOwner: AnyObject {
    func transcript(_ view: TranscriptTextView, perform action: DocAction)
    func transcript(_ view: TranscriptTextView, follow link: DocLink)
    /// The pointer is over a section (nil: over none).
    func transcript(_ view: TranscriptTextView, pointingAt section: String?)
}

final class TranscriptTextView: NSTextView {
    weak var owner: TranscriptViewOwner?
    var style: ConversationStyle!
    let embeds = TranscriptEmbeds()
    private(set) var rendered: [RenderedSection] = []
    private var offsets: [Int] = []
    /// Every box, by absolute range, in text order.
    private var boxes: [(range: NSRange, box: RenderedBox)] = []
    var findMatches: [NSRange] = [] { didSet { needsDisplay = true } }
    var findCurrent: NSRange? { didSet { needsDisplay = true } }
    private var hovered: (range: NSRange, info: ParagraphInfo)?
    private var pointedSection: String?
    private var renderWidth: CGFloat = 0
    /// Sections to render again on the next `show` though their source is the same (an option pointed at).
    private var stale: Set<String> = []
    private var besidesScheduled = false
    /// Below the last line: the transcript's bottom padding.
    var bottomPadding: CGFloat = 32

    /// A transcript view on TextKit 2.
    @MainActor
    static func make(style: ConversationStyle) -> TranscriptTextView {
        let layoutManager = NSTextLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 600, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        container.lineFragmentPadding = 0
        layoutManager.textContainer = container
        let content = NSTextContentStorage()
        content.addTextLayoutManager(layoutManager)
        let view = TranscriptTextView(frame: NSRect(x: 0, y: 0, width: 600, height: 100), textContainer: container)
        view.style = style
        view.isEditable = false
        view.isSelectable = true
        view.isRichText = true
        view.importsGraphics = false
        view.allowsUndo = false
        view.usesFindBar = false
        view.isIncrementalSearchingEnabled = false
        view.isAutomaticLinkDetectionEnabled = false
        view.displaysLinkToolTips = false
        view.linkTextAttributes = [:]
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainerInset = NSSize(width: CGFloat(SurfaceMetrics.gutterPx), height: CGFloat(SurfaceMetrics.paddingTop))
        view.embeds.host = nil
        view.applyStyle(style)
        return view
    }

    @MainActor
    func applyStyle(_ style: ConversationStyle) {
        self.style = style
        backgroundColor = style.surface
        drawsBackground = true
        selectedTextAttributes = [.backgroundColor: style.tokens.selection.nsColor]
        insertionPointColor = .clear
        embeds.restyle(style)
        needsDisplay = true
    }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    // MARK: Ranges

    @MainActor
    func textRange(_ range: NSRange) -> NSTextRange? {
        guard let content = textContentStorage, let start = content.location(content.documentRange.location, offsetBy: range.location),
              let end = content.location(start, offsetBy: range.length)
        else { return nil }
        return NSTextRange(location: start, end: end)
    }

    @MainActor
    func offset(_ location: NSTextLocation) -> Int {
        guard let content = textContentStorage else { return 0 }
        return content.offset(from: content.documentRange.location, to: location)
    }

    /// The characters near the viewport: what decorations are drawn for.
    @MainActor
    var visibleCharacters: NSRange {
        guard let layout = textLayoutManager, let viewport = layout.textViewportLayoutController.viewportRange else {
            return NSRange(location: 0, length: textStorage?.length ?? 0)
        }
        let start = offset(viewport.location), end = offset(viewport.endLocation)
        return NSRange(location: start, length: max(0, end - start))
    }

    /// The rects (in this view) of each line of `range`.
    @MainActor
    func lineRects(_ range: NSRange) -> [CGRect] {
        guard let layout = textLayoutManager, let text = textRange(range) else { return [] }
        var rects: [CGRect] = []
        let origin = textContainerOrigin
        layout.enumerateTextSegments(in: text, type: .standard, options: [.rangeNotRequired]) { _, frame, _, _ in
            rects.append(frame.offsetBy(dx: origin.x, dy: origin.y))
            return true
        }
        return rects
    }

    @MainActor
    var containerWidth: CGFloat { textContainer?.size.width ?? bounds.width }

    // MARK: Content

    /// The sections now: rendered (each kept while it is the same), and the text changed where they differ.
    @MainActor
    func show(_ sections: [DocSection]) {
        let width = containerWidth
        let widthChanged = abs(width - renderWidth) > 0.5
        renderWidth = width
        var kept: [String: RenderedSection] = [:]
        for section in rendered { kept[section.id] = section }
        embeds.beginRender()
        let renderer = TranscriptRenderer(style: style, width: width, embeds: embeds)
        var next: [RenderedSection] = []
        var previousKind: String?
        for section in sections {
            if let old = kept[section.id], old.source == section, !(widthChanged && old.widthDependent),
               old.previousKind == previousKind, !stale.contains(section.id)
            {
                // Its embeds are still in use.
                for embed in old.embeds { _ = embeds.markUsed(embed.key) }
                for box in old.boxes { if let beside = box.beside { embeds.markBesideUsed(beside.key) } }
                next.append(old)
            } else {
                var made = renderer.render(section, previousKind: previousKind)
                made.previousKind = previousKind
                next.append(made)
            }
            previousKind = section.kind
        }
        stale = []
        embeds.endRender()
        replace(with: next)
        placeBesides()
    }

    /// One section rendered again, as it is (what it draws by changed: an option pointed at).
    @MainActor
    func rerender(section id: String) {
        stale.insert(id)
        show(rendered.map(\.source))
    }

    /// The same sections again, at the width the column has now: those laid out by it are rendered again.
    @MainActor
    func reshow() {
        show(rendered.map(\.source))
    }

    /// Everything rendered again (a change of style or size).
    @MainActor
    func rerender() {
        let sources = rendered.map(\.source)
        rendered = []
        replaceAll()
        show(sources)
    }

    @MainActor
    private func replaceAll() {
        textContentStorage?.performEditingTransaction {
            textStorage?.setAttributedString(NSAttributedString())
        }
        offsets = []
        boxes = []
    }

    @MainActor
    private func replace(with next: [RenderedSection]) {
        guard let storage = textStorage else { return }
        let old = rendered
        var head = 0
        while head < old.count, head < next.count, old[head].identity == next[head].identity { head += 1 }
        var tail = 0
        while tail < old.count - head, tail < next.count - head,
              old[old.count - 1 - tail].identity == next[next.count - 1 - tail].identity { tail += 1 }
        if head == old.count, head == next.count { return }
        let start = head < offsets.count ? offsets[head] : storage.length
        let oldEnd = old.count - tail < offsets.count ? offsets[old.count - tail] : storage.length
        let middle = NSMutableAttributedString()
        for section in next[head..<(next.count - tail)] { middle.append(section.text) }
        textContentStorage?.performEditingTransaction {
            storage.replaceCharacters(in: NSRange(location: start, length: oldEnd - start), with: middle)
        }
        rendered = next
        var at = 0
        offsets = next.map { section in
            defer { at += section.text.length }
            return at
        }
        boxes = []
        for (index, section) in next.enumerated() {
            let base = offsets[index]
            for box in section.boxes {
                boxes.append((NSRange(location: base + box.range.location, length: box.range.length), box))
            }
        }
        hovered = nil
        needsDisplay = true
    }

    /// Where a section starts in the text.
    @MainActor
    func range(ofSection id: String) -> NSRange? {
        guard let index = rendered.firstIndex(where: { $0.id == id }) else { return nil }
        return NSRange(location: offsets[index], length: rendered[index].text.length)
    }

    /// The range of the block keyed `key` within section `id`.
    @MainActor
    func range(ofKey key: String, inSection id: String) -> NSRange? {
        guard let section = range(ofSection: id), let storage = textStorage else { return nil }
        var found: NSRange?
        storage.enumerateAttribute(.devhubKey, in: section) { value, range, stop in
            if (value as? String) == key {
                found = found.map { NSUnionRange($0, range) } ?? range
            } else if found != nil {
                stop.pointee = true
            }
        }
        return found
    }

    /// The section a character is in.
    @MainActor
    func section(at index: Int) -> String? {
        var low = 0, high = offsets.count - 1
        while low <= high {
            let mid = (low + high) / 2
            if offsets[mid] <= index { low = mid + 1 } else { high = mid - 1 }
        }
        return high >= 0 && high < rendered.count ? rendered[high].id : nil
    }

    /// The rect a range takes, in this view (its lines' union).
    @MainActor
    func rect(of range: NSRange) -> CGRect? {
        let rects = lineRects(range)
        guard let first = rects.first else { return nil }
        return rects.dropFirst().reduce(first) { $0.union($1) }
    }

    /// Text offsets into a section's search text, as ranges of the drawn text.
    @MainActor
    func drawnRange(section id: String, key: String, offset: Int, length: Int) -> NSRange? {
        guard let block = range(ofKey: key, inSection: id), let storage = textStorage else { return nil }
        let text = storage.string as NSString
        var counted = 0
        var start: Int?
        var index = block.location
        let end = block.location + block.length
        while index < end {
            let control = storage.attribute(.devhubControl, at: index, effectiveRange: nil) != nil
            let character = text.character(at: index)
            let isAttachment = character == 0xFFFC
            if !control && !isAttachment && character != 0x0A {
                if counted == offset, start == nil { start = index }
                counted += 1
                if let start, counted == offset + length { return NSRange(location: start, length: index + 1 - start) }
            }
            index += 1
        }
        if let start { return NSRange(location: start, length: max(0, index - start)) }
        return nil
    }

    // MARK: Copy

    /// The selection as the conversation's words: no controls, an embed as its own text.
    @MainActor
    func selectedWords() -> String {
        guard let storage = textStorage else { return "" }
        var out = ""
        for value in selectedRanges {
            let range = value.rangeValue
            guard range.length > 0 else { continue }
            if !out.isEmpty { out += "\n" }
            storage.enumerateAttributes(in: range) { attributes, run, _ in
                if attributes[.devhubControl] != nil { return }
                if let copy = attributes[.devhubCopy] as? String {
                    let text = (storage.string as NSString).substring(with: run)
                    out += text.contains("\u{FFFC}") ? copy : text
                    return
                }
                out += (storage.string as NSString).substring(with: run)
            }
        }
        return out.replacingOccurrences(of: "\u{2028}", with: "\n").replacingOccurrences(of: "\u{200B}", with: "")
            .replacingOccurrences(of: "\u{FFFC}", with: "")
    }

    override func copy(_ sender: Any?) {
        MainActor.assumeIsolated {
            let words = selectedWords()
            guard !words.isEmpty else { return }
            let board = NSPasteboard.general
            board.clearContents()
            board.setString(words, forType: .string)
        }
    }

    override func writeSelection(to pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        MainActor.assumeIsolated {
            guard type == .string else { return false }
            pboard.setString(selectedWords(), forType: .string)
            return true
        }
    }

    override var writablePasteboardTypes: [NSPasteboard.PasteboardType] { [.string] }

    // MARK: Pointer

    override func clicked(onLink link: Any, at charIndex: Int) {
        MainActor.assumeIsolated {
            guard let link = link as? TranscriptLink else { return }
            if let target = link.link { owner?.transcript(self, follow: target) } else if let action = link.action { owner?.transcript(self, perform: action) }
        }
    }

    @MainActor
    private func paragraph(at point: NSPoint) -> (range: NSRange, info: ParagraphInfo)? {
        guard let layout = textLayoutManager, let storage = textStorage, storage.length > 0 else { return nil }
        let origin = textContainerOrigin
        let inContainer = CGPoint(x: point.x - origin.x, y: point.y - origin.y)
        guard let fragment = layout.textLayoutFragment(for: inContainer) else { return nil }
        let frame = fragment.layoutFragmentFrame
        guard inContainer.y >= frame.minY, inContainer.y <= frame.maxY else { return nil }
        let index = offset(fragment.rangeInElement.location)
        guard index < storage.length else { return nil }
        var range = NSRange()
        guard let info = storage.attribute(.devhubParagraph, at: index, effectiveRange: &range) as? ParagraphInfo else { return nil }
        return (range, info)
    }

    override func mouseDown(with event: NSEvent) {
        let handled = MainActor.assumeIsolated { () -> Bool in
            let point = convert(event.locationInWindow, from: nil)
            if event.clickCount == 1, let hit = paragraph(at: point), let action = hit.info.action,
               let rect = rect(of: hit.range), rowRect(rect, hit.info).contains(point)
            {
                owner?.transcript(self, perform: action)
                return true
            }
            return false
        }
        if !handled { super.mouseDown(with: event) }
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        MainActor.assumeIsolated {
            let point = convert(event.locationInWindow, from: nil)
            let found = paragraph(at: point)
            let next = found.flatMap { hit -> (range: NSRange, info: ParagraphInfo)? in
                guard hit.info.hover, let rect = rect(of: hit.range), rowRect(rect, hit.info).contains(point) else { return nil }
                return hit
            }
            if next?.range != hovered?.range {
                hovered = next
                needsDisplay = true
                if next != nil { NSCursor.pointingHand.set() }
            }
            let section = found.map { self.section(at: $0.range.location) } ?? nil
            if section != pointedSection {
                pointedSection = section
                owner?.transcript(self, pointingAt: section)
            }
            pointOption(at: point)
        }
    }

    // MARK: The preview beside a question's options

    /// The drawn frame of a box, from its laid-out lines (nil: none laid out).
    @MainActor
    private func frame(of range: NSRange, _ box: RenderedBox) -> CGRect? {
        let lines = lineRects(range)
        guard let first = lines.first else { return nil }
        let union = lines.dropFirst().reduce(first) { $0.union($1) }
        let x = textContainerOrigin.x + box.left
        return CGRect(x: x, y: union.minY - box.padTop, width: max(0, containerWidth - box.left - box.rightInset), height: union.height + box.padTop + box.padBottom)
    }

    /// `onMouseEnter` / `onMouseLeave` of an option: the preview beside it is its own while it is pointed at.
    @MainActor
    private func pointOption(at point: NSPoint?) {
        var now: [String: String] = [:]
        if let point {
            let visible = visibleCharacters
            for (range, box) in boxes {
                guard let option = box.point, NSIntersectionRange(range, visible).length > 0,
                      let frame = frame(of: range, box), frame.contains(point) else { continue }
                now[option.beside] = option.label
            }
        }
        var changed: Set<String> = []
        for key in Set(embeds.pointedKeys).union(now.keys) where embeds.point(key, at: now[key]) {
            if let at = boxes.first(where: { $0.box.beside?.key == key }), let id = section(at: at.range.location) { changed.insert(id) }
        }
        guard !changed.isEmpty else { return }
        stale.formUnion(changed)
        show(rendered.map(\.source))
    }

    /// Whether every preview drawn is beside its options, right of their column (the self-test asks).
    @MainActor
    var previewsBeside: (count: Int, beside: Bool) {
        var count = 0, beside = true
        for (_, box) in boxes {
            guard let layout = box.beside, let view = embeds.beside(layout.key), view.superview === self, !view.isHidden else { continue }
            count += 1
            let options = textContainerOrigin.x + containerWidth - box.rightInset
            if layout.below != nil || view.frame.minX < options || view.frame.width <= 0 { beside = false }
        }
        return (count, beside)
    }

    /// Each preview over the text, beside its options' first row (or under the last).
    @MainActor
    func placeBesides() {
        let visible = visibleCharacters
        let origin = textContainerOrigin
        for (range, box) in boxes {
            guard let layout = box.beside, let view = embeds.beside(layout.key) else { continue }
            guard NSIntersectionRange(range, visible).length > 0, let first = lineRects(NSRange(location: range.location, length: 1)).first else {
                if !view.isHidden { view.isHidden = true }
                continue
            }
            let top = first.minY - layout.topPad + (layout.below ?? 0)
            let frame = CGRect(x: origin.x + layout.left, y: top, width: layout.width, height: layout.height).integral
            if view.superview !== self { addSubview(view) }
            if view.frame != frame { view.frame = frame }
            if view.isHidden { view.isHidden = false }
        }
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        MainActor.assumeIsolated {
            if hovered != nil {
                hovered = nil
                needsDisplay = true
            }
            if pointedSection != nil {
                pointedSection = nil
                owner?.transcript(self, pointingAt: nil)
            }
            pointOption(at: nil)
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas where area.owner === self && area.userInfo?["devhub"] != nil { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self,
            userInfo: ["devhub": true]))
    }

    /// A row's pressable, washable rect: `margin: 0 calc(-1 * var(--space-2))` and `padding: 2px var(--space-2)`.
    @MainActor
    private func rowRect(_ lines: CGRect, _ info: ParagraphInfo) -> CGRect {
        let origin = textContainerOrigin
        let left = origin.x + info.left - style.px(8)
        let right = origin.x + containerWidth - info.rightInset + style.px(8)
        return CGRect(x: left, y: lines.minY - 2, width: right - left, height: lines.height + 4)
    }

    // MARK: Drawing

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        MainActor.assumeIsolated { drawDecorations(in: rect) }
    }

    @MainActor
    private func drawDecorations(in dirty: NSRect) {
        guard let storage = textStorage, storage.length > 0 else { return }
        let visible = visibleCharacters
        let origin = textContainerOrigin
        let width = containerWidth

        // Boxes, outermost first (they are in text order, an outer one before what it holds).
        for (range, box) in boxes {
            let shown = NSIntersectionRange(range, visible)
            guard shown.length > 0 else { continue }
            let lines = lineRects(shown)
            guard let first = lines.first else { continue }
            let union = lines.dropFirst().reduce(first) { $0.union($1) }
            // A box that runs on past what is laid out is drawn on past the dirty rect.
            let top = range.location < visible.location ? min(union.minY, dirty.minY - 40) : union.minY - box.padTop
            let bottom = NSMaxRange(range) > NSMaxRange(visible) ? max(union.maxY, dirty.maxY + 40) : union.maxY + box.padBottom
            let x = origin.x + box.left
            let w = max(0, width - box.left - box.rightInset)
            let frame = CGRect(x: x, y: top, width: w, height: bottom - top)
            guard frame.intersects(dirty.insetBy(dx: -4, dy: -4)) else { continue }
            drawBox(frame, box.metrics)
        }

        storage.enumerateAttribute(.devhubParagraph, in: visible) { value, range, _ in
            guard let info = value as? ParagraphInfo else { return }
            guard info.band != nil || info.rule != nil || info.trailing != nil || hovered?.range == range else { return }
            let lines = lineRects(range)
            guard let first = lines.first else { return }
            let union = lines.dropFirst().reduce(first) { $0.union($1) }
            let left = origin.x + info.left, right = origin.x + width - info.rightInset
            if let band = info.band {
                (band == .add ? style.bandAdd : style.bandRemove).setFill()
                CGRect(x: left, y: union.minY, width: right - left, height: union.height).fill()
            }
            if hovered?.range == range {
                let row = rowRect(union, info)
                style.wash.setFill()
                NSBezierPath(roundedRect: row, xRadius: CGFloat(DevHubTheme.Radius.row), yRadius: CGFloat(DevHubTheme.Radius.row)).fill()
                drawQuietChevron(in: range)
            }
            if let rule = info.rule { drawRule(rule, lines: lines, range: range, info: info) }
            if let trailing = info.trailing {
                let size = trailing.size()
                trailing.draw(at: NSPoint(x: right - size.width, y: first.midY - size.height / 2))
            }
        }

        // Chips behind inline code, skills and pills.
        storage.enumerateAttribute(.devhubChip, in: visible) { value, range, _ in
            guard let raw = value as? String, let chip = DocChip(rawValue: raw), chip != .key else { return }
            let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont ?? style.body
            let metrics = style.chip(chip, size: font.pointSize)
            var chipRange = range
            if chipRange.location > 0, storage.attribute(.devhubControl, at: chipRange.location - 1, effectiveRange: nil) != nil,
               (storage.string as NSString).character(at: chipRange.location - 1) == 0x200A
            {
                chipRange = NSRange(location: chipRange.location - 1, length: chipRange.length + 1)
            }
            for line in lineRects(chipRange) {
                let height = font.ascender - font.descender + 2 * metrics.padY
                let chipRect = CGRect(x: line.minX, y: line.midY - height / 2, width: line.width, height: height)
                let path = NSBezierPath(roundedRect: chipRect, xRadius: min(metrics.radius, height / 2), yRadius: min(metrics.radius, height / 2))
                if let fill = metrics.fill { fill.setFill(); path.fill() }
                if let border = metrics.border { border.setStroke(); path.lineWidth = 1; path.stroke() }
            }
        }

        // The find bar's matches.
        if !findMatches.isEmpty {
            style.findMatch.setFill()
            for match in findMatches where NSIntersectionRange(match, visible).length > 0 {
                for line in lineRects(match) { line.fill() }
            }
        }
        if let current = findCurrent {
            style.findCurrent.withAlphaComponent(0.55).setFill()
            for line in lineRects(current) { NSBezierPath(roundedRect: line, xRadius: 2, yRadius: 2).fill() }
        }
        // Laid out again (the text above changed, the viewport moved): the
        // previews follow their options, once this drawing is done.
        if !boxes.allSatisfy({ $0.box.beside == nil }), !besidesScheduled {
            besidesScheduled = true
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    self?.besidesScheduled = false
                    self?.placeBesides()
                }
            }
        }
    }

    @MainActor
    private func drawQuietChevron(in range: NSRange) {
        guard let storage = textStorage else { return }
        storage.enumerateAttribute(.devhubQuietChevron, in: range) { value, at, _ in
            guard value != nil, let rect = rect(of: at) else { return }
            let side = min(rect.height, style.fontSize * 0.9)
            let square = CGRect(x: rect.minX, y: rect.midY - side / 2, width: side, height: side)
            GlyphPainter.draw(ConversationIcons.drawing(.chevronRight), in: square, color: style.ink(.tertiary), stroke: ConversationIcons.stroke)
        }
    }

    @MainActor
    private func drawRule(_ rule: DocRule, lines: [CGRect], range: NSRange, info: ParagraphInfo) {
        let origin = textContainerOrigin
        let width = containerWidth
        let colour = style.ink(rule.ink)
        let path = NSBezierPath()
        path.lineWidth = 1
        if rule.dashed { path.setLineDash([4, 3], count: 2, phase: 0) }
        switch rule.place {
        case .middle:
            // Through the middle of the line, on both sides of its words.
            let words = NSRange(location: range.location, length: max(0, range.length - 1))
            guard let text = rect(of: words) else { return }
            let gap = style.px(8)
            let left = origin.x + info.left, right = origin.x + width - info.rightInset
            let y = floor(text.midY) + 0.5
            if text.minX - gap > left {
                path.move(to: NSPoint(x: left, y: y))
                path.line(to: NSPoint(x: text.minX - gap, y: y))
            }
            if text.maxX + gap < right {
                path.move(to: NSPoint(x: text.maxX + gap, y: y))
                path.line(to: NSPoint(x: right, y: y))
            }
        case .top, .bottom:
            let left = origin.x + info.outerLeft, right = origin.x + width - info.outerRight
            guard let first = lines.first, let last = lines.last else { return }
            let y = rule.place == .top ? floor(first.minY - info.before) + 0.5 : floor(last.maxY + style.px(4)) + 0.5
            path.move(to: NSPoint(x: left, y: y))
            path.line(to: NSPoint(x: right, y: y))
        }
        colour.setStroke()
        path.stroke()
    }

    @MainActor
    private func drawBox(_ frame: CGRect, _ metrics: ConversationStyle.Box) {
        let rect = frame.insetBy(dx: 0.5, dy: 0.5)
        let (tl, tr, br, bl) = metrics.radii
        let path = Self.roundedPath(rect, tl: tl, tr: tr, br: br, bl: bl)
        if let fill = metrics.fill {
            fill.setFill()
            path.fill()
        }
        if let border = metrics.border {
            border.setStroke()
            path.lineWidth = 1
            if metrics.dashed { path.setLineDash([4, 3], count: 2, phase: 0) }
            path.stroke()
        }
        if let rail = metrics.rail {
            rail.1.setFill()
            CGRect(x: frame.minX, y: frame.minY, width: rail.0, height: frame.height).fill()
        }
        if let rule = metrics.topRule {
            rule.setFill()
            CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: 1).fill()
        }
    }

    static func roundedPath(_ rect: CGRect, tl: CGFloat, tr: CGFloat, br: CGFloat, bl: CGFloat) -> NSBezierPath {
        let path = NSBezierPath()
        let limit = min(rect.width, rect.height) / 2
        let tl = min(tl, limit), tr = min(tr, limit), br = min(br, limit), bl = min(bl, limit)
        // Flipped: minY is the top.
        path.move(to: NSPoint(x: rect.minX + tl, y: rect.minY))
        path.line(to: NSPoint(x: rect.maxX - tr, y: rect.minY))
        if tr > 0 { path.appendArc(withCenter: NSPoint(x: rect.maxX - tr, y: rect.minY + tr), radius: tr, startAngle: 270, endAngle: 360) }
        path.line(to: NSPoint(x: rect.maxX, y: rect.maxY - br))
        if br > 0 { path.appendArc(withCenter: NSPoint(x: rect.maxX - br, y: rect.maxY - br), radius: br, startAngle: 0, endAngle: 90) }
        path.line(to: NSPoint(x: rect.minX + bl, y: rect.maxY))
        if bl > 0 { path.appendArc(withCenter: NSPoint(x: rect.minX + bl, y: rect.maxY - bl), radius: bl, startAngle: 90, endAngle: 180) }
        path.line(to: NSPoint(x: rect.minX, y: rect.minY + tl))
        if tl > 0 { path.appendArc(withCenter: NSPoint(x: rect.minX + tl, y: rect.minY + tl), radius: tl, startAngle: 180, endAngle: 270) }
        path.close()
        return path
    }

    // MARK: Size

    /// The text's laid-out height (everything laid out: a short document's).
    @MainActor
    func documentHeight() -> CGFloat {
        guard let layout = textLayoutManager else { return 0 }
        layout.ensureLayout(for: layout.documentRange)
        return ceil(layout.usageBoundsForTextContainer.height) + 2 * textContainerInset.height
    }

    /// An embed changed its height: its line is laid out again.
    @MainActor
    func relayout(embed key: String) {
        guard let storage = textStorage, let layout = textLayoutManager else { return }
        for (index, section) in rendered.enumerated() {
            for embed in section.embeds where embed.key == key {
                let at = offsets[index] + embed.offset
                guard at < storage.length, let range = textRange(NSRange(location: at, length: 1)) else { return }
                layout.invalidateLayout(for: range)
                layout.textViewportLayoutController.layoutViewport()
                needsDisplay = true
                return
            }
        }
    }
}

extension RenderedSection {
    /// The same rendered section: the same object of text.
    var identity: ObjectIdentifier { ObjectIdentifier(text) }
}
