// The field of every place a GUI Agent's words are written to send: the
// composer, a waiting message being changed, a message to a subagent, and an
// answer typed into a request (messageKeys.ts).
//
// One rule for all of them. Return, with Shift or without, is a new line, as
// it is in any text on the Mac; ⌘Return sends — or saves, or answers. A key
// pressed while an input method is still composing is the input method's: it
// neither sends nor reaches the field's own keys, so Return confirms the
// conversion and nothing else. AppKit gives the field a key only once the
// input method has let it go (`doCommand(by:)` is not called for a key the
// input method consumes), and ⌘Return is refused while text is marked.

import AppKit
import DevHubCore

final class ComposerTextView: NSTextView {
    /// ⌘Return.
    var onSubmit: (() -> Void)?
    /// The text changed (typing, a paste, a cut).
    var onChange: (() -> Void)?
    /// A key the field may take for its own (↑ ↓ Tab Esc Return): whether it did.
    var onCommand: ((Selector) -> Bool)?
    /// Images pasted or dropped: whether they were taken.
    var onImages: (([NSPasteboard.ReadingOptionKey: Any], NSPasteboard) -> Bool)?
    /// The keyboard left the field.
    var onBlur: (() -> Void)?
    var onFocus: (() -> Void)?
    /// Other keys the owner handles first (⌘⇧M for dictation).
    var onKey: ((NSEvent) -> Bool)?
    var placeholder = "" { didSet { needsDisplay = true } }
    var placeholderColor: NSColor = .tertiaryLabelColor
    /// Ranges to tint (recognised command names), with their ground and ink.
    var tints: [(NSRange, NSColor, NSColor)] = [] { didSet { applyTints() } }
    private var baseAttributes: [NSAttributedString.Key: Any] = [:]

    /// A field on TextKit 1 (its tints are the layout manager's temporary attributes).
    @MainActor
    static func make() -> ComposerTextView {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: 300, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        let view = ComposerTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 24), textContainer: container)
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.smartInsertDeleteEnabled = false
        view.drawsBackground = false
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainerInset = NSSize(width: 0, height: 2)
        view.registerForDraggedTypes([.fileURL, .png, .tiff])
        return view
    }

    @MainActor
    func apply(_ style: ConversationStyle, size: CGFloat? = nil) {
        let font = style.sans(size ?? style.fontSize)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineHeightMultiple = 1.55 * font.pointSize / max(1, font.ascender - font.descender + font.leading)
        baseAttributes = [.font: font, .foregroundColor: style.ink(.primary), .paragraphStyle: paragraph]
        typingAttributes = baseAttributes
        textStorage?.setAttributes(baseAttributes, range: NSRange(location: 0, length: textStorage?.length ?? 0))
        insertionPointColor = style.ink(.primary)
        selectedTextAttributes = [.backgroundColor: style.tokens.selection.nsColor]
        placeholderColor = style.ink(.tertiary)
        applyTints()
        needsDisplay = true
    }

    /// The text's laid-out height.
    @MainActor
    var contentHeight: CGFloat {
        guard let layout = layoutManager, let container = textContainer else { return 20 }
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container).height
        let line = (baseAttributes[.font] as? NSFont).map { $0.pointSize * 1.55 } ?? 20
        return ceil(max(used, line)) + 2 * textContainerInset.height
    }

    @MainActor
    private func applyTints() {
        guard let layout = layoutManager, let storage = textStorage else { return }
        let whole = NSRange(location: 0, length: storage.length)
        layout.removeTemporaryAttribute(.backgroundColor, forCharacterRange: whole)
        layout.removeTemporaryAttribute(.foregroundColor, forCharacterRange: whole)
        guard !hasMarkedText() else { return }
        for (range, ground, ink) in tints where NSMaxRange(range) <= storage.length {
            layout.addTemporaryAttribute(.backgroundColor, value: ground, forCharacterRange: range)
            layout.addTemporaryAttribute(.foregroundColor, value: ink, forCharacterRange: range)
        }
    }

    override func didChangeText() {
        super.didChangeText()
        MainActor.assumeIsolated {
            if !hasMarkedText() { typingAttributes = baseAttributes }
            onChange?()
        }
    }

    override func unmarkText() {
        super.unmarkText()
        MainActor.assumeIsolated { onChange?() }
    }

    override func keyDown(with event: NSEvent) {
        let handled = MainActor.assumeIsolated { () -> Bool in
            if hasMarkedText() { return false }
            if onKey?(event) == true { return true }
            if Self.isSendKey(event) {
                onSubmit?()
                return true
            }
            return false
        }
        if !handled { super.keyDown(with: event) }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let handled = MainActor.assumeIsolated { () -> Bool in
            guard window?.firstResponder === self, !hasMarkedText() else { return false }
            if Self.isSendKey(event) {
                onSubmit?()
                return true
            }
            return onKey?(event) == true
        }
        return handled || super.performKeyEquivalent(with: event)
    }

    /// ⌘Return, and no other modifier.
    nonisolated static func isSendKey(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        return event.type == .keyDown && (event.keyCode == 36 || event.keyCode == 76) && flags.contains(.command)
            && !flags.contains(.shift) && !flags.contains(.option) && !flags.contains(.control)
    }

    override func doCommand(by selector: Selector) {
        let handled = MainActor.assumeIsolated { onCommand?(selector) == true }
        if handled { return }
        // Return and Shift-Return are new lines, never a send.
        if selector == #selector(insertNewlineIgnoringFieldEditor(_:)) {
            super.doCommand(by: #selector(insertNewline(_:)))
            return
        }
        super.doCommand(by: selector)
    }

    override func paste(_ sender: Any?) {
        let taken = MainActor.assumeIsolated { onImages?([.urlReadingFileURLsOnly: true], .general) == true }
        if !taken { pasteAsPlainText(sender) }
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        nonisolated(unsafe) let board = sender.draggingPasteboard
        let taken = MainActor.assumeIsolated { onImages?([.urlReadingFileURLsOnly: true], board) == true }
        return taken || super.performDragOperation(sender)
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { MainActor.assumeIsolated { onFocus?() } }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { MainActor.assumeIsolated { onBlur?() } }
        return resigned
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        MainActor.assumeIsolated {
            guard string.isEmpty, !hasMarkedText(), !placeholder.isEmpty else { return }
            var attributes = baseAttributes
            attributes[.foregroundColor] = placeholderColor
            let rect = NSRect(x: textContainerInset.width, y: textContainerInset.height, width: bounds.width - 2 * textContainerInset.width, height: bounds.height)
            (placeholder as NSString).draw(with: rect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes)
        }
    }

    /// Replace the whole text, the caret at `caret` (default: the end).
    @MainActor
    func setText(_ text: String, caret: Int? = nil) {
        string = text
        textStorage?.setAttributes(baseAttributes, range: NSRange(location: 0, length: textStorage?.length ?? 0))
        let at = min(caret ?? (text as NSString).length, (text as NSString).length)
        setSelectedRange(NSRange(location: at, length: 0))
        applyTints()
        needsDisplay = true
    }

    @MainActor
    var caret: Int { selectedRange().location }
}

/// The images on a pasteboard, as the composer attaches them: each a PNG,
/// JPEG, GIF or WebP's own bytes. A file of another kind refuses the lot, naming it.
enum PastedImages {
    static func read(_ board: NSPasteboard, options: [NSPasteboard.ReadingOptionKey: Any]) -> Result<[ImageRef], ImageRefusal>? {
        if let urls = board.readObjects(forClasses: [NSURL.self], options: options) as? [URL], !urls.isEmpty {
            var images: [ImageRef] = []
            for url in urls {
                let type = mediaType(url.pathExtension)
                guard let type, SENDABLE_IMAGE_TYPES.contains(type), let data = try? Data(contentsOf: url) else {
                    return .failure(ImageRefusal(message: ComposerWords.imageRefusal(url.lastPathComponent)))
                }
                images.append(ImageRef(mediaType: type, source: .data(base64: data.base64EncodedString()), label: url.lastPathComponent))
            }
            return .success(images)
        }
        if let png = board.data(forType: .png) {
            return .success([ImageRef(mediaType: "image/png", source: .data(base64: png.base64EncodedString()), label: "Pasted image.png")])
        }
        if let tiff = board.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
            return .success([ImageRef(mediaType: "image/png", source: .data(base64: png.base64EncodedString()), label: "Pasted image.png")])
        }
        return nil
    }

    static func mediaType(_ ext: String) -> String? {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        default: return nil
        }
    }
}

/// A file that is not an image a model takes, named.
struct ImageRefusal: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}
