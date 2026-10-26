// Port of apps/desktop/src/model/workspaceOrder.ts
//
// The order workspaces are in.
//
// **There is one order, and this is it.** The projection carries it, every
// reader takes the array as it comes, and nobody sorts anything a second time.
//
// Two rules, and the second follows from the first.
//
// **A repository keeps its worktrees.** They are the same repository checked
// out in several places — git says so by giving them all the same main
// worktree — so they sit together, with the repository itself at the top of
// its own group. A worktree whose repository is not open is still a group; it
// simply has no head.
//
// **Everything else is by name.** Groups against each other, and worktrees
// within a group.
//
// # The order is a fact the person can set
//
// Those two rules are the *automatic* order. A person who drags a row, or
// presses `Alt+↑`, is saying something the automatic rule cannot, so the model
// keeps an **explicit order** — workspace ids, top to bottom — and this is
// where the two meet.
//
// **The explicit order is a permutation request, never a second grouping.**
// The merge takes the automatic list, permutes it by whatever the explicit
// order names, and then re-imposes the grouping on the result.
//
// **A row the explicit order does not name lands where the automatic rule
// would put it**: each unnamed row is inserted after the row that precedes it
// automatically.

import Foundation

/// What ordering needs to know about a workspace.
public protocol OrderableWorkspace {
    var orderId: String { get }
    var orderLabel: String { get }
    /// What makes this workspace this one: a local folder's path, and a remote
    /// folder's host and path together.
    var orderKey: String { get }
}

/// Up the list, or down it. There is no third answer.
public enum MoveDirection: Int, Sendable {
    case up = -1
    case down = 1
}

public enum WorkspaceOrder {
    /// `groupKeyFor`: the repository's main worktree when git named one, and
    /// otherwise the workspace's own key.
    public static func groupKey(_ workspaceKey: String, mainWorktree: String?) -> String {
        mainWorktree ?? workspaceKey
    }

    /// Insertion-ordered grouping, as a JS `Map` keeps it.
    private static func grouped<T>(_ items: [T], _ keyOf: (T) -> String) -> [(key: String, members: [T])] {
        var order: [String] = []
        var groups: [String: [T]] = [:]
        for item in items {
            let key = keyOf(item)
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(item)
        }
        return order.map { ($0, groups[$0]!) }
    }

    /// The automatic order: groups by name, worktrees under their repository.
    private static func automaticOrder<T: OrderableWorkspace>(_ workspaces: [T], _ groupKeyOf: (T) -> String) -> [T] {
        var ordered = grouped(workspaces, groupKeyOf).map { key, members in
            members.stableSorted { left, right in
                // The repository itself leads its own group, whatever it is called.
                if left.orderKey == key { return -1 }
                if right.orderKey == key { return 1 }
                return localeCompareNumericBase(left.orderLabel, right.orderLabel)
            }
        }
        // A group sorts by the name of whatever leads it.
        ordered = ordered.stableSorted { left, right in
            localeCompareNumericBase(left.first?.orderLabel ?? "", right.first?.orderLabel ?? "")
        }
        return ordered.flatMap { $0 }
    }

    /// The explicit order, with everything it does not name folded back in.
    private static func mergeOrder<T: OrderableWorkspace>(_ automatic: [T], _ explicit: [String]) -> [T] {
        var byId: [String: T] = [:]
        for workspace in automatic { byId[workspace.orderId] = workspace }
        var merged: [T] = []
        var placed = Set<String>()
        for id in explicit {
            guard let workspace = byId[id], !placed.contains(id) else { continue }
            placed.insert(id)
            merged.append(workspace)
        }
        // `anchor` is where the row before this one in the automatic list ended up.
        var anchor = -1
        for workspace in automatic {
            if let at = merged.firstIndex(where: { $0.orderId == workspace.orderId }) {
                anchor = at
                continue
            }
            anchor += 1
            merged.insert(workspace, at: anchor)
        }
        return merged
    }

    /// The rows of one group, in the order they were left in, repository first.
    private static func regroup<T: OrderableWorkspace>(_ merged: [T], _ groupKeyOf: (T) -> String) -> [T] {
        grouped(merged, groupKeyOf).flatMap { key, members -> [T] in
            guard let head = members.firstIndex(where: { $0.orderKey == key }), head > 0 else { return members }
            var rest = members
            let leader = rest.remove(at: head)
            return [leader] + rest
        }
    }

    /// `orderWorkspaces`.
    public static func order<T: OrderableWorkspace>(
        _ workspaces: [T], mainWorktreeOf: (T) -> String?, explicit: [String] = []
    ) -> [T] {
        func groupKeyOf(_ workspace: T) -> String { groupKey(workspace.orderKey, mainWorktree: mainWorktreeOf(workspace)) }
        let automatic = automaticOrder(workspaces, groupKeyOf)
        if explicit.isEmpty { return automatic }
        return regroup(mergeOrder(automatic, explicit), groupKeyOf)
    }

    /// A group of rows as they are drawn: contiguous, repository first.
    private static func groupsOf<T: OrderableWorkspace>(_ ordered: [T], _ groupKeyOf: (T) -> String) -> [[T]] {
        var groups: [[T]] = []
        for workspace in ordered {
            if let last = groups.last, let first = last.first, groupKeyOf(first) == groupKeyOf(workspace) {
                groups[groups.count - 1].append(workspace)
                continue
            }
            groups.append([workspace])
        }
        return groups
    }

    /// `siblingsOf`: the group heads, if the row is one; otherwise the rest of
    /// its group (never above the repository).
    public static func siblings<T: OrderableWorkspace>(
        _ ordered: [T], mainWorktreeOf: (T) -> String?, workspaceId: String
    ) -> [T] {
        func groupKeyOf(_ workspace: T) -> String { groupKey(workspace.orderKey, mainWorktree: mainWorktreeOf(workspace)) }
        let groups = groupsOf(ordered, groupKeyOf)
        guard let group = groups.first(where: { $0.contains { $0.orderId == workspaceId } }) else { return [] }
        if group[0].orderId == workspaceId { return groups.map { $0[0] } }
        return groupKeyOf(group[0]) == group[0].orderKey ? Array(group.dropFirst()) : group
    }

    /// `placeWorkspace`: put a row above another one (`before`, nil = last),
    /// and say what the whole order then is; nil when the move may not be made.
    public static func place<T: OrderableWorkspace>(
        _ ordered: [T], mainWorktreeOf: (T) -> String?, workspaceId: String, before: String?
    ) -> [String]? {
        if before == workspaceId { return nil }
        func groupKeyOf(_ workspace: T) -> String { groupKey(workspace.orderKey, mainWorktree: mainWorktreeOf(workspace)) }
        let groups = groupsOf(ordered, groupKeyOf)
        guard let at = groups.firstIndex(where: { $0.contains { $0.orderId == workspaceId } }) else { return nil }
        let group = groups[at]
        let leads = group[0].orderId == workspaceId
        let laneIds: [String] = leads ? groups.map { $0[0].orderId } : group.map(\.orderId)
        let laneAt = leads ? at : group.firstIndex { $0.orderId == workspaceId }!
        let floor = leads || groupKeyOf(group[0]) != group[0].orderKey ? 0 : 1

        var target: Int
        if let before {
            guard let found = laneIds.firstIndex(of: before), found >= floor else { return nil }
            target = found > laneAt ? found - 1 : found
        } else {
            target = laneIds.count - 1
        }
        if target < floor || target == laneAt { return nil }

        if leads {
            var moved = groups
            let lifted = moved.remove(at: laneAt)
            moved.insert(lifted, at: target)
            return moved.flatMap { $0 }.map(\.orderId)
        }
        var movedGroup = group
        let lifted = movedGroup.remove(at: laneAt)
        movedGroup.insert(lifted, at: target)
        var regrouped = groups
        regrouped[at] = movedGroup
        return regrouped.flatMap { $0 }.map(\.orderId)
    }

    /// `moveWorkspace`: one row, one step among its siblings.
    public static func move<T: OrderableWorkspace>(
        _ ordered: [T], mainWorktreeOf: (T) -> String?, workspaceId: String, direction: MoveDirection
    ) -> [String]? {
        let siblings = siblings(ordered, mainWorktreeOf: mainWorktreeOf, workspaceId: workspaceId)
        guard let at = siblings.firstIndex(where: { $0.orderId == workspaceId }) else { return nil }
        guard case let .gap(before) = stepTarget(siblings.map(\.orderId), at, direction) else { return nil }
        return place(ordered, mainWorktreeOf: mainWorktreeOf, workspaceId: workspaceId, before: before)
    }

    private enum StepTarget { case none, gap(String?) }

    /// The gap one step over, as the id in front of it.
    private static func stepTarget(_ ids: [String], _ at: Int, _ direction: MoveDirection) -> StepTarget {
        if direction == .up { return at == 0 ? .none : .gap(ids[at - 1]) }
        if at >= ids.count - 1 { return .none }
        return .gap(at + 2 < ids.count ? ids[at + 2] : nil)
    }

    /// `placeAgent`: an Agent's siblings are the Agents of its own workspace.
    public static func placeAgent(_ agentIds: [String], agentId: String, before: String?) -> [String]? {
        if before == agentId { return nil }
        guard let at = agentIds.firstIndex(of: agentId) else { return nil }
        var target: Int
        if let before {
            guard let found = agentIds.firstIndex(of: before) else { return nil }
            target = found > at ? found - 1 : found
        } else {
            target = agentIds.count - 1
        }
        if target == at { return nil }
        var moved = agentIds
        moved.remove(at: at)
        moved.insert(agentId, at: target)
        return moved
    }

    /// `moveAgent`.
    public static func moveAgent(_ agentIds: [String], agentId: String, direction: MoveDirection) -> [String]? {
        guard let at = agentIds.firstIndex(of: agentId) else { return nil }
        guard case let .gap(before) = stepTarget(agentIds, at, direction) else { return nil }
        return placeAgent(agentIds, agentId: agentId, before: before)
    }
}
