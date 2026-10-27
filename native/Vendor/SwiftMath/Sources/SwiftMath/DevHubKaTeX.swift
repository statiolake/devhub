// DevHub's addition to the vendored SwiftMath (not upstream): the KaTeX
// commands, symbols and environments a conversation's math uses that
// SwiftMath does not have, so that what KaTeX typesets in the TS app is
// typeset here too, and what KaTeX refuses is refused here too (and drawn as
// its source, as KaTeX does with `throwOnError: false`).
//
// The parser's and the factory's own tables call into this file at four
// places (marked `DevHub:` there): an unknown command, an unknown symbol,
// `\begin{…}`, and a table's environment. What needs drawing of its own —
// a sized delimiter, an operator with limits in every style, a frame — is
// set on the atom (`devhubClass` and friends, MTMathList.swift) and drawn by
// MTTypesetter and DevHubKaTeXDisplay.swift.
//
// Foundation only, so the parser can be checked on Linux too.

import Foundation

/// How an inner is drawn besides its list (`\boxed`, `\cancel`, `\phantom`…).
public enum DevHubFrame: Equatable {
    /// `\boxed`, `\fbox`: a 0.04em rule 0.3em round it.
    case box
    /// `\cancel` (/), `\bcancel` (\), `\xcancel` (X), `\sout` (—).
    case cancel, bcancel, xcancel, strike
    /// `\phantom`: its room and nothing drawn; `\hphantom` its width only; `\vphantom` its height only.
    case phantom, hphantom, vphantom
    /// `\rlap`, `\llap`, `\clap`: drawn, taking no width (overlapping right, left, both).
    case rlap, llap, clap
}

/// What an operator's nucleus is stretched into (`\overbrace`, `\xrightarrow`).
public enum DevHubStretch: Equatable {
    case overbrace, underbrace
    case rightArrow, leftArrow, bothArrow
}

enum DevHubKaTeX {
    // MARK: Text

    /// The commands whose argument is text: its spaces are kept (`\text{a b}`).
    static let textCommands: Set<String> = [
        "text", "textrm", "textbf", "textit", "texttt", "textsf", "textup", "textnormal", "textmd", "mbox", "hbox", "emph",
    ]

    // MARK: Symbols

    private enum Kind { case ord, bin, rel, open, close, punct, op, opLimits, space }

    /// KaTeX's symbols SwiftMath's table does not have, as KaTeX classes them.
    private static let symbols: [String: (Kind, String)] = [
        // Relations
        "hookrightarrow": (.rel, "\u{21AA}"), "hookleftarrow": (.rel, "\u{21A9}"),
        "therefore": (.rel, "\u{2234}"), "because": (.rel, "\u{2235}"),
        "nmid": (.rel, "\u{2224}"), "vartriangle": (.rel, "\u{25B3}"),
        "leqslant": (.rel, "\u{2A7D}"), "geqslant": (.rel, "\u{2A7E}"),
        "lesssim": (.rel, "\u{2272}"), "gtrsim": (.rel, "\u{2273}"),
        "preceq": (.rel, "\u{2AAF}"), "succeq": (.rel, "\u{2AB0}"),
        "vdash": (.rel, "\u{22A2}"), "dashv": (.rel, "\u{22A3}"), "vDash": (.rel, "\u{22A8}"), "Vdash": (.rel, "\u{22A9}"),
        "nvdash": (.rel, "\u{22AC}"), "nvDash": (.rel, "\u{22AD}"),
        "varpropto": (.rel, "\u{221D}"),
        "nleq": (.rel, "\u{2270}"), "ngeq": (.rel, "\u{2271}"), "nless": (.rel, "\u{226E}"), "ngtr": (.rel, "\u{226F}"),
        "subsetneq": (.rel, "\u{228A}"), "supsetneq": (.rel, "\u{228B}"),
        "nsubseteq": (.rel, "\u{2288}"), "nsupseteq": (.rel, "\u{2289}"),
        "triangleq": (.rel, "\u{225C}"), "coloneqq": (.rel, "\u{2254}"), "eqqcolon": (.rel, "\u{2255}"), "coloneq": (.rel, "\u{2254}"),
        "nsim": (.rel, "\u{2241}"), "ncong": (.rel, "\u{2247}"), "nparallel": (.rel, "\u{2226}"), "notni": (.rel, "\u{220C}"),
        "approxeq": (.rel, "\u{224A}"), "backsim": (.rel, "\u{223D}"), "circeq": (.rel, "\u{2257}"),
        "bumpeq": (.rel, "\u{224F}"), "Bumpeq": (.rel, "\u{224E}"), "Doteq": (.rel, "\u{2251}"),
        "lessgtr": (.rel, "\u{2276}"), "gtrless": (.rel, "\u{2277}"), "leqq": (.rel, "\u{2266}"), "geqq": (.rel, "\u{2267}"),
        "lll": (.rel, "\u{22D8}"), "ggg": (.rel, "\u{22D9}"), "Subset": (.rel, "\u{22D0}"), "Supset": (.rel, "\u{22D1}"),
        "smile": (.rel, "\u{2323}"), "frown": (.rel, "\u{2322}"), "between": (.rel, "\u{226C}"), "pitchfork": (.rel, "\u{22D4}"),
        "owns": (.rel, "\u{220B}"),
        // KaTeX's \models is ⊨ (SwiftMath's table has ⊧).
        "models": (.rel, "\u{22A8}"),
        // Arrows
        "rightleftharpoons": (.rel, "\u{21CC}"), "leftrightharpoons": (.rel, "\u{21CB}"),
        "rightharpoonup": (.rel, "\u{21C0}"), "rightharpoondown": (.rel, "\u{21C1}"),
        "leftharpoonup": (.rel, "\u{21BC}"), "leftharpoondown": (.rel, "\u{21BD}"),
        "upharpoonright": (.rel, "\u{21BE}"), "upharpoonleft": (.rel, "\u{21BF}"),
        "longmapsto": (.rel, "\u{27FC}"), "twoheadrightarrow": (.rel, "\u{21A0}"), "twoheadleftarrow": (.rel, "\u{219E}"),
        "rightrightarrows": (.rel, "\u{21C9}"), "leftleftarrows": (.rel, "\u{21C7}"),
        "leftrightarrows": (.rel, "\u{21C6}"), "rightleftarrows": (.rel, "\u{21C4}"),
        "leadsto": (.rel, "\u{21DD}"), "rightsquigarrow": (.rel, "\u{21DD}"),
        "curvearrowright": (.rel, "\u{21B7}"), "curvearrowleft": (.rel, "\u{21B6}"),
        "circlearrowright": (.rel, "\u{21BB}"), "circlearrowleft": (.rel, "\u{21BA}"),
        "nrightarrow": (.rel, "\u{219B}"), "nleftarrow": (.rel, "\u{219A}"),
        "nRightarrow": (.rel, "\u{21CF}"), "nLeftarrow": (.rel, "\u{21CD}"),
        "nleftrightarrow": (.rel, "\u{21AE}"), "nLeftrightarrow": (.rel, "\u{21CE}"),
        "Lleftarrow": (.rel, "\u{21DA}"), "Rrightarrow": (.rel, "\u{21DB}"),
        "dashrightarrow": (.rel, "\u{21E2}"), "dashleftarrow": (.rel, "\u{21E0}"),
        // Binary operators
        "smallsetminus": (.bin, "\u{2216}"), "diamond": (.bin, "\u{22C4}"),
        "bigtriangleup": (.bin, "\u{25B3}"), "bigtriangledown": (.bin, "\u{25BD}"),
        "triangleleft": (.bin, "\u{25C1}"), "triangleright": (.bin, "\u{25B7}"),
        "lhd": (.bin, "\u{22B2}"), "rhd": (.bin, "\u{22B3}"), "unlhd": (.bin, "\u{22B4}"), "unrhd": (.bin, "\u{22B5}"),
        "boxplus": (.bin, "\u{229E}"), "boxminus": (.bin, "\u{229F}"), "boxtimes": (.bin, "\u{22A0}"), "boxdot": (.bin, "\u{22A1}"),
        "circledast": (.bin, "\u{229B}"), "circledcirc": (.bin, "\u{229A}"), "circleddash": (.bin, "\u{229D}"),
        "dotplus": (.bin, "\u{2214}"), "ltimes": (.bin, "\u{22C9}"), "rtimes": (.bin, "\u{22CA}"),
        "intercal": (.bin, "\u{22BA}"), "barwedge": (.bin, "\u{2305}"), "veebar": (.bin, "\u{22BB}"),
        "curlywedge": (.bin, "\u{22CF}"), "curlyvee": (.bin, "\u{22CE}"), "centerdot": (.bin, "\u{22C5}"),
        "divideontimes": (.bin, "\u{22C7}"), "Cap": (.bin, "\u{22D2}"), "Cup": (.bin, "\u{22D3}"), "bigcirc": (.bin, "\u{25EF}"),
        // Ordinary
        "varnothing": (.ord, "\u{2205}"), "nexists": (.ord, "\u{2204}"),
        "blacksquare": (.ord, "\u{25A0}"), "square": (.ord, "\u{25A1}"), "Box": (.ord, "\u{25A1}"),
        "checkmark": (.ord, "\u{2713}"), "complement": (.ord, "\u{2201}"), "mho": (.ord, "\u{2127}"),
        "beth": (.ord, "\u{2136}"), "gimel": (.ord, "\u{2137}"), "daleth": (.ord, "\u{2138}"), "eth": (.ord, "\u{00F0}"),
        "Finv": (.ord, "\u{2132}"), "Game": (.ord, "\u{2141}"), "diagup": (.ord, "\u{2571}"), "diagdown": (.ord, "\u{2572}"),
        "backprime": (.ord, "\u{2035}"), "measuredangle": (.ord, "\u{2221}"), "sphericalangle": (.ord, "\u{2222}"),
        "varkappa": (.ord, "\u{03F0}"), "digamma": (.ord, "\u{03DD}"),
        "imath": (.ord, "\u{0001D6A4}"), "jmath": (.ord, "\u{0001D6A5}"),
        "lozenge": (.ord, "\u{25CA}"), "blacklozenge": (.ord, "\u{29EB}"), "bigstar": (.ord, "\u{2605}"),
        "blacktriangle": (.ord, "\u{25B4}"), "triangledown": (.ord, "\u{25BF}"), "maltese": (.ord, "\u{2720}"),
        "S": (.ord, "\u{00A7}"), "P": (.ord, "\u{00B6}"), "dag": (.ord, "\u{2020}"), "ddag": (.ord, "\u{2021}"),
        "pounds": (.ord, "\u{00A3}"), "copyright": (.ord, "\u{00A9}"), "yen": (.ord, "\u{00A5}"),
        "And": (.ord, "&"), "&": (.ord, "&"), "hslash": (.ord, "\u{210F}"), "Bbbk": (.ord, "\u{0001D55C}"),
        "circledS": (.ord, "\u{24C8}"),
        "cdotp": (.punct, "\u{22C5}"), "ldotp": (.punct, "."),
        // Large operators
        "iint": (.op, "\u{222C}"), "iiint": (.op, "\u{222D}"), "oiint": (.op, "\u{222F}"), "oiiint": (.op, "\u{2230}"),
        "bigodot": (.opLimits, "\u{2A00}"), "biguplus": (.opLimits, "\u{2A04}"), "bigsqcup": (.opLimits, "\u{2A06}"),
        // Delimiters as atoms
        "lvert": (.open, "|"), "rvert": (.close, "|"), "lVert": (.open, "\u{2016}"), "rVert": (.close, "\u{2016}"),
        "lbrack": (.open, "["), "rbrack": (.close, "]"), "lparen": (.open, "("), "rparen": (.close, ")"),
        "ulcorner": (.open, "\u{231C}"), "urcorner": (.close, "\u{231D}"), "llcorner": (.open, "\u{231E}"), "lrcorner": (.close, "\u{231F}"),
        // Spaces, in mu
        ":": (.space, "4"), "enspace": (.space, "9"), "thinspace": (.space, "3"), "medspace": (.space, "4"),
        "thickspace": (.space, "5"), "negthinspace": (.space, "-3"), "negmedspace": (.space, "-4"), "negthickspace": (.space, "-5"),
    ]

    /// KaTeX's other names for SwiftMath's symbols.
    private static let aliases: [String: String] = [
        "dots": "ldots", "dotsc": "ldots", "dotso": "ldots", "dotsb": "cdots", "dotsm": "cdots", "dotsi": "cdots",
        "space": " ", "nobreakspace": " ",
    ]

    /// A fresh atom for `name`, or nil when KaTeX has no such symbol either.
    static func symbol(_ name: String) -> MTMathAtom? {
        if let other = aliases[name] { return MTMathAtomFactory.atom(forLatexSymbol: other) }
        guard let (kind, value) = symbols[name] else { return nil }
        switch kind {
        case .ord: return MTMathAtom(type: .ordinary, value: value)
        case .bin: return MTMathAtom(type: .binaryOperator, value: value)
        case .rel: return MTMathAtom(type: .relation, value: value)
        case .open: return MTMathAtom(type: .open, value: value)
        case .close: return MTMathAtom(type: .close, value: value)
        case .punct: return MTMathAtom(type: .punctuation, value: value)
        case .op: return MTLargeOperator(value: value, limits: false)
        case .opLimits: return MTLargeOperator(value: value, limits: true)
        case .space: return MTMathSpace(space: CGFloat(Double(value) ?? 0))
        }
    }

    // MARK: Commands

    /// The commands `MTMathListBuilder.devhubAtom(forCommand:)` answers.
    static let commands: Set<String> = [
        "dfrac", "tfrac", "cfrac", "dbinom", "tbinom",
        "operatorname", "mathop", "mathbin", "mathrel", "mathord", "mathopen", "mathclose", "mathpunct", "mathinner",
        "big", "Big", "bigg", "Bigg", "bigl", "Bigl", "biggl", "Biggl", "bigr", "Bigr", "biggr", "Biggr", "bigm", "Bigm", "biggm", "Biggm",
        "implies", "impliedby", "iff", "not",
        "bmod", "pmod", "mod", "pod",
        "hspace", "kern", "mkern", "mskip", "hskip",
        "phantom", "hphantom", "vphantom", "rlap", "llap", "clap", "mathrlap", "mathllap", "mathclap",
        "overbrace", "underbrace",
        "boxed", "fbox", "cancel", "bcancel", "xcancel", "sout",
        "overset", "underset", "stackrel", "xrightarrow", "xleftarrow", "xRightarrow", "xLeftarrow", "xleftrightarrow", "xLeftrightarrow",
        "nonumber", "notag",
    ]

    /// `\big`'s heights (KaTeX's `sizeToMaxHeight`), in em.
    static let delimiterSizes: [String: CGFloat] = ["big": 1.2, "Big": 1.8, "bigg": 2.4, "Bigg": 3.0]

    /// What `\not` makes of the relations it has a character for.
    static let negated: [String: String] = [
        "=": "\u{2260}", "<": "\u{226E}", ">": "\u{226F}", "in": "\u{2209}", "ni": "\u{220C}",
        "subset": "\u{2284}", "supset": "\u{2285}", "subseteq": "\u{2288}", "supseteq": "\u{2289}",
        "equiv": "\u{2262}", "leq": "\u{2270}", "geq": "\u{2271}", "le": "\u{2270}", "ge": "\u{2271}",
        "sim": "\u{2241}", "simeq": "\u{2244}", "approx": "\u{2249}", "cong": "\u{2247}", "mid": "\u{2224}",
        "parallel": "\u{2226}", "exists": "\u{2204}", "prec": "\u{2280}", "succ": "\u{2281}",
    ]

    /// A dimension (`1em`, `-3mu`, `2pt`) in mu, KaTeX's units: an em is 18mu, a pt a tenth of an em.
    static func mu(_ dimension: String) -> CGFloat? {
        let text = dimension.trimmingCharacters(in: .whitespaces)
        let units: [(String, Double)] = [
            ("em", 18), ("ex", 18 * 0.431), ("mu", 1), ("pt", 1.8), ("bp", 1.8 * 72.27 / 72), ("pc", 1.8 * 12),
            ("mm", 1.8 * 2.84528), ("cm", 1.8 * 28.4528), ("in", 1.8 * 72.27), ("px", 1.8 * 72.27 / 96),
        ]
        for (unit, scale) in units where text.hasSuffix(unit) {
            let number = text.dropLast(unit.count).replacingOccurrences(of: " ", with: "")
            guard let value = Double(number.isEmpty ? "1" : (number == "-" ? "-1" : number)) else { return nil }
            return CGFloat(value * scale)
        }
        return nil
    }

    // MARK: Colours

    /// KaTeX's colours as SwiftMath reads them: a CSS name, or hex with or without `#`.
    static func hexColor(_ given: String) -> String {
        let names: [String: String] = [
            "black": "#000000", "white": "#ffffff", "red": "#ff0000", "green": "#008000", "blue": "#0000ff",
            "yellow": "#ffff00", "cyan": "#00ffff", "magenta": "#ff00ff", "orange": "#ffa500", "purple": "#800080",
            "gray": "#808080", "grey": "#808080", "brown": "#a52a2a", "pink": "#ffc0cb", "teal": "#008080",
            "navy": "#000080", "maroon": "#800000", "olive": "#808000", "lime": "#00ff00", "violet": "#ee82ee",
            "gold": "#ffd700", "silver": "#c0c0c0", "indigo": "#4b0082", "aqua": "#00ffff", "fuchsia": "#ff00ff",
            "darkred": "#8b0000", "darkgreen": "#006400", "darkblue": "#00008b", "darkorange": "#ff8c00",
            "darkgray": "#a9a9a9", "darkgrey": "#a9a9a9", "lightgray": "#d3d3d3", "lightgrey": "#d3d3d3",
            "lightblue": "#add8e6", "lightgreen": "#90ee90", "crimson": "#dc143c", "coral": "#ff7f50",
            "salmon": "#fa8072", "tomato": "#ff6347", "turquoise": "#40e0d0", "skyblue": "#87ceeb", "royalblue": "#4169e1",
            "steelblue": "#4682b4", "forestgreen": "#228b22", "seagreen": "#2e8b57", "orchid": "#da70d6", "plum": "#dda0dd",
            "tan": "#d2b48c", "khaki": "#f0e68c", "chocolate": "#d2691e", "firebrick": "#b22222", "goldenrod": "#daa520",
        ]
        if let hex = names[given.lowercased()] { return hex }
        var digits = given.hasPrefix("#") ? String(given.dropFirst()) : given
        guard !digits.isEmpty, digits.allSatisfy(\.isHexDigit) else { return given }
        if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
        return "#" + digits
    }

    // MARK: Environments

    /// The environments KaTeX allows only in display mode.
    static let displayOnly: Set<String> = [
        "align", "align*", "gather", "gather*", "equation", "equation*", "alignat", "alignat*", "multline", "multline*", "split", "flalign", "flalign*",
    ]

    /// A trailing `\\` leaves an empty last row: KaTeX does not draw it.
    static func trimmed(_ rows: [[MTMathList]]) -> [[MTMathList]] {
        guard rows.count > 1, let last = rows.last, last.allSatisfy({ $0.atoms.isEmpty }) else { return rows }
        return Array(rows.dropLast())
    }

    /// The table for an environment KaTeX has and SwiftMath does not, or as
    /// KaTeX lays it out where SwiftMath differs; nil for SwiftMath's own.
    static func table(_ env: String, rows: [[MTMathList]], error: inout NSError?) -> MTMathAtom? {
        let name = env.hasSuffix("*") ? String(env.dropLast()) : env
        func made(_ environment: String) -> MTMathTable {
            let table = MTMathTable(environment: environment)
            for (i, row) in rows.enumerated() {
                for (j, cell) in row.enumerated() { table.set(cell: cell, forRow: i, column: j) }
            }
            return table
        }
        func styled(_ table: MTMathTable, _ style: MTLineStyle) {
            for i in 0..<table.cells.count {
                for j in 0..<table.cells[i].count { table.cells[i][j].insert(MTMathStyle(style: style), at: 0) }
            }
        }
        func inner(_ table: MTMathTable, _ left: String, _ right: String, leading: [MTMathAtom] = []) -> MTInner {
            let inner = MTInner()
            inner.leftBoundary = MTMathAtomFactory.boundary(forDelimiter: left)
            inner.rightBoundary = MTMathAtomFactory.boundary(forDelimiter: right)
            inner.innerList = MTMathList(atoms: leading + [table])
            return inner
        }
        switch name {
        case "aligned", "align", "split", "eqalign", "alignedat", "alignat":
            // Pairs of columns, right then left, a relation's space kept at
            // the left one's start, and 1em between the pairs.
            let table = made("aligned")
            let spacer = MTMathAtom(type: .ordinary, value: "")
            for i in 0..<table.cells.count {
                for j in 0..<table.cells[i].count {
                    if j % 2 == 1 { table.cells[i][j].insert(spacer.copy(), at: 0) }
                    if j > 0, j % 2 == 0 { table.cells[i][j].insert(MTMathSpace(space: 18), at: 0) }
                }
            }
            table.interRowAdditionalSpacing = 1
            table.interColumnSpacing = 0
            for j in 0..<table.numColumns { table.set(alignment: j % 2 == 0 ? .right : .left, forColumn: j) }
            return table
        case "gather", "gathered", "equation":
            let table = made("gather")
            table.interRowAdditionalSpacing = 1
            table.interColumnSpacing = 0
            for j in 0..<table.numColumns { table.set(alignment: .center, forColumn: j) }
            return table
        case "cases", "dcases", "rcases", "drcases":
            guard rows.allSatisfy({ $0.count <= 2 }) else {
                error = NSError(domain: MTParseError, code: MTParseErrors.invalidNumColumns.rawValue,
                                userInfo: [NSLocalizedDescriptionKey: "cases environment can only have 2 columns"])
                return nil
            }
            let table = made("cases")
            table.interRowAdditionalSpacing = 0
            table.interColumnSpacing = 18
            for j in 0..<table.numColumns { table.set(alignment: .left, forColumn: j) }
            styled(table, name.hasPrefix("d") ? .display : .text)
            let right = name.hasSuffix("rcases")
            return inner(table, right ? "." : "{", right ? "}" : ".", leading: right ? [] : [MTMathSpace(space: 3)])
        case "smallmatrix":
            let table = made("matrix")
            table.interRowAdditionalSpacing = 0
            table.interColumnSpacing = 10
            styled(table, .script)
            return table
        default:
            guard name.hasPrefix("array:") || name.hasPrefix("darray:") else { return nil }
            // `{array}{lcr}`: the columns aligned as the spec says, 1em apart.
            let spec = Array(name.split(separator: ":", maxSplits: 1).last ?? "")
            let table = made("array")
            table.interRowAdditionalSpacing = 0
            table.interColumnSpacing = 18
            styled(table, name.hasPrefix("d") ? .display : .text)
            for j in 0..<table.numColumns {
                let letter = j < spec.count ? spec[j] : "c"
                table.set(alignment: letter == "l" ? .left : letter == "r" ? .right : .center, forColumn: j)
            }
            return table
        }
    }

    // MARK: \tag

    /// `\tag{…}` / `\tag*{…}` taken out of a formula: the rest, and the tag as
    /// KaTeX draws it (`(…)`, or as it is for the starred one). Nil: no tag.
    static func tag(in latex: String) -> (rest: String, tag: String)? {
        guard let range = latex.range(of: "\\tag") else { return nil }
        var index = range.upperBound
        var starred = false
        if index < latex.endIndex, latex[index] == "*" { starred = true; index = latex.index(after: index) }
        while index < latex.endIndex, latex[index] == " " { index = latex.index(after: index) }
        guard index < latex.endIndex, latex[index] == "{" else { return nil }
        var depth = 0
        var end = index
        while end < latex.endIndex {
            if latex[end] == "{" { depth += 1 }
            if latex[end] == "}" { depth -= 1; if depth == 0 { break } }
            end = latex.index(after: end)
        }
        guard end < latex.endIndex else { return nil }
        let body = String(latex[latex.index(after: index)..<end])
        let rest = String(latex[..<range.lowerBound]) + String(latex[latex.index(after: end)...])
        return (rest, starred ? body : "(\(body))")
    }
}

// MARK: - The parser's side

extension MTMathListBuilder {
    /// `\begin{…}`'s name as the table builder takes it: refused where KaTeX
    /// refuses it (in an inline formula), and `{array}`'s column spec read.
    mutating func devhubEnvironment(_ env: String?) -> String? {
        guard let env else { return nil }
        if !devhubDisplay, DevHubKaTeX.displayOnly.contains(env) {
            self.setError(.invalidEnv, message: "{\(env)} can be used only in display mode.")
            return nil
        }
        if env == "array" || env == "darray" {
            guard let spec = self.devhubRawArgument() else { return nil }
            return env + ":" + spec.filter { "lcr".contains($0) }
        }
        return env
    }

    /// The next argument's characters as written, its braces taken off.
    mutating func devhubRawArgument() -> String? {
        self.skipSpaces()
        guard self.hasCharacters else {
            self.setError(.characterNotFound, message: "Missing {")
            return nil
        }
        let first = self.getNextCharacter()
        guard first == "{" else { return String(first) }
        var depth = 1
        var out = ""
        while self.hasCharacters {
            let char = self.getNextCharacter()
            if char == "{" { depth += 1 }
            if char == "}" { depth -= 1; if depth == 0 { return out } }
            out.append(char)
        }
        self.setError(.mismatchBraces, message: "Missing }")
        return nil
    }

    /// `[…]`, if it comes next (`\xrightarrow[under]{over}`).
    mutating func devhubOptionalArgument() -> MTMathList? {
        self.skipSpaces()
        guard self.hasCharacters else { return nil }
        if self.getNextCharacter() == "[" { return self.buildInternal(false, stopChar: "]") }
        self.unlookCharacter()
        return nil
    }

    /// A dimension written after `\kern` and friends, without braces.
    mutating func devhubDimension() -> String {
        self.skipSpaces()
        var out = ""
        while self.hasCharacters {
            let char = self.getNextCharacter()
            let letters = out.filter(\.isLetter).count
            if (char.isNumber || char == "." || (char == "-" && out.isEmpty) || char == " ") && letters == 0 {
                out.append(char)
            } else if char.isLetter && letters < 2 {
                out.append(char)
            } else {
                self.unlookCharacter()
                break
            }
        }
        return out
    }

    private func devhubGroup(_ atoms: [MTMathAtom], class kind: MTMathAtomType? = nil) -> MTInner {
        let inner = MTInner()
        inner.innerList = MTMathList(atoms: atoms)
        inner.devhubClass = kind
        return inner
    }

    private func devhubSpace(_ mu: CGFloat) -> MTMathSpace { MTMathSpace(space: mu) }

    /// An operator name in upright letters (`\operatorname{rank}`), limits or not.
    private mutating func devhubOperator(_ raw: String, limits: Bool) -> MTMathAtom? {
        var sub = MTMathListBuilder(string: raw)
        sub.currentFontStyle = .roman
        guard let list = sub.build(), sub.error == nil else {
            self.setError(.invalidCommand, message: sub.error?.localizedDescription ?? "Invalid operator name")
            return nil
        }
        let simple = list.atoms.allSatisfy { atom in
            [.variable, .number, .ordinary].contains(atom.type) && atom.subScript == nil && atom.superScript == nil
        }
        if simple {
            return MTLargeOperator(value: list.atoms.map(\.nucleus).joined(), limits: limits)
        }
        let op = MTLargeOperator(value: "", limits: limits)
        op.devhubBase = list
        return op
    }

    /// One of `DevHubKaTeX.commands`.
    mutating func devhubAtom(forCommand command: String) -> MTMathAtom? {
        switch command {
        case "dfrac", "tfrac", "cfrac", "dbinom", "tbinom":
            // The fraction in the display (or text) style, whatever the style around it.
            guard let fraction = self.atomForCommand(command.hasSuffix("binom") ? "binom" : "frac") else { return nil }
            return devhubGroup([MTMathStyle(style: command.hasPrefix("t") ? .text : .display), fraction])

        case "operatorname":
            var limits = false
            if self.hasCharacters {
                if self.getNextCharacter() == "*" { limits = true } else { self.unlookCharacter() }
            }
            guard let raw = self.devhubRawArgument() else { return nil }
            return self.devhubOperator(raw, limits: limits)

        case "mathop", "mathbin", "mathrel", "mathord", "mathopen", "mathclose", "mathpunct", "mathinner":
            guard let list = self.buildInternal(true) else { return nil }
            let kinds: [String: MTMathAtomType] = [
                "mathop": .largeOperator, "mathbin": .binaryOperator, "mathrel": .relation, "mathord": .ordinary,
                "mathopen": .open, "mathclose": .close, "mathpunct": .punctuation, "mathinner": .inner,
            ]
            let kind = kinds[command] ?? .ordinary
            if command == "mathop" {
                let op = MTLargeOperator(value: "", limits: true)
                if list.atoms.count == 1, let only = list.atoms.first, only.type == .largeOperator { return only }
                op.devhubBase = list
                return op
            }
            if list.atoms.count == 1, let only = list.atoms.first, only.subScript == nil, only.superScript == nil,
               [.ordinary, .binaryOperator, .relation, .open, .close, .punctuation].contains(only.type), kind != .inner
            {
                only.type = kind
                return only
            }
            return devhubGroup(list.atoms, class: kind == .inner ? nil : kind)

        case _ where command.hasPrefix("big") || command.hasPrefix("Big"):
            // A delimiter at a fixed height: \big( is 1.2em… \Bigg( 3em.
            let base = ["Bigg", "bigg", "Big", "big"].first { command.hasPrefix($0) } ?? "big"
            let suffix = command.dropFirst(base.count)
            guard let delimiter = self.getBoundaryAtom(command) else { return nil }
            let inner = MTInner()
            inner.leftBoundary = delimiter
            inner.innerList = MTMathList()
            inner.devhubDelimiterSize = DevHubKaTeX.delimiterSizes[base]
            inner.devhubClass = suffix == "l" ? .open : suffix == "r" ? .close : suffix == "m" ? .relation : .ordinary
            return inner

        case "implies", "impliedby", "iff":
            // `\;\Longrightarrow\;` and its kin: the arrow with a thick space either side.
            let arrow = ["implies": "\u{27F9}", "impliedby": "\u{27F8}", "iff": "\u{27FA}"][command] ?? "\u{27F9}"
            return devhubGroup([devhubSpace(5), MTMathAtom(type: .relation, value: arrow), devhubSpace(5)], class: .relation)

        case "not":
            // The negated relation where there is one; else the next atom with a slash through it.
            self.skipSpaces()
            guard self.hasCharacters else {
                self.setError(.invalidCommand, message: "Expected something after \\not")
                return nil
            }
            let char = self.getNextCharacter()
            let name = char == "\\" ? self.readCommand() : String(char)
            if let negated = DevHubKaTeX.negated[name] { return MTMathAtom(type: .relation, value: negated) }
            let atom = char == "\\" ? MTMathAtomFactory.atom(forLatexSymbol: name) : MTMathAtomFactory.atom(forCharacter: char)
            guard let atom else {
                self.setError(.invalidCommand, message: "Invalid command \\\(name)")
                return nil
            }
            atom.nucleus += "\u{0338}"
            return atom

        case "bmod":
            return MTMathAtom(type: .binaryOperator, value: "mod")
        case "mod", "pmod", "pod":
            // `\pmod{a}`: a quad (12mu inline) then (mod a); `\mod`: the quad, mod and two thin spaces.
            let lead = devhubSpace(devhubDisplay ? 18 : 12)
            if command == "mod" { return devhubGroup([lead, MTMathAtom(type: .ordinary, value: "mod"), devhubSpace(6)]) }
            guard let argument = self.buildInternal(true) else { return nil }
            var atoms: [MTMathAtom] = [lead, MTMathAtom(type: .open, value: "(")]
            if command == "pmod" { atoms += [MTMathAtom(type: .ordinary, value: "mod"), devhubSpace(6)] }
            atoms += argument.atoms
            atoms.append(MTMathAtom(type: .close, value: ")"))
            return devhubGroup(atoms)

        case "hspace", "kern", "mkern", "mskip", "hskip":
            var written: String
            if command == "hspace" {
                if self.hasCharacters {
                    if self.getNextCharacter() != "*" { self.unlookCharacter() }
                }
                guard let raw = self.devhubRawArgument() else { return nil }
                written = raw
            } else {
                written = self.devhubDimension()
            }
            guard let mu = DevHubKaTeX.mu(written) else {
                self.setError(.invalidCommand, message: "Invalid size: '\(written)'")
                return nil
            }
            return devhubSpace(mu)

        case "phantom", "hphantom", "vphantom", "boxed", "cancel", "bcancel", "xcancel", "sout",
             "rlap", "llap", "clap", "mathrlap", "mathllap", "mathclap":
            guard let list = self.buildInternal(true) else { return nil }
            let frames: [String: DevHubFrame] = [
                "phantom": .phantom, "hphantom": .hphantom, "vphantom": .vphantom, "boxed": .box,
                "cancel": .cancel, "bcancel": .bcancel, "xcancel": .xcancel, "sout": .strike,
                "rlap": .rlap, "llap": .llap, "clap": .clap, "mathrlap": .rlap, "mathllap": .llap, "mathclap": .clap,
            ]
            let frame = frames[command] ?? .box
            // `\boxed`: `\fbox{$\displaystyle#1$}`.
            let inner = devhubGroup(command == "boxed" ? [MTMathStyle(style: .display)] + list.atoms : list.atoms)
            inner.devhubFrame = frame
            inner.devhubClass = .ordinary
            return inner

        case "fbox":
            guard let raw = self.devhubRawArgument() else { return nil }
            var sub = MTMathListBuilder(string: raw)
            sub.currentFontStyle = .roman
            sub.spacesAllowed = true
            guard let list = sub.build(), sub.error == nil else {
                self.setError(.invalidCommand, message: sub.error?.localizedDescription ?? "Invalid \\fbox")
                return nil
            }
            let inner = devhubGroup(list.atoms, class: .ordinary)
            inner.devhubFrame = .box
            return inner

        case "overset", "underset", "stackrel":
            // `\mathop{b}\limits^{a}`, spaced as `b` is (a relation for `\stackrel`).
            guard let over = self.buildInternal(true), let base = self.buildInternal(true) else { return nil }
            let op = MTLargeOperator(value: "", limits: true)
            op.devhubAlwaysLimits = true
            op.devhubBase = base
            if command == "underset" { op.subScript = over } else { op.superScript = over }
            if command == "stackrel" {
                op.devhubClass = .relation
            } else if base.atoms.count == 1, let only = base.atoms.first, [.relation, .binaryOperator].contains(only.type) {
                op.devhubClass = only.type
            } else {
                op.devhubClass = .ordinary
            }
            return op

        case "overbrace", "underbrace":
            // The brace over (under) its argument; what follows as `^` (`_`) goes over (under) the brace.
            guard let base = self.buildInternal(true) else { return nil }
            let op = MTLargeOperator(value: "", limits: true)
            op.devhubAlwaysLimits = true
            op.devhubBase = base
            op.devhubStretch = command == "overbrace" ? .overbrace : .underbrace
            op.devhubClass = .ordinary
            return op

        case "xrightarrow", "xleftarrow", "xRightarrow", "xLeftarrow", "xleftrightarrow", "xLeftrightarrow":
            // The arrow as long as its labels (0.5em past them each side, 1.469em at
            // least), the labels over and under it. The double ones are their long glyph.
            let under = self.devhubOptionalArgument()
            if self.error != nil { return nil }
            guard let over = self.buildInternal(true) else { return nil }
            let doubled: [String: String] = ["xRightarrow": "\u{27F9}", "xLeftarrow": "\u{27F8}", "xLeftrightarrow": "\u{27FA}"]
            let op = MTLargeOperator(value: "", limits: true)
            op.devhubAlwaysLimits = true
            if let arrow = doubled[command] {
                op.devhubBase = MTMathList(atoms: [MTMathAtom(type: .relation, value: arrow)])
            } else {
                op.devhubStretch = command == "xleftarrow" ? .leftArrow : command == "xrightarrow" ? .rightArrow : .bothArrow
            }
            op.devhubClass = .relation
            if !over.atoms.isEmpty { op.superScript = over }
            if let under, !under.atoms.isEmpty { op.subScript = under }
            return op

        case "nonumber", "notag":
            return devhubSpace(0)

        default:
            self.setError(.invalidCommand, message: "Invalid command \\\(command)")
            return nil
        }
    }
}
