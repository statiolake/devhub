// Port of apps/desktop/src/model/smartButtons.ts, and of `smartButtonTriggers`
// / `smartButtonValues` from apps/desktop/src/model/agentActions.ts
//
// Where an Agent pane's Smart Buttons stand.
//
// The box has a default spot per presentation — attached to the top right of a
// GUI Agent's composer, in the bottom right corner of a terminal above what
// became of a queued message — and a person may drag it anywhere in the pane.
// Where they put it is remembered per presentation, not per Agent. Absent is
// the default spot.
//
// **Anchored or free.** What is remembered is a *spot*. An anchored spot is
// attached to what the default spot stands on — the *anchor* — on one of the
// anchor's edges (`top`: standing on it; `side`: beside its right edge),
// `along` pixels in from the anchor's right (top) or bottom (side) edge. A
// drag that comes within `snap` pixels of one of those edges snaps to it and
// is dropped anchored (`snapSpot`); one that ends anywhere else is free.
//
// A free spot is an offset: the box's distance from the pane's right and
// bottom edges, in whole pixels.

import Foundation

public struct SmartButtonsOffset: Hashable, Sendable {
    public var right: Double
    public var bottom: Double

    public init(right: Double, bottom: Double) {
        self.right = right
        self.bottom = bottom
    }
}

public enum SmartButtonsEdge: String, Hashable, Sendable {
    case top
    case side
}

/// Where a box is: anchored to the composer (or corner), or a free offset.
public enum SmartButtonsSpot: Hashable, Sendable {
    case anchored(edge: SmartButtonsEdge, along: Double)
    case free(SmartButtonsOffset)

    public var isAnchored: Bool { if case .anchored = self { return true } else { return false } }
}

/// The spot a person dragged each presentation's box to, if they did.
public struct SmartButtonsPlacement: Hashable, Sendable {
    public var tui: SmartButtonsSpot?
    public var gui: SmartButtonsSpot?

    public init(tui: SmartButtonsSpot? = nil, gui: SmartButtonsSpot? = nil) {
        self.tui = tui
        self.gui = gui
    }

    public subscript(presentation: AgentPresentation) -> SmartButtonsSpot? {
        get { presentation == .tui ? tui : gui }
        set { if presentation == .tui { tui = newValue } else { gui = newValue } }
    }
}

public struct LayoutBox: Hashable, Sendable {
    public var top: Double
    public var right: Double
    public var bottom: Double
    public var left: Double

    public init(top: Double, right: Double, bottom: Double, left: Double) {
        self.top = top
        self.right = right
        self.bottom = bottom
        self.left = left
    }
}

public struct LayoutSize: Hashable, Sendable {
    public var width: Double
    public var height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

/// How the box meets what it stands on.
public struct SmartButtonsSpacing: Hashable, Sendable {
    /// The default `along` on the top edge: past a composer's rounded corner.
    public var inset: Double
    /// The gap between the anchor's edge and the box.
    public var gap: Double

    public init(inset: Double, gap: Double) {
        self.inset = inset
        self.gap = gap
    }
}

public enum SmartButtons {
    /// Larger than any display, and small enough that a number past it is a bug.
    public static let maxOffset: Double = 100_000
    /// How far a pointer has to move before the press is a drag.
    public static let dragThreshold: Double = 3
    /// The gap between a terminal pane's corner and the box, as `--space-3`.
    public static let margin: Double = 12
    /// How near an anchor's edge a dragged box has to come to snap to it.
    public static let snap: Double = 16

    private static func isPixels(_ value: Double) -> Bool {
        value.isFinite && value.rounded() == value && value >= 0 && value <= maxOffset
    }

    /// `isSmartButtonsOffset`.
    public static func isOffset(_ value: SmartButtonsOffset) -> Bool { isPixels(value.right) && isPixels(value.bottom) }

    /// `isSmartButtonsSpot`.
    public static func isSpot(_ value: SmartButtonsSpot) -> Bool {
        switch value {
        case let .anchored(_, along): return isPixels(along)
        case let .free(offset): return isOffset(offset)
        }
    }

    /// `clampOffset`: the offset, moved so the whole box is inside the pane.
    public static func clampOffset(_ offset: SmartButtonsOffset, pane: LayoutSize, box: LayoutSize) -> SmartButtonsOffset {
        func within(_ value: Double, _ room: Double) -> Double { jsRoundDouble(min(max(value, 0), max(room, 0))) }
        return SmartButtonsOffset(right: within(offset.right, pane.width - box.width), bottom: within(offset.bottom, pane.height - box.height))
    }

    /// `draggedOffset`.
    public static func draggedOffset(
        _ start: SmartButtonsOffset, movedX: Double, movedY: Double, pane: LayoutSize, box: LayoutSize
    ) -> SmartButtonsOffset {
        clampOffset(SmartButtonsOffset(right: start.right - movedX, bottom: start.bottom - movedY), pane: pane, box: box)
    }

    /// `anchorBox`: the element, or with none a line `margin` above the
    /// pane's bottom edge.
    public static func anchorBox(pane: LayoutBox, anchor: LayoutBox?, spacing: SmartButtonsSpacing) -> LayoutBox {
        if let anchor { return anchor }
        let right = pane.right - margin
        let top = pane.bottom - margin + spacing.gap
        return LayoutBox(top: top, right: right, bottom: top, left: pane.left + margin)
    }

    /// `anchoredOffset`.
    public static func anchoredOffset(
        edge: SmartButtonsEdge, along: Double, pane: LayoutBox, anchor: LayoutBox, box: LayoutSize, spacing: SmartButtonsSpacing
    ) -> SmartButtonsOffset {
        if edge == .top {
            return SmartButtonsOffset(
                right: jsRoundDouble(pane.right - anchor.right + along),
                bottom: jsRoundDouble(pane.bottom - anchor.top + spacing.gap)
            )
        }
        return SmartButtonsOffset(
            right: jsRoundDouble(pane.right - anchor.right - spacing.gap - box.width),
            bottom: jsRoundDouble(pane.bottom - anchor.bottom + along)
        )
    }

    /// `spotOffset`.
    public static func spotOffset(
        _ spot: SmartButtonsSpot, pane: LayoutBox, anchor: LayoutBox, box: LayoutSize, spacing: SmartButtonsSpacing
    ) -> SmartButtonsOffset {
        switch spot {
        case let .anchored(edge, along):
            return anchoredOffset(edge: edge, along: along, pane: pane, anchor: anchor, box: box, spacing: spacing)
        case let .free(offset): return offset
        }
    }

    /// `defaultSpot`.
    public static func defaultSpot(_ spacing: SmartButtonsSpacing) -> SmartButtonsSpot {
        .anchored(edge: .top, along: spacing.inset)
    }

    /// `snapSpot`: anchored to an edge of the anchor the box is within
    /// `snap` of, or free at that offset. The nearer edge wins, the top on a tie.
    public static func snapSpot(
        _ offset: SmartButtonsOffset, pane: LayoutBox, anchor: LayoutBox, box: LayoutSize, spacing: SmartButtonsSpacing
    ) -> SmartButtonsSpot {
        let boxRight = pane.right - offset.right
        let boxBottom = pane.bottom - offset.bottom
        let boxLeft = boxRight - box.width
        let boxTop = boxBottom - box.height
        let across = boxLeft <= anchor.right && boxRight >= anchor.left
        let upDown = boxTop <= anchor.bottom && boxBottom >= anchor.top
        let toTop = abs(boxBottom - (anchor.top - spacing.gap))
        let toSide = abs(boxLeft - (anchor.right + spacing.gap))
        let top = across && toTop <= snap ? toTop : Double.infinity
        let side = upDown && toSide <= snap ? toSide : Double.infinity
        if top == .infinity && side == .infinity { return .free(offset) }
        func along(_ value: Double) -> Double { min(max(jsRoundDouble(value), 0), maxOffset) }
        if top <= side { return .anchored(edge: .top, along: along(anchor.right - boxRight)) }
        return .anchored(edge: .side, along: along(anchor.bottom - boxBottom))
    }

    /// `defaultOffset`.
    public static func defaultOffset(pane: LayoutBox, anchor: LayoutBox?, spacing: SmartButtonsSpacing) -> SmartButtonsOffset {
        guard let anchor else { return SmartButtonsOffset(right: margin, bottom: margin) }
        return anchoredOffset(
            edge: .top, along: spacing.inset, pane: pane, anchor: anchor, box: LayoutSize(width: 0, height: 0), spacing: spacing
        )
    }

    // MARK: - agentActions.ts: the buttons' conditions

    /// `smartButtonTriggers`: which Smart Button triggers hold for an Agent,
    /// in `ACTION_TRIGGERS` order. Nothing unless the Agent is idle.
    public static func triggers(status: AgentStatus, repository: WorkspaceRepositoryWire?) -> [AgentActionTrigger] {
        if status != .idle { return [] }
        guard let repository else { return [.always] }
        let pullRequest = repository.pullRequest
        let live = pullRequest.map { $0.state == .open || $0.state == .draft } ?? false
        func holds(_ trigger: AgentActionTrigger) -> Bool {
            switch trigger {
            case .issue: return false
            case .commit: return repository.dirty == true
            case .push: return (repository.ahead ?? 0) > 0
            case .pullRequest:
                guard pullRequest == nil, let branch = repository.branch, let trunk = repository.defaultBranch else { return false }
                return branch != trunk
            case .draftPullRequest: return pullRequest?.state == .draft
            case .unresolvedReviewComments:
                guard live, let pullRequest else { return false }
                return pullRequest.conversations.unresolved > 0 || pullRequest.conversations.uncounted > 0
            case .ciFailing: return live && pullRequest?.checks?.state == .failing
            case .always: return true
            }
        }
        return AgentActionTrigger.ordered.filter(holds)
    }

    /// `smartButtonValues`: the values a Smart Button's wording is filled from.
    /// Only what is known. `UNRESOLVED` says `"100+"` when threads went uncounted.
    public static func values(_ repository: WorkspaceRepositoryWire?) -> [String: String] {
        var values: [String: String] = [:]
        if let branch = repository?.branch { values["BRANCH"] = branch }
        if let pullRequest = repository?.pullRequest {
            values["PR_URL"] = pullRequest.url
            values["PR_NO"] = String(pullRequest.number)
            let unresolved = pullRequest.conversations.unresolved
            values["UNRESOLVED"] = pullRequest.conversations.uncounted > 0 ? "\(unresolved)+" : String(unresolved)
            if let checks = pullRequest.checks { values["FAILING"] = String(checks.failing) }
        }
        return values
    }
}
