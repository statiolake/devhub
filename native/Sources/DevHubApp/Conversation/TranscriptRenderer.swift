// The drawn conversation's document (`DocSection`, Core) as one attributed
// text for TextKit 2: every paragraph a paragraph of the text, every embed an
// attachment drawing a view, and every box a span of paragraphs whose ground,
// border and rail the transcript view paints behind them (`RenderedBox`).
//
// A section renders on its own, so the view replaces only the sections that
// changed: a delta re-renders the answer it grew and leaves the other two
// thousand where they are.

import AppKit
import DevHubCore

extension NSAttributedString.Key {
    /// A run that is not the conversation's words (a control, a line number): copied and searched never.
    static let devhubControl = NSAttributedString.Key("devhub.control")
    /// A run's chip (`DocChip.rawValue`): a rounded ground the view paints behind its glyphs.
    static let devhubChip = NSAttributedString.Key("devhub.chip")
    /// What a copy over an attachment takes (an embed's `copyText`).
    static let devhubCopy = NSAttributedString.Key("devhub.copy")
    /// The paragraph's facts the view draws by (`ParagraphInfo`).
    static let devhubParagraph = NSAttributedString.Key("devhub.paragraph")
    /// The key of the block a run is in (a paragraph's, an embed's).
    static let devhubKey = NSAttributedString.Key("devhub.key")
    /// A section is dimmed (a message on its way).
    static let devhubDimmed = NSAttributedString.Key("devhub.dimmed")
    /// A fold's chevron drawn only while its row is pointed at.
    static let devhubQuietChevron = NSAttributedString.Key("devhub.quietChevron")
}

/// What pressing a run does: a link to follow, or an action of the surface's.
final class TranscriptLink: NSObject {
    let link: DocLink?
    let action: DocAction?

    init(link: DocLink?, action: DocAction?) {
        self.link = link
        self.action = action
    }

    override func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? TranscriptLink else { return false }
        return other.link == link && other.action == action
    }

    override var hash: Int {
        var hasher = Hasher()
        hasher.combine(link)
        hasher.combine(action)
        return hasher.finalize()
    }
}

/// A paragraph's facts the view draws by.
final class ParagraphInfo: NSObject {
    let key: String
    let band: DocBand?
    let rule: DocRule?
    let hover: Bool
    let action: DocAction?
    /// Drawn at the line's trailing end, in the space the paragraph's tail indent leaves.
    let trailing: NSAttributedString?
    let trailingWidth: CGFloat
    /// The paragraph's left and right edges for its band and hover wash, from the container's edges.
    let left: CGFloat
    let rightInset: CGFloat
    /// The enclosing box's outer edges, for a rule across it.
    let outerLeft: CGFloat
    let outerRight: CGFloat
    /// The space before it that is its own (a rule over it sits there).
    let before: CGFloat
    let tooltip: String?

    init(key: String, band: DocBand?, rule: DocRule?, hover: Bool, action: DocAction?, trailing: NSAttributedString?, trailingWidth: CGFloat,
         left: CGFloat, rightInset: CGFloat, outerLeft: CGFloat = 0, outerRight: CGFloat = 0, before: CGFloat, tooltip: String?)
    {
        self.outerLeft = outerLeft
        self.outerRight = outerRight
        self.key = key
        self.band = band
        self.rule = rule
        self.hover = hover
        self.action = action
        self.trailing = trailing
        self.trailingWidth = trailingWidth
        self.left = left
        self.rightInset = rightInset
        self.before = before
        self.tooltip = tooltip
    }

    override func isEqual(_ object: Any?) -> Bool { (object as? ParagraphInfo) === self }
    override var hash: Int { ObjectIdentifier(self).hashValue }
}

/// A box drawn behind its paragraphs.
struct RenderedBox {
    var key: String
    /// Its characters, from its section's start.
    var range: NSRange
    var metrics: ConversationStyle.Box
    /// Its outer left edge from the container's, and its right edge's inset from the container's right.
    var left: CGFloat
    var rightInset: CGFloat
    /// Space inside it over its first line and under its last.
    var padTop: CGFloat
    var padBottom: CGFloat
    var tooltip: String?
    var clip: DocClip?
}

/// One section, rendered.
struct RenderedSection {
    var id: String
    var text: NSAttributedString
    var boxes: [RenderedBox]
    /// Each embed's key and its character, from the section's start.
    var embeds: [(key: String, offset: Int)]
    /// It lays out by the column's width (a bubble's width is its words'), so a resize renders it again.
    var widthDependent: Bool
    var source: DocSection
    /// The kind of the section before it, which its gap was rendered for.
    var previousKind: String? = nil
}

/// The attachments the transcript keeps across renders, by key, so an embed's view keeps its state.
@MainActor
protocol EmbedStore: AnyObject {
    func attachment(for embed: DocEmbed, style: ConversationStyle) -> NSTextAttachment
    func inline(_ inline: DocInline, size: CGFloat, color: NSColor, style: ConversationStyle) -> NSTextAttachment
}

@MainActor
struct TranscriptRenderer {
    let style: ConversationStyle
    /// The text container's width: the column, less nothing.
    let width: CGFloat
    unowned let embeds: EmbedStore

    private final class Output {
        let text = NSMutableAttributedString()
        var boxes: [RenderedBox] = []
        var embeds: [(String, Int)] = []
        var widthDependent = false
        /// The last paragraph written: its range, so spacing after it can be added once its boxes close.
        var lastParagraph: NSRange?
        /// Space owed before the next paragraph (gaps, the padding of boxes opening at it).
        var pending: CGFloat = 0
        var dimmed = false
        var tooltip: String?
    }

    private struct Frame {
        var left: CGFloat
        var rightInset: CGFloat
        /// The enclosing box's outer edges (a rule across it).
        var outerLeft: CGFloat = 0
        var outerRight: CGFloat = 0
    }

    func render(_ section: DocSection, previousKind: String?) -> RenderedSection {
        let out = Output()
        out.dimmed = section.dimmed
        out.pending = style.em(DocSection.gap(after: previousKind, before: section.kind))
        blocks(MarkdownDocumentBuilder.collapse(section.blocks), Frame(left: 0, rightInset: 0), out)
        if section.dimmed {
            let whole = NSRange(location: 0, length: out.text.length)
            out.text.addAttribute(.devhubDimmed, value: true, range: whole)
            out.text.enumerateAttribute(.foregroundColor, in: whole) { value, at, _ in
                if let colour = value as? NSColor { out.text.addAttribute(.foregroundColor, value: colour.withAlphaComponent(colour.alphaComponent * 0.6), range: at) }
            }
            for index in out.boxes.indices {
                out.boxes[index].metrics.fill = out.boxes[index].metrics.fill.map { $0.withAlphaComponent($0.alphaComponent * 0.6) }
            }
        }
        return RenderedSection(id: section.id, text: out.text, boxes: out.boxes, embeds: out.embeds, widthDependent: out.widthDependent, source: section)
    }

    // MARK: Blocks

    private func blocks(_ blocks: [DocBlock], _ frame: Frame, _ out: Output) {
        for block in blocks {
            switch block {
            case .paragraph(let paragraph): self.paragraph(paragraph, frame, out)
            case .box(let box): self.box(box, frame, out)
            case .embed(let embed): self.embed(embed, frame, out)
            }
        }
    }

    private func addAfter(_ points: CGFloat, _ out: Output) {
        guard points > 0, let range = out.lastParagraph, range.length > 0 else { return }
        let current = out.text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle ?? NSParagraphStyle()
        let next = current.mutableCopy() as! NSMutableParagraphStyle
        next.paragraphSpacing += points
        out.text.addAttribute(.paragraphStyle, value: next, range: range)
    }

    private func box(_ box: DocBox, _ frame: Frame, _ out: Output) {
        let metrics = style.box(box.style, flat: box.flat)
        out.pending += style.em(box.before)
        var left = frame.left + style.em(box.indent)
        var rightInset = frame.rightInset
        if let share = metrics.maxShare {
            // At most min(85%, 60ch) of the column; the bubble as wide as its words, against the trailing edge.
            let column = width - left - rightInset
            let ch = ("0" as NSString).size(withAttributes: [.font: style.body]).width
            let most = min(column * share, (metrics.maxCh ?? 1000) * ch)
            var wide = most
            if metrics.trailing {
                let inner = max(40, most - metrics.padLeft - metrics.padRight)
                wide = min(most, measure(box.children, inner) + metrics.padLeft + metrics.padRight)
                left = left + column - wide
            } else {
                rightInset = rightInset + column - wide
            }
            out.widthDependent = true
        }
        let start = out.text.length
        out.pending += metrics.padTop
        let inner = Frame(left: left + metrics.padLeft, rightInset: rightInset + metrics.padRight, outerLeft: left, outerRight: rightInset)
        let savedTooltip = out.tooltip
        if let tooltip = box.tooltip { out.tooltip = tooltip }
        blocks(box.children, inner, out)
        out.tooltip = savedTooltip
        let end = out.text.length
        if end > start {
            addAfter(metrics.padBottom, out)
            if metrics.fill != nil || metrics.border != nil || metrics.rail != nil || metrics.topRule != nil || box.clip != nil || box.tooltip != nil {
                out.boxes.append(RenderedBox(
                    key: box.key, range: NSRange(location: start, length: end - start), metrics: metrics, left: left, rightInset: rightInset,
                    padTop: metrics.padTop, padBottom: metrics.padBottom, tooltip: box.tooltip, clip: box.clip))
            }
        } else {
            out.pending -= metrics.padTop
        }
        addAfter(style.em(box.after), out)
    }

    /// The width a bubble's words take, laid out no wider than `most`.
    private func measure(_ blocks: [DocBlock], _ most: CGFloat) -> CGFloat {
        var widest: CGFloat = 0
        for block in blocks {
            switch block {
            case .paragraph(let paragraph):
                let text = NSMutableAttributedString()
                for run in paragraph.runs { text.append(runText(run, inherited: nil)) }
                let rect = text.boundingRect(with: NSSize(width: most, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading])
                widest = max(widest, ceil(rect.width) + style.em(paragraph.indent))
            case .box(let box):
                let metrics = style.box(box.style)
                widest = max(widest, measure(box.children, most - metrics.padLeft - metrics.padRight) + metrics.padLeft + metrics.padRight + style.em(box.indent))
            case .embed:
                widest = most
            }
        }
        return min(most, widest + 1)
    }

    // MARK: Paragraphs

    private func paragraphStyle(_ size: CGFloat, lineHeight: Double, left: CGFloat, firstLeft: CGFloat, rightInset: CGFloat, align: DocAlign) -> NSMutableParagraphStyle {
        let paragraph = NSMutableParagraphStyle()
        let height = size * CGFloat(lineHeight)
        paragraph.minimumLineHeight = height
        paragraph.maximumLineHeight = height
        paragraph.headIndent = left
        paragraph.firstLineHeadIndent = firstLeft
        paragraph.tailIndent = -rightInset
        paragraph.lineBreakMode = .byWordWrapping
        switch align {
        case .leading: paragraph.alignment = .natural
        case .center: paragraph.alignment = .center
        case .trailing: paragraph.alignment = .right
        }
        return paragraph
    }

    /// The paragraph's size: its first run's, as CSS takes the block's.
    private func size(_ paragraph: DocParagraph) -> CGFloat {
        style.em((paragraph.runs.first { $0.inline == nil && !$0.text.isEmpty } ?? paragraph.runs.first)?.style.size ?? 1)
    }

    private func paragraph(_ paragraph: DocParagraph, _ frame: Frame, _ out: Output) {
        let size = self.size(paragraph)
        let text = NSMutableAttributedString()
        let left = frame.left + style.em(paragraph.indent)
        var firstLeft = left
        if let marker = paragraph.marker {
            let mark = runText(marker, inherited: paragraph)
            let gap = style.em(0.4)
            let width = ceil(mark.size().width)
            firstLeft = max(0, left - width - gap)
            let control = NSMutableAttributedString(attributedString: mark)
            control.addAttribute(.devhubControl, value: true, range: NSRange(location: 0, length: control.length))
            text.append(control)
            text.append(NSAttributedString(string: "\t", attributes: [.font: style.sans(size), .devhubControl: true]))
        }
        for run in paragraph.runs { text.append(runText(run, inherited: paragraph)) }
        if text.length == 0 { text.append(NSAttributedString(string: "\u{200B}", attributes: [.font: style.sans(size)])) }
        var trailing: NSAttributedString?
        var trailingWidth: CGFloat = 0
        if !paragraph.trailing.isEmpty {
            let made = NSMutableAttributedString()
            for run in paragraph.trailing { made.append(runText(run, inherited: paragraph)) }
            trailing = made
            trailingWidth = ceil(made.size().width) + style.px(8)
        }
        let shape = paragraphStyle(
            size, lineHeight: paragraph.lineHeight, left: left, firstLeft: firstLeft,
            rightInset: frame.rightInset + trailingWidth, align: paragraph.align)
        if paragraph.marker != nil {
            // The marker hangs in the indent; the words start at the tab, on the head indent.
            shape.tabStops = [NSTextTab(textAlignment: .left, location: left)]
            shape.defaultTabInterval = max(1, style.em(2))
        }
        if paragraph.oneLine { shape.lineBreakMode = .byTruncatingTail }
        let before = out.pending + style.em(paragraph.before)
        shape.paragraphSpacingBefore = before
        shape.paragraphSpacing = style.em(paragraph.after)
        out.pending = 0
        let whole = text.length
        text.append(NSAttributedString(string: "\n", attributes: [.font: style.sans(size)]))
        let range = NSRange(location: 0, length: text.length)
        text.addAttribute(.paragraphStyle, value: shape, range: range)
        let info = ParagraphInfo(
            key: paragraph.key, band: paragraph.band, rule: paragraph.rule, hover: paragraph.hover, action: paragraph.action,
            trailing: trailing, trailingWidth: trailingWidth, left: frame.left, rightInset: frame.rightInset,
            outerLeft: frame.outerLeft, outerRight: frame.outerRight, before: before, tooltip: out.tooltip)
        text.addAttribute(.devhubParagraph, value: info, range: range)
        text.addAttribute(.devhubKey, value: paragraph.key, range: range)
        if paragraph.control { text.addAttribute(.devhubControl, value: true, range: NSRange(location: 0, length: whole)) }
        if let action = paragraph.action {
            text.addAttribute(.cursor, value: NSCursor.pointingHand, range: NSRange(location: 0, length: whole))
            // The row itself presses: its words too, where no link of their own is.
            text.enumerateAttribute(.link, in: NSRange(location: 0, length: whole)) { value, at, _ in
                if value == nil { text.addAttribute(.link, value: TranscriptLink(link: nil, action: action), range: at) }
            }
        }
        let start = out.text.length
        out.text.append(text)
        out.lastParagraph = NSRange(location: start, length: text.length)
    }

    /// One run, in its face and ink, with its link and chip.
    func runText(_ run: DocRun, inherited paragraph: DocParagraph?) -> NSAttributedString {
        let doc = run.style
        let size = style.em(doc.size)
        let font = style.font(doc)
        var colour = style.ink(doc.ink)
        if let code = style.code(light: doc.codeLight, dark: doc.codeDark) { colour = code }
        if doc.fade < 1 { colour = colour.withAlphaComponent(colour.alphaComponent * CGFloat(doc.fade)) }
        if let inline = run.inline {
            var quiet = false
            if case let .chevron(open, quietUntilHover) = inline, quietUntilHover, !open { quiet = true }
            let attachment = embeds.inline(inline, size: size, color: quiet ? .clear : colour, style: style)
            let text = NSMutableAttributedString(attachment: attachment)
            let range = NSRange(location: 0, length: text.length)
            text.addAttributes([.font: font, .foregroundColor: colour], range: range)
            if case .math(let tex) = inline { text.addAttribute(.devhubCopy, value: "$\(tex)$", range: range) } else {
                text.addAttribute(.devhubControl, value: true, range: range)
            }
            if let tooltip = run.tooltip { text.addAttribute(.toolTip, value: tooltip, range: range) }
            if quiet { text.addAttribute(.devhubQuietChevron, value: true, range: range) }
            return text
        }
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: colour]
        if doc.strike { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if doc.underline {
            attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            attributes[.underlineColor] = doc.ink == .accent ? style.faded(style.tokens.accent, 0.4) : colour.withAlphaComponent(0.5)
        }
        if doc.tracking != 0 { attributes[.kern] = CGFloat(doc.tracking) * size }
        if doc.superscript { attributes[.baselineOffset] = size * 0.5 }
        if let chip = doc.chip { attributes[.devhubChip] = chip.rawValue }
        if doc.control { attributes[.devhubControl] = true }
        if run.link != nil || run.action != nil {
            attributes[.link] = TranscriptLink(link: run.link, action: run.action)
            attributes[.cursor] = NSCursor.pointingHand
        }
        if let tooltip = run.tooltip { attributes[.toolTip] = tooltip }
        var words = doc.uppercase ? run.text.uppercased() : run.text
        // A run's own line breaks stay inside its paragraph.
        words = words.replacingOccurrences(of: "\r\n", with: "\u{2028}").replacingOccurrences(of: "\n", with: "\u{2028}")
        let text = NSMutableAttributedString(string: words, attributes: attributes)
        if let chip = doc.chip {
            // The chip's padding, as space its ground takes at both ends.
            let pad = style.chip(chip, size: size).padX
            if pad > 0, text.length > 0 {
                text.addAttribute(.kern, value: pad, range: NSRange(location: text.length - 1, length: 1))
                let lead = NSMutableAttributedString(string: "\u{200A}", attributes: [.font: font, .kern: max(0, pad - ("\u{200A}" as NSString).size(withAttributes: [.font: font]).width), .devhubControl: true])
                lead.append(text)
                return lead
            }
        }
        return text
    }

    // MARK: Embeds

    private func embed(_ embed: DocEmbed, _ frame: Frame, _ out: Output) {
        let attachment = embeds.attachment(for: embed, style: style)
        (attachment as? EmbedAttachment)?.insets = (frame.left, frame.rightInset)
        let text = NSMutableAttributedString(attachment: attachment)
        let size = style.fontSize
        let paragraph = paragraphStyle(size, lineHeight: 1, left: frame.left, firstLeft: frame.left, rightInset: frame.rightInset, align: .leading)
        paragraph.minimumLineHeight = 0
        paragraph.maximumLineHeight = 0
        paragraph.paragraphSpacingBefore = out.pending + style.em(embed.before)
        paragraph.paragraphSpacing = style.em(embed.after)
        out.pending = 0
        text.append(NSAttributedString(string: "\n", attributes: [.font: NSFont.systemFont(ofSize: 1)]))
        let range = NSRange(location: 0, length: text.length)
        text.addAttribute(.paragraphStyle, value: paragraph, range: range)
        text.addAttribute(.devhubKey, value: embed.key, range: range)
        text.addAttribute(.devhubCopy, value: embed.copyText, range: NSRange(location: 0, length: 1))
        let info = ParagraphInfo(
            key: embed.key, band: nil, rule: nil, hover: false, action: nil, trailing: nil, trailingWidth: 0,
            left: frame.left, rightInset: frame.rightInset, before: paragraph.paragraphSpacingBefore, tooltip: out.tooltip)
        text.addAttribute(.devhubParagraph, value: info, range: range)
        let start = out.text.length
        out.embeds.append((embed.key, start))
        out.text.append(text)
        out.lastParagraph = NSRange(location: start, length: text.length)
    }
}
