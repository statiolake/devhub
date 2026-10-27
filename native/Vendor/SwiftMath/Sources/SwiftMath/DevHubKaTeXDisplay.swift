// DevHub's addition to the vendored SwiftMath (not upstream): drawing what
// DevHubKaTeX.swift's commands set on an atom — a frame round an inner
// (`\boxed`, `\cancel`, `\phantom`, `\rlap`), a brace over or under an
// operator's nucleus (`\overbrace`), and an arrow as long as its labels
// (`\xrightarrow`). Drawn in the typesetter's coordinates: y up, from the
// baseline.

#if os(macOS) || os(iOS) || os(visionOS)
import Foundation
import CoreText
import QuartzCore

/// An inner display with a frame round it, a stroke through it, or not drawn.
final class DevHubFrameDisplay: MTDisplay {
    let inner: MTDisplay
    let frame: DevHubFrame
    /// The space between the frame and what it holds, and its rule.
    let pad: CGFloat
    let rule: CGFloat
    /// Where the inner starts from this display's position.
    let offset: CGFloat

    init(inner: MTDisplay, frame: DevHubFrame, fontSize: CGFloat) {
        self.inner = inner
        self.frame = frame
        // `\fboxsep` 0.3em, `\fboxrule` 0.04em (KaTeX's).
        pad = frame == .box ? 0.3 * fontSize : 0
        rule = max(0.5, 0.04 * fontSize)
        switch frame {
        case .llap: offset = -inner.width
        case .clap: offset = -inner.width / 2
        default: offset = pad
        }
        super.init()
        switch frame {
        case .hphantom:
            width = inner.width
        case .vphantom:
            ascent = inner.ascent
            descent = inner.descent
        case .rlap, .llap, .clap:
            ascent = inner.ascent
            descent = inner.descent
        default:
            width = inner.width + 2 * pad
            ascent = inner.ascent + pad
            descent = inner.descent + pad
        }
        range = inner.range
    }

    override var position: CGPoint {
        set {
            super.position = newValue
            inner.position = CGPoint(x: newValue.x + offset, y: newValue.y)
        }
        get { super.position }
    }

    override var textColor: MTColor? {
        set {
            super.textColor = newValue
            inner.textColor = newValue
        }
        get { super.textColor }
    }

    override func draw(_ context: CGContext) {
        switch frame {
        case .phantom, .hphantom, .vphantom: return
        default: break
        }
        inner.draw(context)
        guard frame != .rlap, frame != .llap, frame != .clap else { return }
        context.saveGState()
        if let colour = textColor { context.setStrokeColor(colour.cgColor) }
        context.setLineWidth(rule)
        let x = inner.position.x - (frame == .box ? pad : 0), y = position.y
        let box = CGRect(x: x, y: y - descent, width: frame == .box ? width : inner.width, height: ascent + descent)
        switch frame {
        case .box:
            context.stroke(box.insetBy(dx: rule / 2, dy: rule / 2))
        case .cancel, .bcancel, .xcancel:
            if frame != .bcancel {
                context.move(to: CGPoint(x: box.minX, y: box.minY))
                context.addLine(to: CGPoint(x: box.maxX, y: box.maxY))
            }
            if frame != .cancel {
                context.move(to: CGPoint(x: box.minX, y: box.maxY))
                context.addLine(to: CGPoint(x: box.maxX, y: box.minY))
            }
            context.strokePath()
        case .strike:
            let middle = y + (inner.ascent - inner.descent) / 2
            context.move(to: CGPoint(x: box.minX, y: middle))
            context.addLine(to: CGPoint(x: box.maxX, y: middle))
            context.strokePath()
        default:
            break
        }
        context.restoreGState()
    }
}

/// A rule along the math axis: an arrow's shaft.
final class DevHubRuleDisplay: MTDisplay {
    let thickness: CGFloat
    let axis: CGFloat

    init(width: CGFloat, axis: CGFloat, thickness: CGFloat) {
        self.thickness = thickness
        self.axis = axis
        super.init()
        self.width = width
        ascent = max(0, axis + thickness / 2)
        descent = max(0, thickness / 2 - axis)
    }

    override func draw(_ context: CGContext) {
        context.saveGState()
        if let colour = textColor { context.setFillColor(colour.cgColor) }
        context.fill(CGRect(x: position.x, y: position.y + axis - thickness / 2, width: width, height: thickness))
        context.restoreGState()
    }
}

extension MTTypesetter {
    /// `\boxed` and friends round an inner's display.
    func devhubFramed(_ display: MTDisplay, _ frame: DevHubFrame) -> MTDisplay {
        DevHubFrameDisplay(inner: display, frame: frame, fontSize: styleFont.fontSize)
    }

    /// A glyph of `character` in the style's font, with its extent.
    private func devhubGlyph(_ character: String, maxWidth: CGFloat? = nil) -> MTGlyphDisplay {
        var glyph = self.findGlyphForCharacterAtIndex(character.startIndex, inString: character)
        var ascent = CGFloat(0), descent = CGFloat(0), width = CGFloat(0)
        if let maxWidth {
            glyph = self.findVariantGlyph(glyph, withMaxWidth: maxWidth, maxWidth: &ascent, glyphDescent: &descent, glyphWidth: &width)
        } else {
            let bbox = CTFontGetBoundingRectsForGlyphs(styleFont.ctFont, .horizontal, &glyph, nil, 1)
            width = CTFontGetAdvancesForGlyphs(styleFont.ctFont, .horizontal, &glyph, nil, 1)
            getBboxDetails(bbox, ascent: &ascent, descent: &descent)
        }
        let display = MTGlyphDisplay(withGlpyh: glyph, range: NSMakeRange(0, 0), font: styleFont)
        display.ascent = ascent
        display.descent = descent
        display.width = width
        return display
    }

    /// An operator's nucleus with its brace, or the arrow its labels need.
    func devhubStretched(_ base: MTDisplay, _ stretch: DevHubStretch, _ op: MTLargeOperator) -> MTDisplay {
        let em = styleFont.fontSize
        switch stretch {
        case .overbrace, .underbrace:
            // The widest of the font's braces that is no wider than what it is over, 0.1em off it.
            let over = stretch == .overbrace
            let brace = devhubGlyph(over ? "\u{23DE}" : "\u{23DF}", maxWidth: base.width)
            let gap = 0.1 * em
            base.position = CGPoint(x: max(0, (brace.width - base.width) / 2), y: 0)
            brace.position = CGPoint(
                x: max(0, (base.width - brace.width) / 2),
                y: over ? base.ascent + gap + brace.descent : -(base.descent + gap + brace.ascent))
            return MTMathListDisplay(withDisplays: [base, brace], range: op.indexRange)
        case .rightArrow, .leftArrow, .bothArrow:
            // `.x-arrow-pad`: the labels with 0.5em either side; at least 1.469em.
            var labels = CGFloat(0)
            if let over = op.superScript, let line = MTTypesetter.createLineForMathList(over, font: font, style: self.scriptStyle(), cramped: self.superScriptCramped()) {
                labels = max(labels, line.width)
            }
            if let under = op.subScript, let line = MTTypesetter.createLineForMathList(under, font: font, style: self.scriptStyle(), cramped: self.subscriptCramped()) {
                labels = max(labels, line.width)
            }
            let width = max(labels + em, 1.469 * em)
            let axis = styleFont.mathTable!.axisHeight
            let thickness = styleFont.mathTable!.fractionRuleThickness
            var parts: [MTDisplay] = []
            var shaftStart = CGFloat(0), shaftEnd = width
            if stretch != .rightArrow {
                let head = devhubGlyph("\u{2190}")
                head.position = .zero
                parts.append(head)
                shaftStart = head.width * 0.5
            }
            if stretch != .leftArrow {
                let head = devhubGlyph("\u{2192}")
                head.position = CGPoint(x: width - head.width, y: 0)
                parts.append(head)
                shaftEnd = width - head.width * 0.5
            }
            let shaft = DevHubRuleDisplay(width: max(0, shaftEnd - shaftStart), axis: axis, thickness: thickness)
            shaft.position = CGPoint(x: shaftStart, y: 0)
            parts.insert(shaft, at: 0)
            return MTMathListDisplay(withDisplays: parts, range: op.indexRange)
        }
    }
}
#endif
