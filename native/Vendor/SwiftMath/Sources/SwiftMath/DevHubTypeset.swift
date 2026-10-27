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
}

public enum MTTypeset {
    /// `latex` set in Latin Modern Math at `fontSize`, in `color` — the text
    /// style for inline math, the display style for a block — or nil when it
    /// does not parse (the caller draws its source, as KaTeX does with
    /// `throwOnError: false`).
    public static func formula(_ latex: String, fontSize: CGFloat, color: NSColor, display: Bool) -> MTTypesetFormula? {
        var error: NSError?
        guard let list = MTMathListBuilder.build(fromString: latex, error: &error), error == nil,
              let font = MTFontManager.fontManager.latinModernFont(withSize: fontSize),
              let line = MTTypesetter.createLineForMathList(list, font: font, style: display ? .display : .text)
        else { return nil }
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
