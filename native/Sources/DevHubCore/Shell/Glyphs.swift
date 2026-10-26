// Port of apps/desktop/src/shell/components/sidebar/icons.tsx (every mark the
// Sidebar draws, on one grid), the title bar's marks of
// shell/components/shell/TitleBar.tsx and the surface states' glyphs of
// SurfaceState.tsx — as data, with an SVG path-data reader so the App draws
// the same outlines with Core Graphics.
//
// The convention is icons.tsx's and it is the whole of what a Sidebar mark
// may be: a 16-unit box with the drawing inside the 12 units from 2 to 14;
// stroked, never filled — round caps and joins, one weight — except the dots
// and GitHub's six Octicons (verbatim from @primer/octicons v19, MIT, GitHub
// Inc.), which are filled; colour is the holder's, always.

import Foundation

/// One element of a mark.
public enum GlyphShape: Equatable, Sendable {
    /// SVG path data; `filled` is `.glyph-fill`.
    case path(String, filled: Bool)
    case circle(cx: Double, cy: Double, r: Double, filled: Bool)
    case rect(x: Double, y: Double, width: Double, height: Double, radius: Double)
}

/// A drawing on its box.
public struct GlyphDrawing: Equatable, Sendable {
    /// The view box's side: 16 for every Sidebar mark, 32 for the surface
    /// states' large glyphs.
    public var box: Double
    public var shapes: [GlyphShape]

    public init(box: Double = 16, _ shapes: [GlyphShape]) {
        self.box = box
        self.shapes = shapes
    }
}

/// The marks that are not the Sidebar's (`TitleBar.tsx`, `SurfaceState.tsx`).
public enum ChromeGlyph: Sendable, Hashable {
    case sidebar
    case back
    case forward
    /// The failure state's triangle (32-unit box).
    case failure
    /// The empty state's folder (32-unit box).
    case empty
}

public enum Glyphs {
    static func path(_ d: String) -> GlyphShape { .path(d, filled: false) }
    static func fill(_ d: String) -> GlyphShape { .path(d, filled: true) }

    /// `GLYPHS`.
    public static func drawing(_ glyph: RowGlyph) -> GlyphDrawing {
        switch glyph {
        case .trash:
            return GlyphDrawing([path("M2.86 4.57h10.28M6.29 4.57V3.43c0-.32.25-.57.57-.57h2.28c.32 0 .58.25.58.57v1.14M4 4.57l.57 7.72c.02.3.27.53.57.53h5.72c.3 0 .55-.23.57-.53l.57-7.72")])
        case .repository:
            return GlyphDrawing([path("M8 2.6 13.4 5.5v5L8 13.4 2.6 10.5v-5Z"), path("M8 13.4V8M8 8 2.6 5.5M8 8l5.4-2.5")])
        case .worktree:
            return GlyphDrawing([
                path("M10 6V3.8c0-.66-.54-1.2-1.2-1.2H3.8c-.66 0-1.2.54-1.2 1.2v5c0 .66.54 1.2 1.2 1.2H6"),
                path("M7.2 6h5c.66 0 1.2.54 1.2 1.2v5c0 .66-.54 1.2-1.2 1.2h-5A1.2 1.2 0 0 1 6 12.2v-5C6 6.54 6.54 6 7.2 6Z"),
            ])
        case .folder:
            return GlyphDrawing([path("M1.71 4a1.14 1.14 0 0 1 1.15-1.14h3.43l1.6 1.83h5.26a1.14 1.14 0 0 1 1.14 1.14v6.17a1.14 1.14 0 0 1-1.14 1.14H2.86a1.14 1.14 0 0 1-1.15-1.14z")])
        case .remote:
            return GlyphDrawing([path("M2.29 3.43h11.42v3.43H2.29zM2.29 9.14h11.42v3.43H2.29zM4.57 5.14h.01M4.57 10.86h.01")])
        case .container:
            return GlyphDrawing([path("M2.29 4.57h11.42v6.86H2.29zM5.71 4.57v6.86M8 4.57v6.86M10.29 4.57v6.86")])
        case .terminal:
            return GlyphDrawing([path("M2.5 4.5 6.5 8l-4 3.5M8.75 11.5h4.75")])
        case .plus:
            return GlyphDrawing([path("M8 3.25v9.5M3.25 8h9.5")])
        case .close, .checksFailing:
            return GlyphDrawing([path("M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5")])
        case .issueOpen:
            return GlyphDrawing([
                fill("M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"),
                fill("M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"),
            ])
        case .issueClosed:
            return GlyphDrawing([
                fill("M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"),
                fill("M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"),
            ])
        case .pullRequest:
            return GlyphDrawing([fill("M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z")])
        case .pullRequestDraft:
            return GlyphDrawing([fill("M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z")])
        case .pullRequestClosed:
            return GlyphDrawing([fill("M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z")])
        case .pullRequestMerged:
            return GlyphDrawing([fill("M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z")])
        case .conversation, .statusWaiting:
            return GlyphDrawing([path("M4 3.5h8a1.75 1.75 0 0 1 1.75 1.75v3.5A1.75 1.75 0 0 1 12 10.5H7.2L4 13v-2.5A1.75 1.75 0 0 1 2.25 8.75v-3.5A1.75 1.75 0 0 1 4 3.5Z")])
        case .checksPassing, .statusIdle:
            return GlyphDrawing([path("M3.4 8.35 6.35 11.3 12.6 4.85")])
        case .checksPending:
            return GlyphDrawing([.circle(cx: 8, cy: 8, r: 4, filled: true)])
        case .openIssue:
            return GlyphDrawing([.circle(cx: 8, cy: 8, r: 5.25, filled: false), .circle(cx: 8, cy: 8, r: 1.55, filled: true)])
        case .statusWorking:
            return GlyphDrawing([path("M8 2.75A5.25 5.25 0 1 1 2.75 8")])
        case .statusBackground:
            return GlyphDrawing([path("M9.62 3.01A5.25 5.25 0 0 1 12.99 6.38M12.99 9.62A5.25 5.25 0 0 1 9.62 12.99M6.38 12.99A5.25 5.25 0 0 1 3.01 9.62M3.01 6.38A5.25 5.25 0 0 1 6.38 3.01")])
        case .statusError:
            return GlyphDrawing([path("M8 2.9 14.1 13.1H1.9Z"), path("M8 6.6v2.7"), .circle(cx: 8, cy: 11.3, r: 0.8, filled: true)])
        case .statusUnknown:
            return GlyphDrawing([.circle(cx: 8, cy: 8, r: 5.25, filled: false), path("M5.6 8h4.8")])
        case .statusUnread:
            return GlyphDrawing([.circle(cx: 8, cy: 8, r: 3.1, filled: true)])
        case .branch:
            return GlyphDrawing([
                path("M4.5 3.5v9"),
                .circle(cx: 4.5, cy: 2.6, r: 1.35, filled: false),
                .circle(cx: 11.5, cy: 2.6, r: 1.35, filled: false),
                .circle(cx: 4.5, cy: 13.4, r: 1.35, filled: false),
                path("M11.5 3.95v1.3a2.5 2.5 0 0 1-2.5 2.5H7a2.5 2.5 0 0 0-2.5 2.5"),
            ])
        }
    }

    public static func drawing(_ glyph: ChromeGlyph) -> GlyphDrawing {
        switch glyph {
        case .sidebar:
            return GlyphDrawing([.rect(x: 2, y: 3, width: 12, height: 10, radius: 2), path("M6.5 3v10")])
        case .back:
            return GlyphDrawing([path("M10 3.5 5.5 8l4.5 4.5")])
        case .forward:
            return GlyphDrawing([path("M6 3.5 10.5 8 6 12.5")])
        case .failure:
            return GlyphDrawing(box: 32, [path("M16 4.6 30 27.4H2z"), path("M16 13v6M16 22.4v.8")])
        case .empty:
            return GlyphDrawing(box: 32, [path("M3.5 9a2 2 0 0 1 2-2h6.4l2.8 3.2H26.5a2 2 0 0 1 2 2V24a2 2 0 0 1-2 2h-21a2 2 0 0 1-2-2z")])
        }
    }

    /// The glyph a status is drawn with (`GLYPH_FOR`), and the unread mark in
    /// place of idle (`unreadShows`).
    public static func status(_ status: AgentStatus, unread: Bool) -> RowGlyph {
        if unread && status == .idle { return .statusUnread }
        switch status {
        case .working: return .statusWorking
        case .background: return .statusBackground
        case .waiting: return .statusWaiting
        case .idle: return .statusIdle
        case .error: return .statusError
        case .unknown: return .statusUnknown
        }
    }
}

// MARK: - SVG path data

/// One step of an outline, in absolute coordinates; arcs are already curves.
public enum PathCommand: Equatable, Sendable {
    case move(x: Double, y: Double)
    case line(x: Double, y: Double)
    case cubic(x1: Double, y1: Double, x2: Double, y2: Double, x: Double, y: Double)
    case close
}

public struct PathDataError: Error, Equatable, CustomStringConvertible {
    public let text: String
    public var description: String { "unreadable path data near: \(text)" }
}

/// An SVG `d` attribute reader: every command (M L H V C S Q T A Z, absolute
/// and relative), quadratics raised to cubics and elliptical arcs converted to
/// cubic segments, so a view needs only move/line/curve/close.
public enum PathData {
    public static func parse(_ d: String) throws -> [PathCommand] {
        var scanner = Tokens(Array(d.unicodeScalars))
        var commands: [PathCommand] = []
        var current = (x: 0.0, y: 0.0)
        var start = (x: 0.0, y: 0.0)
        var lastCubicControl: (x: Double, y: Double)?
        var lastQuadControl: (x: Double, y: Double)?
        var command: Character?
        while true {
            scanner.skipSeparators()
            guard let next = scanner.peek() else { break }
            if next.isLetter {
                command = Character(next)
                scanner.advance()
            } else if command == nil {
                throw PathDataError(text: scanner.rest)
            } else if command == "M" {
                command = "L"
            } else if command == "m" {
                command = "l"
            }
            guard let op = command else { break }
            let relative = op.isLowercase
            func point() throws -> (x: Double, y: Double) {
                let x = try scanner.number(), y = try scanner.number()
                return relative ? (current.x + x, current.y + y) : (x, y)
            }
            var cubic: (x: Double, y: Double)?
            var quad: (x: Double, y: Double)?
            switch op.uppercased() {
            case "M":
                let p = try point()
                commands.append(.move(x: p.x, y: p.y))
                current = p
                start = p
            case "L":
                let p = try point()
                commands.append(.line(x: p.x, y: p.y))
                current = p
            case "H":
                let x = try scanner.number()
                current.x = relative ? current.x + x : x
                commands.append(.line(x: current.x, y: current.y))
            case "V":
                let y = try scanner.number()
                current.y = relative ? current.y + y : y
                commands.append(.line(x: current.x, y: current.y))
            case "C":
                let c1 = try point(), c2 = try point(), p = try point()
                commands.append(.cubic(x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y))
                current = p
                cubic = c2
            case "S":
                let c1 = lastCubicControl.map { (x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let c2 = try point(), p = try point()
                commands.append(.cubic(x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y))
                current = p
                cubic = c2
            case "Q":
                let q = try point(), p = try point()
                commands.append(raise(from: current, control: q, to: p))
                current = p
                quad = q
            case "T":
                let q = lastQuadControl.map { (x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let p = try point()
                commands.append(raise(from: current, control: q, to: p))
                current = p
                quad = q
            case "A":
                let rx = try scanner.number(), ry = try scanner.number(), rotation = try scanner.number()
                let large = try scanner.flag(), sweep = try scanner.flag()
                let p = try point()
                commands += arc(from: current, to: p, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
                current = p
            case "Z":
                commands.append(.close)
                current = start
                command = nil
            default:
                throw PathDataError(text: String(op))
            }
            lastCubicControl = cubic
            lastQuadControl = quad
        }
        return commands
    }

    static func raise(from p0: (x: Double, y: Double), control q: (x: Double, y: Double), to p: (x: Double, y: Double)) -> PathCommand {
        .cubic(
            x1: p0.x + 2.0 / 3.0 * (q.x - p0.x), y1: p0.y + 2.0 / 3.0 * (q.y - p0.y),
            x2: p.x + 2.0 / 3.0 * (q.x - p.x), y2: p.y + 2.0 / 3.0 * (q.y - p.y),
            x: p.x, y: p.y
        )
    }

    /// The SVG endpoint arc as cubic Béziers (SVG 1.1 implementation notes,
    /// F.6.5: endpoint to centre parameterisation), one curve per ≤ 90°.
    static func arc(
        from p0: (x: Double, y: Double), to p1: (x: Double, y: Double), rx rxIn: Double, ry ryIn: Double,
        rotation: Double, large: Bool, sweep: Bool
    ) -> [PathCommand] {
        if p0.x == p1.x && p0.y == p1.y { return [] }
        var rx = abs(rxIn), ry = abs(ryIn)
        if rx == 0 || ry == 0 { return [.line(x: p1.x, y: p1.y)] }
        let phi = rotation * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1p = cosPhi * dx + sinPhi * dy
        let y1p = -sinPhi * dx + cosPhi * dy
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            rx *= lambda.squareRoot()
            ry *= lambda.squareRoot()
        }
        let numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        var factor = denominator == 0 ? 0 : max(0, numerator / denominator).squareRoot()
        if large == sweep { factor = -factor }
        let cxp = factor * rx * y1p / ry
        let cyp = -factor * ry * x1p / rx
        let cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2
        func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
            let sign: Double = ux * vy - uy * vx < 0 ? -1 : 1
            let dot = ux * vx + uy * vy
            let length = (ux * ux + uy * uy).squareRoot() * (vx * vx + vy * vy).squareRoot()
            return sign * acos(max(-1, min(1, dot / length)))
        }
        let ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry
        let vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry
        let theta1 = angle(1, 0, ux, uy)
        var delta = angle(ux, uy, vx, vy)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int((abs(delta) / (.pi / 2)).rounded(.up)))
        let step = delta / Double(segments)
        let k = 4.0 / 3.0 * tan(step / 4)
        var commands: [PathCommand] = []
        var theta = theta1
        func onEllipse(_ t: Double) -> (x: Double, y: Double) {
            (cx + rx * cos(t) * cosPhi - ry * sin(t) * sinPhi, cy + rx * cos(t) * sinPhi + ry * sin(t) * cosPhi)
        }
        func derivative(_ t: Double) -> (x: Double, y: Double) {
            (-rx * sin(t) * cosPhi - ry * cos(t) * sinPhi, -rx * sin(t) * sinPhi + ry * cos(t) * cosPhi)
        }
        for index in 0..<segments {
            let next = theta + step
            let a = onEllipse(theta), b = index == segments - 1 ? p1 : onEllipse(next)
            let da = derivative(theta), db = derivative(next)
            commands.append(.cubic(
                x1: a.x + k * da.x, y1: a.y + k * da.y,
                x2: b.x - k * db.x, y2: b.y - k * db.y,
                x: b.x, y: b.y
            ))
            theta = next
        }
        return commands
    }

    /// The reader's cursor over the attribute's text.
    struct Tokens {
        let scalars: [Unicode.Scalar]
        var index = 0

        init(_ scalars: [Unicode.Scalar]) { self.scalars = scalars }

        var rest: String { String(String.UnicodeScalarView(scalars[index...].prefix(20))) }

        func peek() -> Unicode.Scalar? { index < scalars.count ? scalars[index] : nil }
        mutating func advance() { index += 1 }

        mutating func skipSeparators() {
            while let scalar = peek(), scalar == " " || scalar == "," || scalar == "\n" || scalar == "\t" || scalar == "\r" {
                advance()
            }
        }

        /// A flag of an arc: one digit, which may run straight into the next
        /// number (`0 1 0 0 1.5…` is written `a1.5 1.5 0 1 0 0 3`, or `01`).
        mutating func flag() throws -> Bool {
            skipSeparators()
            guard let scalar = peek(), scalar == "0" || scalar == "1" else { throw PathDataError(text: rest) }
            advance()
            return scalar == "1"
        }

        mutating func number() throws -> Double {
            skipSeparators()
            var text = ""
            var sawDot = false, sawExponent = false, sawDigit = false
            if let sign = peek(), sign == "-" || sign == "+" {
                text.unicodeScalars.append(sign)
                advance()
            }
            while let scalar = peek() {
                if ("0"..."9").contains(scalar) {
                    sawDigit = true
                } else if scalar == "." && !sawDot && !sawExponent {
                    sawDot = true
                } else if (scalar == "e" || scalar == "E") && sawDigit && !sawExponent {
                    sawExponent = true
                    text.unicodeScalars.append(scalar)
                    advance()
                    if let sign = peek(), sign == "-" || sign == "+" {
                        text.unicodeScalars.append(sign)
                        advance()
                    }
                    continue
                } else {
                    break
                }
                text.unicodeScalars.append(scalar)
                advance()
            }
            guard sawDigit, let value = Double(text) else { throw PathDataError(text: rest) }
            return value
        }
    }
}

extension Unicode.Scalar {
    fileprivate var isLetter: Bool { ("a"..."z").contains(self) || ("A"..."Z").contains(self) }
}
