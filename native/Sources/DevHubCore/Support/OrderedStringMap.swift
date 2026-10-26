/// A string-to-string table that remembers the order its keys were written in.
///
/// TOML tables come to the TypeScript app as JS objects, whose key order is
/// insertion order — except that keys that look like array indices (`"0"`,
/// `"12"`) come first, in ascending numeric order. `[keybindings.chords]` and a
/// profile's `env` are iterated in that order (diagnostics name the first bad
/// entry; a save writes the entries back in it), so the native table keeps the
/// same order rather than a Swift dictionary's arbitrary one.
public struct OrderedStringMap: Equatable, Hashable, Sendable, Sequence, ExpressibleByDictionaryLiteral {
    public private(set) var keys: [String] = []
    private var values: [String: String] = [:]

    public init() {}

    public init(dictionaryLiteral elements: (String, String)...) {
        for (key, value) in elements { self[key] = value }
    }

    public init(_ pairs: [(String, String)]) {
        for (key, value) in pairs { self[key] = value }
    }

    public subscript(key: String) -> String? {
        get { values[key] }
        set {
            if let newValue {
                if values.updateValue(newValue, forKey: key) == nil { insertKey(key) }
            } else if values.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }

    public var entries: [(key: String, value: String)] { keys.map { ($0, values[$0]!) } }

    public func makeIterator() -> IndexingIterator<[(key: String, value: String)]> {
        entries.makeIterator()
    }

    public static func == (lhs: OrderedStringMap, rhs: OrderedStringMap) -> Bool {
        lhs.keys == rhs.keys && lhs.values == rhs.values
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(keys)
        for key in keys { hasher.combine(values[key]) }
    }

    private mutating func insertKey(_ key: String) {
        guard let index = JSPropertyOrder.arrayIndex(key) else {
            keys.append(key)
            return
        }
        // Array-index keys sit before every other key, ascending.
        var at = 0
        while at < keys.count, let other = JSPropertyOrder.arrayIndex(keys[at]), other < index { at += 1 }
        keys.insert(key, at: at)
    }
}

/// The property order of a JS object, which is the order TOML tables reach the
/// TypeScript app's code in.
public enum JSPropertyOrder {
    /// The numeric value of a canonical array index (`"0"` … `"4294967294"`),
    /// or nil for any other key.
    public static func arrayIndex(_ key: String) -> UInt64? {
        guard !key.isEmpty, key.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
        if key.count > 1 && key.hasPrefix("0") { return nil }
        guard key.count <= 10, let value = UInt64(key), value < 4_294_967_295 else { return nil }
        return value
    }

    /// `keys` in the order a JS object built by inserting them would list them.
    public static func ordered(_ keys: [String]) -> [String] {
        let indices = keys.compactMap { key in arrayIndex(key).map { (key, $0) } }.sorted { $0.1 < $1.1 }.map(\.0)
        return indices + keys.filter { arrayIndex($0) == nil }
    }
}
