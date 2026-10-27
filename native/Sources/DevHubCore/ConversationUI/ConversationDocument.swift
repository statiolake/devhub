// The drawn conversation as data: what the TS view's components
// (EntryView.tsx, EntryParts.tsx, Markdown.tsx, CodeBlock.tsx, RequestCard's
// record, Clip.tsx) put on the page, as one tree per transcript entry, which
// the App lays into one TextKit 2 text so that selection and copy run across
// messages.
//
// A section is one top-level entry (an entry's id; `sending:<id>` for a
// message on its way; `request:<id>` for a request about no call;
// `compacting`, `limit-resume`). Its blocks are paragraphs of styled runs,
// boxes that hold blocks (the person's bubble, a code-ish panel, a tool's
// body, a notice), and embedded views (a code block, a table, a request
// card, an image) that the App draws as views inside the text.
//
// Everything a person can read in an entry is here whether it is folded or
// not: a fold is a box with a `fold` id, open or closed by the surface's
// state, and the find bar's text is read from the document with every fold
// open (`searchText`). What only the eye or the hand needs — a button, a
// diff's line numbers — is marked so neither a copy nor a search takes it.

import Foundation

// MARK: - Ink, type

/// The colour tokens the conversation's stylesheet uses (tokens.css).
public enum DocInk: String, Hashable, Sendable {
    case primary, secondary, tertiary, accent, accentInk, danger, waiting
    case statusIdle, statusWorking, statusWaiting, statusError, statusDone, statusBackground
    /// The surface's own colour (text on a strong fill).
    case surface
    /// The hairlines (`--line`, `--line-soft`).
    case line, lineSoft
    /// A code token's own colour, Light+ / Dark+ (`light` / `dark` hex).
    case code
}

/// A run's look. Sizes are in em of the conversation's font size, as the
/// stylesheet writes them, multiplied down the tree.
public struct DocStyle: Hashable, Sendable {
    public var size: Double = 1
    public var bold = false
    /// `font-weight: 500`.
    public var medium = false
    public var italic = false
    public var strike = false
    public var underline = false
    public var mono = false
    public var ink: DocInk?
    /// A code token's colours: Light+ and Dark+.
    public var codeLight: String?
    public var codeDark: String?
    /// A rounded tint behind the run: inline code, a skill name, a pill.
    public var chip: DocChip?
    /// Not the conversation's words: a control, a line number. Neither copied nor searched.
    public var control = false
    public var superscript = false
    public var uppercase = false
    /// `letter-spacing` in em.
    public var tracking: Double = 0
    /// Drawn at this share of its ink (a cut view's last lines fading).
    public var fade: Double = 1

    public init() {}

    public static let plain = DocStyle()

    public func with(_ change: (inout DocStyle) -> Void) -> DocStyle {
        var next = self
        change(&next)
        return next
    }
}

public enum DocChip: String, Hashable, Sendable {
    /// `:not(pre) > code`: the wash, 4px corners.
    case code
    /// `.conversation-skill`: the accent's tint.
    case skill
    /// `.conversation-subagent-model`: a pill in the wash.
    case model
    /// `.conversation-tool-sandbox`: a warm hairline pill.
    case sandbox
    /// `.conversation-question-header`: the accent's tint, a pill.
    case questionHeader
    /// `.conversation-request-key`: a choice's digit (no box).
    case key
}

// MARK: - Links and actions

public enum DocLink: Hashable, Sendable {
    /// Opened in the default browser.
    case url(String)
    /// A file on the Agent's machine (resolved), opened in the editor.
    case file(path: String, range: FileRange?)
    /// A path a Markdown link names, resolved when it is followed.
    case href(PathCandidate)
    /// An Issue or pull request on GitHub.
    case issue(url: String, title: String?)
    /// A footnote of the same answer: where to go.
    case footnote(String)
}

/// What pressing a run or a row does: the surface carries it out.
public enum DocAction: Hashable, Sendable {
    /// Open or close a fold (`<details>`), by its id.
    case toggle(String)
    /// Put text on the pasteboard; `id` is the button, which says "Copied" a moment.
    case copy(id: String, text: String)
    case askRewind(EntryId)
    case rewind(EntryId)
    case cancelRewind(EntryId)
    case cancelLimitResume
    /// A long message not from the person: Show all / Show less.
    case unfoldOther(EntryId)
    case maximize(EntryId?)
    case setBeside(EntryId, Bool)
    /// A Clip's Show all / Show less.
    case clip(String)
}

// MARK: - Blocks

public struct DocRun: Hashable, Sendable {
    public var text: String
    public var style: DocStyle
    public var link: DocLink?
    public var action: DocAction?
    /// The text's tooltip.
    public var tooltip: String?
    /// An inline thing drawn in the line in place of `text`.
    public var inline: DocInline?

    public init(_ text: String, _ style: DocStyle = .plain, link: DocLink? = nil, action: DocAction? = nil, tooltip: String? = nil, inline: DocInline? = nil) {
        self.text = text
        self.style = style
        self.link = link
        self.action = action
        self.tooltip = tooltip
        self.inline = inline
    }
}

/// What is drawn inline in a line: marks, glyphs, small pictures.
public enum DocInline: Hashable, Sendable {
    /// A tool call's state (`StatusMark`), spinning while running.
    case status(WorkState)
    /// A plan step's box.
    case checklist(PlanStatus)
    /// A task list item's checkbox.
    case checkbox(Bool)
    /// A question option's mark: a ring, or a box for any of many; checked.
    case optionMark(multiple: Bool, picked: Bool)
    /// One of the conversation's glyphs (icons.tsx), at the text's size.
    case icon(DocIcon)
    /// A disclosure chevron after a fold's summary: open or closed.
    case chevron(open: Bool, quietUntilHover: Bool)
    /// `$…$` typeset.
    case math(String)
    /// The streaming caret: a pulsing dot.
    case streamingDot
    /// The pending queue's clock.
    case background
}

public enum DocIcon: String, Hashable, Sendable {
    case send, clock, edit, rewind, mic, stop, copy, check, arrowDown, arrowUp, close, arrowLeft
    case chevronDown, chevronRight, maximize, column
}

public enum DocAlign: String, Hashable, Sendable { case leading, center, trailing }

public struct DocParagraph: Hashable, Sendable {
    /// Stable within its section: what a search match or a fold is found by.
    public var key: String
    public var runs: [DocRun]
    /// Space before and after, in em of the conversation's size.
    public var before: Double = 0
    public var after: Double = 0
    public var lineHeight: Double = 1.6
    public var align: DocAlign = .leading
    /// Extra indent of the text from the box's content edge, in em of the conversation's size.
    public var indent: Double = 0
    /// A list item's marker, drawn hanging in the indent.
    public var marker: DocRun?
    /// The space between the marker and the words, in em (nil: a list's 0.4em).
    public var markerGap: Double?
    /// Long lines wrap (default), or the row is one line, cut with an ellipsis.
    public var oneLine = false
    /// Runs drawn at the line's trailing end (`margin-left: auto`): a call's note.
    public var trailing: [DocRun] = []
    /// The row takes the wash while pointed at (a fold's summary row).
    public var hover = false
    /// Pressing anywhere in the row: a fold's summary.
    public var action: DocAction?
    /// A row tint across the box's width: a diff's added or removed line.
    public var band: DocBand?
    /// A rule through the line's middle on both sides of its text (a compaction, a turn's end).
    public var rule: DocRule?
    /// Not drawn for anyone but the eye: excluded from search and copy (a control row).
    public var control = false

    public init(key: String, runs: [DocRun]) {
        self.key = key
        self.runs = runs
    }

    public var text: String { runs.map(\.text).joined() }
}

public enum DocBand: String, Hashable, Sendable { case add, remove }

public struct DocRule: Hashable, Sendable {
    public enum Place: String, Hashable, Sendable {
        /// Through the line's middle on both sides of its text (a compaction, a turn's end).
        case middle
        /// A hairline across the box over the row (a tool body's section).
        case top
        /// A hairline across the box under the row (a diff's path).
        case bottom
    }

    public var ink: DocInk
    public var dashed: Bool
    public var place: Place

    public init(ink: DocInk, dashed: Bool, place: Place = .middle) {
        self.ink = ink
        self.dashed = dashed
        self.place = place
    }
}

/// A box's look (each a class of conversation.css).
public enum DocBoxStyle: String, Hashable, Sendable {
    /// `.conversation-user-text`: the person's bubble, on the right.
    case bubble
    /// The bubble of a template's message: dashed, no fill.
    case bubbleDashed
    /// `.conversation-other`: a message not from the person.
    case other
    /// `.conversation-checklist`.
    case checklist
    /// `.conversation-markdown blockquote`.
    case quote
    /// `.conversation-thinking-text`, `.conversation-command-output`, a subagent's prompt rail.
    case rail
    case railDanger
    /// `.conversation-tool-body`: the sunken panel under an open call.
    case toolBody
    /// `.conversation-readable .conversation-diff`: a diff's panel.
    case diff
    /// `.conversation-subagent`: a subagent's card.
    case subagent
    /// `.conversation-subagent-entries`: the card's inside, under a hairline.
    case subagentEntries
    /// `.conversation-notice` (warning, error).
    case noticeWarning
    case noticeError
    /// `.conversation-request .conversation-json`: a code-ish panel inside a card.
    case sunkenPanel
    /// `.conversation-question-preview`.
    case preview
    /// `.conversation-question-option`: an option of a recorded question, as
    /// a row with a hairline; `[data-picked]` (the accent's border over its
    /// tint) and `[data-shown]` (its preview is the one beside the options).
    case option
    case optionPicked
    case optionShown
    /// Footnotes under an answer.
    case footnotes
    /// A plain group (an item's blocks, a cell).
    case plain
}

public struct DocBox: Hashable, Sendable {
    public var key: String
    public var style: DocBoxStyle
    public var children: [DocBlock]
    /// A fold: its id, and whether it is open now. Closed, only `summary` is drawn.
    public var fold: String?
    public var open = true
    /// Indent of the box from its parent's content edge, in em.
    public var indent: Double = 0
    /// Space around it, in em of the conversation's size.
    public var before: Double = 0
    public var after: Double = 0
    /// A Clip: cut to a height, fading, until opened.
    public var clip: DocClip?
    /// A subagent's inside past the third level: no more indentation, no side borders.
    public var flat = false
    /// A tooltip over the whole box (a message on its way: "Sending…").
    public var tooltip: String?
    /// At most this wide, in em (`max-width`), against the leading edge.
    public var maxWidth: Double?
    /// Its children are a question's options with the preview of one of them
    /// beside them (or under them, when the column is narrow).
    public var beside: DocBeside?
    /// An option of such a box: pointing at it shows its preview (its label).
    public var point: String?

    public init(key: String, style: DocBoxStyle, children: [DocBlock]) {
        self.key = key
        self.style = style
        self.children = children
    }
}

public struct DocClip: Hashable, Sendable {
    public var id: String
    public var open: Bool

    public init(id: String, open: Bool) {
        self.id = id
        self.open = open
    }
    /// `max-height` while closed, in em.
    public static let height: Double = 18
}

/// The preview beside a question's options (`QuestionLayout`'s
/// `data-previewed` body): the options are the box's children, in the text;
/// the preview of the option pointed at — else `resting`, else the first — is
/// drawn beside them in the column's right three fifths (`2fr 3fr`), or under
/// them when the column is under 34em.
public struct DocBeside: Hashable, Sendable {
    public struct Preview: Hashable, Sendable {
        public var label: String
        public var block: DocBlock

        public init(label: String, block: DocBlock) {
            self.label = label
            self.block = block
        }
    }

    public var key: String
    public var resting: String?
    public var previews: [Preview]

    public init(key: String, resting: String?, previews: [Preview]) {
        self.key = key
        self.resting = resting
        self.previews = previews
    }

    /// The preview shown while `pointed` is pointed at (nil: none is).
    public func shown(pointed: String?) -> Preview? {
        let label = pointed ?? resting ?? previews.first?.label
        return previews.first { $0.label == label } ?? previews.first
    }
}

/// A view drawn in the text: what a paragraph cannot be.
public enum DocEmbedKind: Hashable, Sendable {
    /// A fenced block: its language, its code, and whether it is closed (coloured).
    case code(language: String?, code: String, settled: Bool)
    /// A Markdown table: header first; each row padded or cut to the header's width.
    case table(align: [MarkdownAlign?], rows: [[[DocRun]]])
    /// `$$…$$`.
    case math(String)
    /// A request card, live.
    case request(PendingRequest)
    /// Images in a row of thumbnails, each opening to itself whole.
    case images([ImageRef])
    /// A Markdown image (`![alt](src)`).
    case remoteImage(source: String, alt: String)
    /// The line under a running turn (`ActivityLine`).
    case activity
    /// A message box for one subagent.
    case subagentMessage(entry: EntryId, label: String)
    /// A thematic break.
    case rule
    /// The quiet row of a message's actions (Copy, Rewind), at the trailing edge or leading.
    case actions([DocActionButton], align: DocAlign, hideWhileStreaming: Bool)
    /// The confirmation under a message (Rewind).
    case confirm(note: String, go: DocActionButton, cancel: DocActionButton)
    /// A subagent card's actions (Beside, Maximize).
    case subagentActions(entry: EntryId, label: String, canBeside: Bool, beside: Bool, canMaximize: Bool)
}

public struct DocActionButton: Hashable, Sendable {
    public var label: String
    public var icon: DocIcon?
    public var action: DocAction
    public var tooltip: String?
    public var accessibility: String?

    public init(label: String, icon: DocIcon?, action: DocAction, tooltip: String? = nil, accessibility: String? = nil) {
        self.label = label
        self.icon = icon
        self.action = action
        self.tooltip = tooltip
        self.accessibility = accessibility
    }
}

public struct DocEmbed: Hashable, Sendable {
    public var key: String
    public var kind: DocEmbedKind
    /// What the find bar reads in it.
    public var searchText: String
    /// What a copy of a selection over it takes.
    public var copyText: String
    public var before: Double = 0
    public var after: Double = 0

    public init(key: String, kind: DocEmbedKind, searchText: String, copyText: String) {
        self.key = key
        self.kind = kind
        self.searchText = searchText
        self.copyText = copyText
    }
}

public indirect enum DocBlock: Hashable, Sendable {
    case paragraph(DocParagraph)
    case box(DocBox)
    case embed(DocEmbed)

    public var key: String {
        switch self {
        case .paragraph(let p): return p.key
        case .box(let b): return b.key
        case .embed(let e): return e.key
        }
    }
}

/// One top-level part of the transcript.
public struct DocSection: Hashable, Sendable {
    public var id: String
    /// The entry's kind, for the gaps between entries (`user`, `tool`, `notice-info`…).
    public var kind: String
    public var blocks: [DocBlock]
    /// The section rises in once (`data-fresh`).
    public var fresh = false
    /// Dimmed: a message on its way (`data-sending`).
    public var dimmed = false
    /// The path candidates its words hold, to be asked about (`PathLinks.want`).
    public var candidates: [String] = []

    public init(id: String, kind: String, blocks: [DocBlock]) {
        self.id = id
        self.kind = kind
        self.blocks = blocks
    }

    /// The space before this section, in em, after a section of `previous` kind (conversation.css).
    public static func gap(after previous: String?, before kind: String) -> Double {
        guard let previous else { return 0 }
        let fontEm = 1 / SurfaceMetrics.fontPx
        if kind == "user" || kind == "answer" { return 20 * fontEm }
        if previous == "tool" && kind == "tool" { return 2 * fontEm }
        if kind == "notice-info" { return 4 * fontEm }
        return 12 * fontEm
    }
}

/// The px the stylesheet's spacing tokens are given in, against the
/// conversation's 15px: what an em of `--space-N` is.
public enum SurfaceMetrics {
    public static let fontPx: Double = 15
    public static func em(_ px: Double) -> Double { px / fontPx }

    /// `--conversation-measure: 74ch` and the gutter (`--space-5`).
    public static let measureCh: Double = 74
    public static let gutterPx: Double = 20
    /// `.conversation-transcript` padding: top 20, bottom 32.
    public static let paddingTop: Double = 20
    public static let paddingBottom: Double = 32
}

// MARK: - Reading a document

extension DocBlock {
    /// Every word of the block a find reaches, folds open, controls left out:
    /// its blocks apart by `BLOCK_BREAK`.
    public var searchParts: [(key: String, text: String)] {
        switch self {
        case .paragraph(let paragraph):
            if paragraph.control { return [] }
            let text = (paragraph.runs + paragraph.trailing).filter { !$0.style.control && $0.inline == nil }.map(\.text).joined()
            return text.isEmpty ? [] : [(paragraph.key, text)]
        case .box(let box):
            return box.children.flatMap(\.searchParts)
        case .embed(let embed):
            return embed.searchText.isEmpty ? [] : [(embed.key, embed.searchText)]
        }
    }

    /// What a copy of the whole block takes.
    public var copyText: String {
        switch self {
        case .paragraph(let paragraph):
            return (paragraph.marker.map { $0.text + " " } ?? "")
                + (paragraph.runs + paragraph.trailing).filter { !$0.style.control }.map { $0.inline == nil ? $0.text : "" }.joined()
        case .box(let box):
            return box.children.map(\.copyText).filter { !$0.isEmpty }.joined(separator: "\n")
        case .embed(let embed):
            return embed.copyText
        }
    }
}

extension DocSection {
    /// The section's text for the find bar, and where each part of it starts.
    public var search: (text: String, parts: [(key: String, offset: Int)]) {
        var text = ""
        var parts: [(key: String, offset: Int)] = []
        for part in blocks.flatMap(\.searchParts) {
            if !text.isEmpty { text += BLOCK_BREAK }
            parts.append((part.key, (text as NSString).length))
            text += part.text
        }
        return (text, parts)
    }

    /// Every fold, closed or open, by its id, with the keys of all it holds.
    public func folds(containing key: String) -> [String] {
        func walk(_ blocks: [DocBlock], _ open: [String]) -> [String]? {
            for block in blocks {
                switch block {
                case .paragraph(let p): if p.key == key { return open }
                case .embed(let e): if e.key == key { return open }
                case .box(let b):
                    var inner = open
                    if let fold = b.fold { inner.append(fold) }
                    if let clip = b.clip { inner.append("clip:" + clip.id) }
                    if b.key == key { return open }
                    if let found = walk(b.children, inner) { return found }
                }
            }
            return nil
        }
        return walk(blocks, []) ?? []
    }
}
