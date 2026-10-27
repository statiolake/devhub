// DevHub's addition to the vendored SwiftMath (not upstream): one call that
// typesets a formula and hands back the picture with where its baseline is,
// so a conversation can set inline math on the line of the text around it.
// The display list's position and colour are internal to this module, which
// is why this lives here rather than in the app.

#if os(macOS)
import AppKit

/// A typeset formula: its picture, and its extent about the baseline.
public struct MTTypesetFormula {
    public let image: NSImage
    /// From the baseline up to the top of the picture.
    public let ascent: CGFloat
    /// From the baseline down to the bottom of the picture.
    public let descent: CGFloat
    public var width: CGFloat { image.size.width }
    /// A display formula's `\tag`, drawn at the column's right edge: its picture and ascent.
    public var tag: (image: NSImage, ascent: CGFloat)?
}

public enum MTTypeset {
    /// Whether `latex` parses as KaTeX would parse it (inline or display):
    /// what does not is drawn as its source, as KaTeX does with
    /// `throwOnError: false`. Cached: a transcript asks often.
    public static func parses(_ latex: String, display: Bool) -> Bool {
        let key = (display ? "D" : "I") + latex
        if let known = parsed[key] { return known }
        let made = list(latex, display: display) != nil
        if parsed.count > 2000 { parsed = [:] }
        parsed[key] = made
        return made
    }

    nonisolated(unsafe) private static var parsed: [String: Bool] = [:]

    /// The math list of `latex`, KaTeX's commands included (DevHubKaTeX.swift),
    /// and its `\tag` as KaTeX draws it (display only; inline it does not parse).
    private static func list(_ latex: String, display: Bool) -> (list: MTMathList, tag: String?)? {
        var source = latex
        var tag: String?
        if let found = DevHubKaTeX.tag(in: latex) {
            guard display else { return nil }
            source = found.rest
            tag = found.tag
        }
        var builder = MTMathListBuilder(string: source)
        builder.devhubDisplay = display
        guard let list = builder.build(), builder.error == nil else { return nil }
        return (list, tag)
    }

    /// `latex` set in Latin Modern Math at `fontSize`, in `color` — the text
    /// style for inline math, the display style for a block — or nil when it
    /// does not parse (the caller draws its source, as KaTeX does with
    /// `throwOnError: false`). A display formula's `\tag` comes back as its own
    /// picture, for the right edge of the column.
    public static func formula(_ latex: String, fontSize: CGFloat, color: NSColor, display: Bool) -> MTTypesetFormula? {
        guard let parsed = list(latex, display: display),
              let font = MTFontManager.fontManager.latinModernFont(withSize: fontSize)
        else { return nil }
        var made = picture(parsed.list, font: font, color: color, style: display ? .display : .text)
        if let tag = parsed.tag {
            var builder = MTMathListBuilder(string: "\\text{\(tag)}")
            if let list = builder.build(), builder.error == nil, let drawn = picture(list, font: font, color: color, style: .text) {
                made?.tag = (drawn.image, drawn.ascent)
            }
        }
        return made
    }

    private static func picture(_ list: MTMathList, font: MTFont, color: NSColor, style: MTLineStyle) -> MTTypesetFormula? {
        guard let line = MTTypesetter.createLineForMathList(list, font: font, style: style) else { return nil }
        line.textColor = color
        let ascent = ceil(max(0, line.ascent)) + 1
        let descent = ceil(max(0, line.descent)) + 1
        let width = ceil(line.width) + 2
        guard line.width > 0 else { return nil }
        line.position = CGPoint(x: 1, y: descent)
        let image = NSImage(size: NSSize(width: width, height: ascent + descent), flipped: false) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.saveGState()
            line.draw(context)
            context.restoreGState()
            return true
        }
        return MTTypesetFormula(image: image, ascent: ascent, descent: descent)
    }
}
#endif
