// Port of apps/desktop/src/model/commandPalette.ts
//
// The command palette's list: every command in the registry, as rows to choose.
//
// `Cmd+Q :`. The palette is not a second table of things DevHub can do — it is
// the registry (`Commands.all`) drawn as a picker, with the chords actually in
// effect beside each row, so a command cannot have a key and be missing here,
// and a rebound key reads as the person's own. Choosing a row runs the command
// through the same resolver a chord does (`Chords.resolve`), so the palette and
// the keys cannot disagree about what a command does.

import Foundation

public struct CommandPaletteRow: Hashable, Sendable {
    public var commandId: CommandId
    /// `Category: Label`, the way VS Code writes a palette row.
    public var title: String
    /// Every chord that reaches it, written out: `Cmd+Q Shift+N`.
    public var chords: [String]
    /// Whether it was run from the palette lately, so it leads the list.
    public var recent: Bool

    public init(commandId: CommandId, title: String, chords: [String], recent: Bool) {
        self.commandId = commandId
        self.title = title
        self.chords = chords
        self.recent = recent
    }
}

public enum CommandPalette {
    /// How many commands the palette remembers having run.
    public static let recentLimit = 8

    /// Commands the palette never lists: `forward_prefix` is a *key*, and the
    /// palette itself would only reopen what is already open.
    static let notInPalette: Set<CommandId> = [.forwardPrefix, .openCommandPalette]

    /// `rememberRecentCommand`: to the front, once, and no more than the limit.
    public static func remember(_ recent: [CommandId], _ commandId: CommandId, limit: Int = recentLimit) -> [CommandId] {
        Array(([commandId] + recent.filter { $0 != commandId }).prefix(limit))
    }

    /// `commandPaletteRows`: only the commands that would do something now,
    /// recently run ones first, the rest in registry order.
    public static func rows(
        prefix: ChordKey, bindings: [KeyBinding], recent: [CommandId], available: (CommandId) -> Bool
    ) -> [CommandPaletteRow] {
        let armed = ChordKeys.describe(prefix)
        let rows = Commands.all
            .filter { !notInPalette.contains($0.id) && available($0.id) }
            .map { command in
                CommandPaletteRow(
                    commandId: command.id,
                    title: "\(command.category.rawValue): \(command.label)",
                    chords: Commands.keys(for: command.id, in: bindings).map { "\(armed) \(ChordKeys.describe($0))" },
                    recent: recent.contains(command.id)
                )
            }
        func rank(_ row: CommandPaletteRow) -> Int { recent.firstIndex(of: row.commandId) ?? Int.max }
        return rows.stableSorted { rank($0) < rank($1) ? -1 : rank($0) > rank($1) ? 1 : 0 }
    }

    /// `filterCommandPaletteRows`: what a query leaves of the rows, best first.
    public static func filter(_ rows: [CommandPaletteRow], query: String) -> [CommandPaletteRow] {
        var scored: [(row: CommandPaletteRow, index: Int, value: Double)] = []
        for (index, row) in rows.enumerated() {
            let value = Fuzzy.score(searchText(title: row.title, commandId: row.commandId.rawValue), query)
            if value > 0 { scored.append((row, index, value)) }
        }
        scored.sort { $0.value != $1.value ? $0.value > $1.value : $0.index < $1.index }
        return scored.map(\.row)
    }

    /// `paletteSearchText`: the title, and the command's id.
    public static func searchText(title: String, commandId: String) -> String { "\(title) \(commandId)" }
}
