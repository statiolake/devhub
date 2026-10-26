// Port of apps/desktop/src/main/shell/colorThemeCatalog.ts
//
// The colour themes this DevHub can wear, and reading one.
//
// A theme is contributed by an extension — `contributes.themes` in its
// `package.json` — exactly as VS Code finds it: the built-in extensions
// (`theme-defaults` and the rest; the native app has no VS Code, so they are
// vendored as resources, `ColorThemeCatalog.builtinRoot`) and the ones the
// person installed (DevHub's extensions directory, then VS Code's own). A
// theme is named the way VS Code names it in `workbench.colorTheme` — its
// `id`, or its label when it has none — and DevHub also accepts the label it
// shows in the theme picker.
//
// Reading follows `colorThemeData.ts#_loadColorTheme`: the file is JSON with
// comments, an `include` is read first and the including file's colours win,
// and a colour written as `"default"` is taken back out. A TextMate
// (`.tmTheme`) theme carries no workbench colours DevHub reads, so it
// contributes only its type — every colour is then the registry's default.
//
// Synchronous on purpose. It runs before the window exists, because the
// window is created in the theme's colours, and it reads a few hundred small
// files at most.

import Foundation

/// Where extensions are.
public struct ExtensionRoots: Sendable, Equatable {
    /// The built-in extensions: every directory in it is one.
    public var builtin: String?
    /// The person's own, each a directory of `<publisher>.<name>-<version>`
    /// directories, searched in this order after the built-ins.
    public var user: [String]

    public init(builtin: String?, user: [String]) {
        self.builtin = builtin
        self.user = user
    }

    public init(builtin: String?, user: String?) {
        self.init(builtin: builtin, user: user.map { [$0] } ?? [])
    }

    /// The native app's roots: the vendored built-ins, DevHub's own extensions
    /// directory (the one the TS app's VS Code installs into), then VS Code's
    /// (`~/.vscode/extensions`), so a theme installed in either is found.
    public static func standard(profile: ProfileLocations, home: String) -> ExtensionRoots {
        ExtensionRoots(
            builtin: ColorThemeCatalog.builtinRoot,
            user: [profile.extensionsDirectory, Path.join(home, ".vscode", "extensions")]
        )
    }
}

/// One `contributes.themes` entry, found.
public struct ColorThemeEntry: Sendable, Equatable {
    public var settingsId: String
    public var label: String
    public var id: String?
    public var uiTheme: String?
    /// The theme file, absolute.
    public var path: String
    public var extensionId: String

    public init(settingsId: String, label: String, id: String?, uiTheme: String?, path: String, extensionId: String) {
        self.settingsId = settingsId
        self.label = label
        self.id = id
        self.uiTheme = uiTheme
        self.path = path
        self.extensionId = extensionId
    }
}

/// Why a theme file could not be read, for the person.
public struct ColorThemeUnreadable: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// One `tokenColors` rule of a theme, for the code highlighter.
public struct TokenColorRule: Sendable, Equatable {
    /// The scope selectors, each as written (`"comment"`, `"meta.tag string"`).
    public var scopes: [String]
    public var foreground: String?
    public var background: String?
    public var fontStyle: String?

    public init(scopes: [String], foreground: String?, background: String?, fontStyle: String?) {
        self.scopes = scopes
        self.foreground = foreground
        self.background = background
        self.fontStyle = fontStyle
    }
}

public enum ColorThemeCatalog {
    /// How deep `include` may go before it is a loop.
    static let maxIncludeDepth = 16

    /// The vendored built-in theme extensions (`Theme/BuiltinThemes`).
    ///
    /// Looked for beside the app first — `DevHub.app/Contents/Resources`, where
    /// the bundle script puts SwiftPM's resource bundles — and then where
    /// SwiftPM's own accessor finds it (a `swift run`, the tests).
    public static let builtinRoot: String? = {
        let bundleNames = ["DevHub_DevHubCore.bundle", "DevHub_DevHubCore.resources"]
        var candidates: [URL] = []
        for base in [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent()] {
            guard let base else { continue }
            for name in bundleNames {
                candidates.append(base.appendingPathComponent(name).appendingPathComponent("BuiltinThemes"))
            }
        }
        let manager = FileManager.default
        for candidate in candidates where manager.fileExists(atPath: candidate.appendingPathComponent("theme-defaults").path) {
            return candidate.path
        }
        return Bundle.module.url(forResource: "BuiltinThemes", withExtension: nil)?.path
    }()

    // MARK: JSON with comments

    /// JSON with comments and trailing commas, as VS Code's own parser reads a
    /// theme. A file that is not that is `nil`.
    public static func parseJsonc(_ text: String) -> ThemeJSONValue? {
        let units = Array(text.utf16)
        var out: [UInt16] = []
        out.reserveCapacity(units.count)
        var index = 0
        let length = units.count
        while index < length {
            let unit = units[index]
            if unit == 0x22 {
                let start = index
                index += 1
                while index < length, units[index] != 0x22 {
                    index += units[index] == 0x5C ? 2 : 1
                }
                index += 1
                out.append(contentsOf: units[start..<min(index, length)])
            } else if unit == 0x2F, index + 1 < length, units[index + 1] == 0x2F {
                while index < length, units[index] != 0x0A { index += 1 }
            } else if unit == 0x2F, index + 1 < length, units[index + 1] == 0x2A {
                var end = index + 2
                var found = false
                while end + 1 < length {
                    if units[end] == 0x2A, units[end + 1] == 0x2F {
                        found = true
                        break
                    }
                    end += 1
                }
                index = found ? end + 2 : length
            } else {
                out.append(unit)
                index += 1
            }
        }
        // Trailing commas, now that no comment or string can hide one.
        let cleaned = removeTrailingCommas(out)
        return ThemeJSONParser.parse(String(decoding: cleaned, as: UTF16.self))
    }

    private static func removeTrailingCommas(_ text: [UInt16]) -> [UInt16] {
        var out: [UInt16] = []
        out.reserveCapacity(text.count)
        var index = 0
        while index < text.count {
            let unit = text[index]
            if unit == 0x22 {
                let start = index
                index += 1
                while index < text.count, text[index] != 0x22 {
                    index += text[index] == 0x5C ? 2 : 1
                }
                index += 1
                out.append(contentsOf: text[start..<min(index, text.count)])
                continue
            }
            if unit == 0x2C {
                var next = index + 1
                while next < text.count, isWhitespaceUnit(text[next]) { next += 1 }
                if next < text.count, text[next] == 0x7D || text[next] == 0x5D {
                    index += 1
                    continue
                }
            }
            out.append(unit)
            index += 1
        }
        return out
    }

    private static func isWhitespaceUnit(_ unit: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return false }
        return ThemeJS.isWhitespace(scalar)
    }

    // MARK: files

    private static func readText(_ path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue {
            return nil
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func readJson(_ path: String) -> ThemeJSONValue? {
        readText(path).flatMap(parseJsonc)
    }

    /// A `%key%` label, through the extension's `package.nls.json`.
    private static func localized(_ value: ThemeJSONValue?, nls: () -> ThemeJSONObject?) -> String? {
        guard let text = value?.string else { return nil }
        guard let key = nlsKey(text) else { return text }
        if let entry = nls()?[key] {
            if let string = entry.string { return string }
            if let message = entry.object?["message"]?.string { return message }
        }
        return text
    }

    /// `/^%(.+)%$/`: the text between the first and the last `%`, when there is
    /// at least one character and no line terminator.
    private static func nlsKey(_ text: String) -> String? {
        let units = Array(text.utf16)
        guard units.count >= 3, units.first == 0x25, units.last == 0x25 else { return nil }
        let inner = units[1..<(units.count - 1)]
        if inner.contains(where: { $0 == 0x0A || $0 == 0x0D || $0 == 0x2028 || $0 == 0x2029 }) { return nil }
        return String(decoding: inner, as: UTF16.self)
    }

    /// `path.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "")`.
    private static func defaultLabel(_ path: String) -> String {
        var name = Substring(path)
        if let slash = name.lastIndex(where: { $0 == "/" || $0 == "\\" }) {
            name = name[name.index(after: slash)...]
        }
        if let dot = name.lastIndex(of: ".") {
            name = name[name.startIndex..<dot]
        }
        return String(name)
    }

    private static func themes(in directory: String) -> [ColorThemeEntry] {
        guard let manifest = readJson(Path.join(directory, "package.json"))?.object,
              let themes = manifest["contributes"]?.object?["themes"]?.array
        else { return [] }
        var nlsTable: ThemeJSONObject??
        let nls = { () -> ThemeJSONObject? in
            if let loaded = nlsTable { return loaded }
            let loaded = readJson(Path.join(directory, "package.nls.json"))?.object
            nlsTable = .some(loaded)
            return loaded
        }
        let publisher = manifest["publisher"]?.jsString ?? "undefined"
        let name = manifest["name"]?.jsString ?? "undefined"
        let extensionId = "\(publisher).\(name)"
        var entries: [ColorThemeEntry] = []
        for theme in themes {
            guard let fields = theme.object, let path = fields["path"]?.string else { continue }
            let label = localized(fields["label"], nls: nls) ?? defaultLabel(path)
            let id = fields["id"]?.string
            entries.append(ColorThemeEntry(
                settingsId: id ?? label,
                label: label,
                id: id,
                uiTheme: fields["uiTheme"]?.string,
                path: ThemePath.resolve(directory, path),
                extensionId: extensionId
            ))
        }
        return entries
    }

    /// The directories in `root`, by name as `readdir` sorts them, without
    /// hidden ones.
    private static func subdirectories(_ root: String?) -> [String] {
        guard let root, let names = try? FileManager.default.contentsOfDirectory(atPath: root) else { return [] }
        return names
            .filter { !$0.hasPrefix(".") }
            .sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
            .map { Path.join(root, $0) }
            .filter { path in
                var isDirectory: ObjCBool = false
                return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
            }
    }

    /// `1.10.0` after `1.9.3`, as far as a directory name says.
    static func compareVersions(_ a: String, _ b: String) -> Int {
        func parts(_ text: String) -> [Int] {
            text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "." || $0 == "-" })
                .map { jsParseInt(String($0)) }
        }
        let left = parts(a)
        let right = parts(b)
        for index in 0..<max(left.count, right.count) {
            let delta = (index < left.count ? left[index] : 0) - (index < right.count ? right[index] : 0)
            if delta != 0 { return delta }
        }
        return 0
    }

    /// `Number.parseInt(part, 10) || 0`.
    private static func jsParseInt(_ text: String) -> Int {
        var scalars = Substring(ThemeJS.trim(text)).unicodeScalars[...]
        var negative = false
        if let first = scalars.first, first == "-" || first == "+" {
            negative = first == "-"
            scalars = scalars.dropFirst()
        }
        var value = 0
        var any = false
        for scalar in scalars {
            guard ("0"..."9").contains(scalar) else { break }
            any = true
            value = value &* 10 &+ Int(scalar.value - 48)
        }
        guard any else { return 0 }
        return negative ? -value : value
    }

    /// `/^(.*?)-(\d[\w.-]*)$/`: the name and the version of an installed
    /// extension's directory.
    static func splitVersion(_ name: String) -> (key: String, version: String)? {
        let scalars = Array(name.unicodeScalars)
        func isWord(_ s: Unicode.Scalar) -> Bool {
            ("a"..."z").contains(s) || ("A"..."Z").contains(s) || ("0"..."9").contains(s) || s == "_"
        }
        for index in scalars.indices where scalars[index] == "-" {
            let rest = scalars[(index + 1)...]
            guard let first = rest.first, ("0"..."9").contains(first) else { continue }
            if rest.dropFirst().allSatisfy({ isWord($0) || $0 == "." || $0 == "-" }) {
                var key = String.UnicodeScalarView()
                key.append(contentsOf: scalars[..<index])
                var version = String.UnicodeScalarView()
                version.append(contentsOf: rest)
                return (String(key), String(version))
            }
        }
        return nil
    }

    /// The person's extension directories that are live: not marked removed in
    /// `.obsolete`, and the newest version of each when several are on disk.
    private static func userExtensionDirectories(_ root: String) -> [String] {
        let obsolete = readJson(Path.join(root, ".obsolete"))?.object ?? ThemeJSONObject()
        var order: [String] = []
        var newest: [String: (version: String, path: String)] = [:]
        for path in subdirectories(root) {
            let name = String(path.dropFirst(root.count + 1))
            if obsolete[name] == .bool(true) { continue }
            let split = splitVersion(name)
            let key = (split?.key ?? name).lowercased()
            let version = split?.version ?? "0"
            if let seen = newest[key] {
                if compareVersions(version, seen.version) > 0 { newest[key] = (version, path) }
            } else {
                order.append(key)
                newest[key] = (version, path)
            }
        }
        return order.compactMap { newest[$0]?.path }
    }

    /// Every theme contributed under these roots, built-ins first.
    public static func list(_ roots: ExtensionRoots) -> [ColorThemeEntry] {
        (subdirectories(roots.builtin) + roots.user.flatMap(userExtensionDirectories)).flatMap(themes(in:))
    }

    /// The theme a setting names: by what `workbench.colorTheme` would say,
    /// then by the label the picker shows, then by its bare `id`; and, failing
    /// those, the same ignoring case.
    public static func find(_ entries: [ColorThemeEntry], _ name: String) -> ColorThemeEntry? {
        if let exact = entries.first(where: { $0.settingsId == name })
            ?? entries.first(where: { $0.label == name })
            ?? entries.first(where: { $0.id == name }) {
            return exact
        }
        let folded = name.lowercased()
        return entries.first { $0.settingsId.lowercased() == folded || $0.label.lowercased() == folded }
    }

    // MARK: reading a theme

    private static func document(_ path: String) throws -> ThemeJSONObject {
        guard let text = readText(path) else {
            throw ColorThemeUnreadable("\(path) could not be read.")
        }
        guard let document = parseJsonc(text)?.object else {
            throw ColorThemeUnreadable("\(path) is not a JSON theme.")
        }
        return document
    }

    private static func collectColors(_ path: String, into colors: inout [String: String], depth: Int) throws {
        if depth > maxIncludeDepth {
            throw ColorThemeUnreadable("\(path): its includes go deeper than \(maxIncludeDepth) files.")
        }
        if ThemePath.extensionName(path).lowercased() != ".json" { return }
        let document = try document(path)
        if let include = document["include"]?.string {
            try collectColors(ThemePath.resolve(ThemePath.directoryName(path), include), into: &colors, depth: depth + 1)
        }
        guard let value = document["colors"] else { return }
        guard let table = value.object else {
            throw ColorThemeUnreadable("\(path): 'colors' is not an object.")
        }
        for (id, value) in table.entries {
            if value == .string("default") {
                // The theme's own "use the default": an included file's value goes.
                colors.removeValue(forKey: id)
            } else if let text = value.string {
                colors[id] = text
            }
        }
    }

    /// The theme's type and colours, with its includes folded in.
    public static func load(_ entry: ColorThemeEntry) throws -> ColorThemeDefinition {
        var colors: [String: String] = [:]
        try collectColors(entry.path, into: &colors, depth: 0)
        return ColorThemeDefinition(
            settingsId: entry.settingsId,
            label: entry.label,
            type: ColorThemeType(uiTheme: entry.uiTheme),
            colors: colors
        )
    }

    /// The theme's `tokenColors`, an included file's first, as VS Code folds
    /// them (`colorThemeData.ts#_loadColorTheme`): the code highlighter's
    /// colours. A `tokenColors` that names a TextMate file, and a `.tmTheme`
    /// theme, carry none DevHub reads.
    public static func loadTokenColors(_ entry: ColorThemeEntry) throws -> [TokenColorRule] {
        var rules: [TokenColorRule] = []
        try collectTokenColors(entry.path, into: &rules, depth: 0)
        return rules
    }

    private static func collectTokenColors(_ path: String, into rules: inout [TokenColorRule], depth: Int) throws {
        if depth > maxIncludeDepth {
            throw ColorThemeUnreadable("\(path): its includes go deeper than \(maxIncludeDepth) files.")
        }
        if ThemePath.extensionName(path).lowercased() != ".json" { return }
        let document = try document(path)
        if let include = document["include"]?.string {
            try collectTokenColors(ThemePath.resolve(ThemePath.directoryName(path), include), into: &rules, depth: depth + 1)
        }
        guard let settings = document["tokenColors"]?.array else { return }
        for setting in settings {
            guard let fields = setting.object, let style = fields["settings"]?.object else { continue }
            let scopes: [String]
            switch fields["scope"] {
            case .string(let text)?:
                scopes = text.split(separator: ",").map { ThemeJS.trim(String($0)) }.filter { !$0.isEmpty }
            case .array(let values)?:
                scopes = values.compactMap(\.string)
            default:
                scopes = []
            }
            rules.append(TokenColorRule(
                scopes: scopes,
                foreground: style["foreground"]?.string,
                background: style["background"]?.string,
                fontStyle: style["fontStyle"]?.string
            ))
        }
    }

    /// A loader over these roots, listed once (`bootstrapShell`'s): the theme
    /// a name finds, read; `nil` when no extension contributes one by that
    /// name; throws `ColorThemeUnreadable` when it is there and will not read.
    public static func loader(_ roots: ExtensionRoots) -> ColorThemeLoader {
        let entries = list(roots)
        return { name in
            guard let entry = find(entries, name) else { return nil }
            return try load(entry)
        }
    }
}

/// Node's `path` operations the catalog uses, on POSIX paths.
enum ThemePath {
    /// `path.resolve(base, path)`, for an absolute `base`.
    static func resolve(_ base: String, _ path: String) -> String {
        let joined = path.hasPrefix("/") ? path : base + "/" + path
        var parts: [Substring] = []
        for part in joined.split(separator: "/", omittingEmptySubsequences: true) {
            switch part {
            case ".": continue
            case "..": if !parts.isEmpty { parts.removeLast() }
            default: parts.append(part)
            }
        }
        return "/" + parts.joined(separator: "/")
    }

    /// `path.dirname`.
    static func directoryName(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "." }
        if slash == path.startIndex { return "/" }
        return String(path[path.startIndex..<slash])
    }

    /// `path.extname`: from the last `.` of the last component, unless that
    /// `.` starts it.
    static func extensionName(_ path: String) -> String {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return "" }
        return String(name[dot...])
    }
}
