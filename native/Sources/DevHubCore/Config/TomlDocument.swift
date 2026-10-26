// Port of apps/desktop/src/model/tomlDocument.ts
//
// Editing a TOML document in place.
//
// `settings.toml` is a file a person writes and keeps: they group things their
// way, leave comments explaining a choice, and expect to still recognise it
// after DevHub has written to it. A save that re-serialises the whole document
// destroys all of that — the file still means the same thing, but it is no
// longer theirs.
//
// This keeps the source and rewrites only the spans that changed, over a real
// TOML CST (`TomlParser`): parse the file, find the exact source range of each
// value, and splice. Anything nobody edited — comments, blank lines, key order,
// inline-vs-standard table style, alignment — is never touched, because it is
// never re-rendered.
//
// The rules, in one place:
//
// - A value that is unchanged is left exactly as written, even if this module
//   would have rendered it differently.
// - A value that changed replaces only itself; its key, its spacing and its
//   trailing comment stay.
// - A key that is new is appended to the table it belongs to, after that
//   table's last entry, so it lands under the heading a reader expects.
// - A key that is gone takes its whole line with it, including a comment that
//   is only about that line. A key spelled as a `[heading]` is the same key:
//   it takes its heading, everything under it, and the comment lines written
//   immediately above it. The document is what `desired` says and nothing
//   else — a heading nobody claims is an entry that comes back on the next
//   read.
// - Array-of-tables entries (`[[workspace_sources]]`, `[[agent_profiles]]`)
//   are matched by their `id`, not their position: reordering the array in the
//   UI does not rewrite unrelated blocks, and a removed entry takes its own
//   block and nothing else.
// - An array of tables has two spellings — a run of `[[key]]` blocks, or one
//   inline `key = [ { … } ]` — and the document's own spelling wins. An empty
//   array has no block spelling at all, so `key = []` is the empty marker
//   rather than a choice of spelling: emptying an array removes every block
//   *and* writes `key = []`, and refilling it takes the blocks back. Writing
//   one spelling without removing the other is how a document ends up defining
//   the same key twice, which is not TOML at all.
//
// Offsets are UTF-16 code units, as in the TypeScript (`source.slice`), so an
// edit lands on exactly the same characters.

import Foundation

public enum TomlDocument {
    /// Read a document's values. The only parser DevHub uses.
    public static func parseValue(_ source: String) throws -> TomlTable {
        try TomlParser.parse(source).staticValue()
    }

    // MARK: rendering

    static func isBareKey(_ key: String) -> Bool {
        !key.isEmpty && key.unicodeScalars.allSatisfy { s in
            ("A"..."Z").contains(s) || ("a"..."z").contains(s) || ("0"..."9").contains(s) || s == "_" || s == "-"
        }
    }

    static func renderKey(_ key: String) -> String {
        isBareKey(key) ? key : renderString(key)
    }

    static func renderString(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x5C: out += "\\\\"
            case 0x22: out += "\\\""
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            // Everything else below the printable range has no literal
            // spelling, so a basic string must escape it.
            case 0x00...0x08, 0x0B, 0x0C, 0x0E...0x1F, 0x7F:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }

    static func renderNumber(_ value: Double) throws -> String {
        guard value.isFinite else { throw TomlSyntaxError("a non-finite number has no TOML spelling") }
        return JSString.number(value)
    }

    /// One value, inline. Arrays and tables stay on one line, as the file had them.
    public static func renderValue(_ value: TomlValue) throws -> String {
        switch value {
        case .string(let string): return renderString(string)
        case .number(let number): return try renderNumber(number)
        case .bool(let bool): return bool ? "true" : "false"
        case .datetime(let date): return date.text
        case .array(let items):
            if items.isEmpty { return "[]" }
            return "[ " + (try items.map(renderValue).joined(separator: ", ")) + " ]"
        case .table(let table):
            if table.isEmpty { return "{}" }
            return "{ " + (try table.entries.map { "\(renderKey($0.key)) = \(try renderValue($0.value))" }.joined(separator: ", ")) + " }"
        }
    }

    /// Whether a value belongs in its own `[table]` rather than on one line.
    ///
    /// A table of scalars is a table; a table of tables is a table; **an empty
    /// table is a table.** An array is a value either way. An empty table used
    /// to be written `key = {}`, and adding `[keybindings.chords]` beneath a
    /// document that already says `chords = {}` defines the same key twice, so
    /// every table in a DevHub document is spelled the same way.
    static func needsTableBlock(_ value: TomlValue) -> Bool {
        if case .table = value { return true }
        return false
    }

    /// A whole `[path]` block, for a table the document does not have yet.
    static func renderTableBlock(_ path: [String], _ value: TomlValue) throws -> String {
        try renderBlock("[\(path.map(renderKey).joined(separator: "."))]", path, value)
    }

    /// One `[[path]]` element.
    static func renderArrayTableBlock(_ path: [String], _ value: TomlValue) throws -> String {
        try renderBlock("[[\(path.map(renderKey).joined(separator: "."))]]", path, value)
    }

    private static func renderBlock(_ heading: String, _ path: [String], _ value: TomlValue) throws -> String {
        var lines = [heading]
        var nested: [String] = []
        for (key, entry) in value.tableValue?.entries ?? [] {
            if needsTableBlock(entry) {
                nested.append(try renderTableBlock(path + [key], entry))
            } else {
                lines.append("\(renderKey(key)) = \(try renderValue(entry))")
            }
        }
        return ([lines.joined(separator: "\n")] + nested).joined(separator: "\n\n")
    }

    /// A whole document, for when there is no file to preserve.
    public static func render(_ value: TomlTable) throws -> String {
        var scalars: [String] = []
        var blocks: [String] = []
        for (key, entry) in value.entries {
            if case .array(let items) = entry, !items.isEmpty, items.allSatisfy(needsTableBlock) {
                for item in items { blocks.append(try renderArrayTableBlock([key], item)) }
            } else if needsTableBlock(entry) {
                blocks.append(try renderTableBlock([key], entry))
            } else {
                scalars.append("\(renderKey(key)) = \(try renderValue(entry))")
            }
        }
        let parts = ([scalars.joined(separator: "\n")] + blocks).filter { !$0.isEmpty }
        return parts.joined(separator: "\n\n") + "\n"
    }

    // MARK: editing

    /// Rewrite `source` so it expresses `desired`, changing as little as possible.
    ///
    /// Anything the two agree about is not touched at all — not re-rendered, not
    /// reordered, not reindented — which is what keeps a hand-written config
    /// recognisable after a save.
    public static func update(_ source: String, desired: TomlTable) throws -> String {
        let editor = try Editor(source: source)
        return try editor.run(desired)
    }
}

/// The values of two documents compared the way `valuesEqual` does.
func tomlValuesEqual(_ left: TomlValue?, _ right: TomlValue?) -> Bool {
    switch (left, right) {
    case (.array(let l)?, .array(let r)?):
        return l.count == r.count && zip(l, r).allSatisfy { tomlValuesEqual($0, $1) }
    case (.table(let l)?, .table(let r)?):
        return l.count == r.count && l.keys.allSatisfy { tomlValuesEqual(l[$0], r[$0]) }
    case (.number(let l)?, .number(let r)?):
        return l == r
    case (nil, nil):
        return true
    default:
        return left == right
    }
}

private struct Edit {
    let start: Int
    let end: Int
    let text: [UInt16]
    let order: Int
}

private struct TableEntry {
    let path: [TomlPathSegment]
    let node: TomlTableNode
}

private struct Span: Equatable {
    var start: Int
    var end: Int
}

/// Where a new `[table]` block for a given table goes: at the end of the
/// document for everything except the inside of an array element, whose new
/// sub-tables have to follow that element's own block.
private typealias BlockSink = (String) -> Void

private final class Editor {
    let source: [UInt16]
    let program: TomlProgram
    let current: TomlTable
    var edits: [Edit] = []
    var appended: [String] = []
    let allTables: [TableEntry]

    init(source: String) throws {
        self.source = Array(source.utf16)
        program = try TomlParser.parse(utf16: self.source)
        current = program.staticValue()
        allTables = program.body.compactMap { entry in
            if case .table(let node) = entry { return TableEntry(path: node.resolvedKey, node: node) }
            return nil
        }
    }

    private static let newline = UInt16(UInt8(ascii: "\n"))

    func addEdit(_ start: Int, _ end: Int, _ text: String) {
        edits.append(Edit(start: start, end: end, text: Array(text.utf16), order: edits.count))
    }

    func slice(_ start: Int, _ end: Int) -> String {
        String(decoding: source[max(0, start)..<min(source.count, end)], as: UTF16.self)
    }

    /// How a table path is written in a heading: a numeric segment is an
    /// element of an array of tables, and TOML has no way to name one by
    /// position, so the index is dropped from the spelling.
    func spelled(_ path: [TomlPathSegment]) -> [String] {
        path.compactMap { segment in
            if case .key(let name) = segment { return name }
            return nil
        }
    }

    func tableAt(_ path: [TomlPathSegment]) -> TomlTableNode? {
        allTables.first { $0.path == path }?.node
    }

    /// The `[[path]]` blocks the document already has, in document order.
    func arrayTableBlocks(_ path: [TomlPathSegment]) -> [TableEntry] {
        allTables.filter { entry in
            entry.node.kind == .array && entry.path.count == path.count + 1 && Array(entry.path.dropLast()) == path
        }
    }

    func hasPrefix(_ path: [TomlPathSegment], _ prefix: [TomlPathSegment]) -> Bool {
        path.count >= prefix.count && Array(path.prefix(prefix.count)) == prefix
    }

    /// The line a key-value pair occupies, including its newline and any
    /// comment that sits after it on that line — deleting the pair must not
    /// leave the comment behind explaining a key that is gone.
    func lineSpan(_ range: (Int, Int)) -> Span {
        var start = range.0
        while start > 0 && source[start - 1] != Self.newline { start -= 1 }
        var end = range.1
        while end < source.count && source[end] != Self.newline { end += 1 }
        return Span(start: start, end: min(source.count, end + 1))
    }

    /// Where a new key would be appended: after this table's last entry.
    func insertionPoint(_ table: TomlTableNode) -> (insertAt: Int, indent: String) {
        guard let last = table.body.last else {
            // An empty table: straight after its heading line.
            var end = table.range.0
            while end < source.count && source[end] != Self.newline { end += 1 }
            return (min(source.count, end + 1), "")
        }
        let span = lineSpan(last.range)
        var indentEnd = span.start
        while indentEnd < span.end, source[indentEnd] == 0x20 || source[indentEnd] == 0x09 { indentEnd += 1 }
        return (span.end, slice(span.start, indentEnd))
    }

    /// Where a new top-level key goes: after the last one, before any table.
    func topLevelInsertionPoint() -> (insertAt: Int, indent: String) {
        var insertAt = 0
        for entry in program.body {
            guard case .keyValue(let pair) = entry else { break }
            insertAt = lineSpan(pair.range).end
        }
        return (insertAt, "")
    }

    /// A whole `[table]` or `[[table]]` block: the heading line, what is under
    /// it, and the comment lines written immediately above it. A run of comment
    /// lines touching the heading is about the heading, and a blank line
    /// between them is somebody saying it is not.
    func blockSpan(_ table: TomlTableNode) -> Span {
        var start = table.range.0
        while start > 0 && source[start - 1] != Self.newline { start -= 1 }
        while start != 0 {
            var above = start - 1
            while above > 0 && source[above - 1] != Self.newline { above -= 1 }
            if !JSString.trimStart(slice(above, start)).hasPrefix("#") { break }
            start = above
        }
        var end = table.range.1
        while end < source.count && source[end] != Self.newline { end += 1 }
        end = min(source.count, end + 1)
        // Take the blank line that separated it from the next block, so removing
        // a block does not leave a widening gap behind.
        while end < source.count && source[end] == Self.newline { end += 1 }
        return Span(start: start, end: end)
    }

    /// A block's own span plus the sub-tables written inside it: removing the
    /// block without them leaves a heading whose parent is gone.
    func lastOfFamily(_ entry: TableEntry) -> TableEntry {
        var last = entry
        guard let index = allTables.firstIndex(where: { $0.node === entry.node }) else { return entry }
        var next = index + 1
        while next < allTables.count {
            let candidate = allTables[next]
            if candidate.path.count <= entry.path.count { break }
            if Array(candidate.path.prefix(entry.path.count)) != entry.path { break }
            last = candidate
            next += 1
        }
        return last
    }

    func blockWithChildrenSpan(_ entry: TableEntry) -> Span {
        Span(start: blockSpan(entry.node).start, end: blockSpan(lastOfFamily(entry).node).end)
    }

    /// Remove these blocks with their sub-tables, each span once.
    func removeBlocks(_ entries: [TableEntry]) {
        let spans = entries.map(blockWithChildrenSpan)
        for (index, span) in spans.enumerated() {
            let inside = spans.enumerated().contains { at, other in
                at != index && other.start <= span.start && span.end <= other.end
                    && (other.start != span.start || other.end != span.end || at < index)
            }
            if !inside { addEdit(span.start, span.end, "") }
        }
    }

    /// Whether this key is an array of tables at all: with entries, the value
    /// answers; empty, the document does — `[[key]]` blocks mean this is that
    /// array being emptied.
    func isArrayOfTables(_ path: [TomlPathSegment], _ wanted: [TomlValue]) -> Bool {
        wanted.isEmpty ? !arrayTableBlocks(path).isEmpty : wanted.allSatisfy(TomlDocument.needsTableBlock)
    }

    /// Whether the document heads anything inside `path`, at any depth.
    func hasTablesUnder(_ path: [TomlPathSegment]) -> Bool {
        allTables.contains { $0.path.count > path.count && Array($0.path.prefix(path.count)) == path }
    }

    /// Every `[path.something]` heading under `path` that `target` does not
    /// claim. Only the topmost unclaimed heading is removed;
    /// `blockWithChildrenSpan` takes the sub-tables written inside it.
    func removeUnclaimedTables(_ path: [TomlPathSegment], _ target: TomlTable) {
        var spans: [Span] = []
        for entry in allTables {
            if entry.path.count <= path.count { continue }
            if Array(entry.path.prefix(path.count)) != path { continue }
            guard case .key(let key) = entry.path[path.count], !target.contains(key) else { continue }
            let span = blockWithChildrenSpan(entry)
            if spans.contains(where: { $0.start <= span.start && span.end <= $0.end }) { continue }
            spans.append(span)
        }
        for span in spans { addEdit(span.start, span.end, "") }
    }

    func run(_ desired: TomlTable) throws -> String {
        let topLevel = program.body.compactMap { entry -> TomlKeyValueNode? in
            if case .keyValue(let pair) = entry { return pair }
            return nil
        }
        try reconcile([], topLevel, nil, .table(current), desired) { [unowned self] block in
            self.appended.append(block)
        }

        // Back to front, so an earlier edit cannot move a later one's range. Two
        // insertions at one point come out in the order they were made, so the
        // later one is applied first and the earlier one lands in front of it.
        let sorted = edits.sorted { left, right in
            left.start != right.start ? left.start > right.start : left.order > right.order
        }
        var output = source
        for edit in sorted {
            output.replaceSubrange(edit.start..<edit.end, with: edit.text)
        }
        var text = String(decoding: output, as: UTF16.self)
        if !appended.isEmpty {
            let separator = text.hasSuffix("\n") ? "" : "\n"
            text = "\(text)\(separator)\n\(appended.joined(separator: "\n\n"))\n"
        }
        return text.hasSuffix("\n") ? text : text + "\n"
    }

    /// Reconcile one table's worth of keys: `body` is where the pairs live,
    /// `path` is what that table is called, and `existing`/`target` are the two
    /// versions of its contents.
    func reconcile(
        _ path: [TomlPathSegment],
        _ body: [TomlKeyValueNode],
        _ container: TomlTableNode?,
        _ existing: TomlValue?,
        _ target: TomlTable,
        _ place: @escaping BlockSink
    ) throws {
        var pairKeys: [String] = []
        var pairs: [String: TomlKeyValueNode] = [:]
        for node in body {
            // A dotted key is one entry under its first segment, which is the
            // only level this needs to address.
            let joined = node.key.names.joined(separator: ".")
            if pairs.updateValue(node, forKey: joined) == nil { pairKeys.append(joined) }
        }
        let existingTable = existing?.tableValue
        func existingValue(_ key: String) -> TomlValue? { existingTable?[key] }

        var newKeys: [(String, TomlValue)] = []

        for (key, wanted) in target.entries {
            let childPath = path + [.key(key)]

            if case .array(let wantedItems) = wanted, isArrayOfTables(childPath, wantedItems) {
                // The document's own spelling wins — but only while it has
                // entries to spell. An inline `key = []` is the empty marker.
                let inline = pairs[key]
                let spelledInline = inline != nil && !(existingValue(key)?.arrayValue?.isEmpty ?? true)
                if let inline, spelledInline {
                    if !tomlValuesEqual(existingValue(key), wanted) {
                        addEdit(inline.value.range.0, inline.value.range.1, try TomlDocument.renderValue(wanted))
                    }
                    continue
                }
                try reconcileArrayOfTables(childPath, existing, key, wantedItems, place)
                // Exactly one of the two spellings survives: blocks when there
                // is anything to put in them, `key = []` when there is not.
                if wantedItems.isEmpty {
                    if inline == nil { newKeys.append((key, wanted)) }
                } else if let inline {
                    let span = lineSpan(inline.range)
                    addEdit(span.start, span.end, "")
                }
                continue
            }

            // Past this point the value is not an array of tables, so any
            // `[[key]]` blocks the document spells it with are the *old* shape
            // of a key that has changed shape. A value that is not a table
            // either has no headings at all, so every heading at or under the
            // key is the old shape.
            if case .table = wanted {
                removeBlocks(arrayTableBlocks(childPath))
            } else {
                removeBlocks(allTables.filter { hasPrefix($0.path, childPath) })
            }

            if case .table(let wantedTable) = wanted {
                // The document's own spelling wins, and a table has one either
                // way it is written.
                if let child = tableAt(childPath) {
                    try reconcile(childPath, child.body, child, existingValue(key) ?? .table(TomlTable()), wantedTable, place)
                    continue
                }
                // A table the document defines without ever heading it: it has
                // no body, so it has no pairs and nothing to insert after.
                if hasTablesUnder(childPath) {
                    try reconcile(childPath, [], nil, existingValue(key) ?? .table(TomlTable()), wantedTable, place)
                    continue
                }
                let inline = pairs[key]
                // An empty inline table is the empty marker, not a claim on the
                // spelling. Anything the file spells inline *and has something
                // in* is a spelling somebody chose, and that wins.
                let spelledInline = inline != nil && !(existingValue(key)?.tableValue?.isEmpty ?? true)
                if let inline, spelledInline {
                    if !tomlValuesEqual(existingValue(key), wanted) {
                        addEdit(inline.value.range.0, inline.value.range.1, try TomlDocument.renderValue(wanted))
                    }
                    continue
                }
                if let inline {
                    let span = lineSpan(inline.range)
                    addEdit(span.start, span.end, "")
                }
                place(try TomlDocument.renderTableBlock(spelled(childPath), wanted))
                continue
            }

            guard let pair = pairs[key] else {
                newKeys.append((key, wanted))
                continue
            }
            if !tomlValuesEqual(existingValue(key), wanted) {
                addEdit(pair.value.range.0, pair.value.range.1, try TomlDocument.renderValue(wanted))
            }
        }

        for key in pairKeys where !target.contains(key) {
            let span = lineSpan(pairs[key]!.range)
            addEdit(span.start, span.end, "")
        }

        removeUnclaimedTables(path, target)

        if !newKeys.isEmpty {
            if container == nil && !path.isEmpty {
                // An implicit table: there is no heading to insert after, so
                // the scalars get one of their own.
                place(try TomlDocument.renderTableBlock(spelled(path), .table(TomlTable(newKeys))))
                return
            }
            let point = container.map(insertionPoint) ?? topLevelInsertionPoint()
            let text = try newKeys.map { key, item in
                "\(point.indent)\(TomlDocument.renderKey(key)) = \(try TomlDocument.renderValue(item))\n"
            }.joined()
            addEdit(point.insertAt, point.insertAt, text)
        }
    }

    func reconcileArrayOfTables(
        _ path: [TomlPathSegment],
        _ existing: TomlValue?,
        _ key: String,
        _ wanted: [TomlValue],
        _ place: BlockSink
    ) throws {
        let name = spelled(path)
        let blocks = arrayTableBlocks(path)
        let existingArray = existing?.tableValue?[key]?.arrayValue ?? []

        // Blocks are matched by their own `id`, not by position: the array can
        // be reordered in the UI without rewriting blocks whose contents did
        // not move.
        var byId: [String: (node: TomlTableNode, value: TomlValue)] = [:]
        for (index, entry) in blocks.enumerated() {
            let value = index < existingArray.count ? existingArray[index] : .table(TomlTable())
            if let id = value.tableValue?["id"]?.stringValue {
                byId[id] = (entry.node, value)
            }
        }

        var kept: [ObjectIdentifier] = []
        for item in wanted {
            let id = item.tableValue?["id"]?.stringValue
            guard let id, let match = byId[id] else {
                place(try TomlDocument.renderArrayTableBlock(name, item))
                continue
            }
            kept.append(ObjectIdentifier(match.node))
            guard let element = blocks.first(where: { $0.node === match.node }) else {
                throw InvariantViolation("a matched block is not one of the array's blocks")
            }
            // This element's new sub-tables, written at the end of its own block.
            final class Inside { var blocks: [String] = [] }
            let inside = Inside()
            try reconcile(element.path, match.node.body, match.node, match.value, item.tableValue ?? TomlTable()) { block in
                inside.blocks.append(block)
            }
            if !inside.blocks.isEmpty {
                let last = lastOfFamily(element).node
                var insertAt = last.range.1
                while insertAt < source.count && source[insertAt] != Self.newline { insertAt += 1 }
                insertAt = min(source.count, insertAt + 1)
                let lead = insertAt > 0 && source[insertAt - 1] == Self.newline ? "" : "\n"
                addEdit(insertAt, insertAt, "\(lead)\n\(inside.blocks.joined(separator: "\n\n"))\n")
            }
        }

        // Every block the desired array did not claim goes, whether it had an
        // `id` to be matched by or not.
        for entry in blocks where !kept.contains(ObjectIdentifier(entry.node)) {
            let span = blockWithChildrenSpan(entry)
            addEdit(span.start, span.end, "")
        }
    }
}
