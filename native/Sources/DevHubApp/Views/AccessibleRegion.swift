// What VoiceOver reads of a control a view draws itself — the title bar's
// buttons, the seams, the Sidebar's resize handle — as the TS app's DOM has
// them (`aria-label`, `role="separator"` with its value and its arrow keys).
// A region sits over the drawn control and takes no pointer: the view under it
// keeps the clicks and drags; the region answers the accessibility actions.

import AppKit

@MainActor
final class AccessibleRegion: NSView {
    /// Press (a button).
    var onPress: (() -> Void)?
    /// Increment (+1) or decrement (−1) (a separator: the arrow keys' step).
    var onStep: ((Int) -> Void)?

    init(role: NSAccessibility.Role, label: String) {
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(role)
        setAccessibilityLabel(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func accessibilityPerformPress() -> Bool {
        guard let onPress, isAccessibilityEnabled() else { return false }
        onPress()
        return true
    }

    override func accessibilityPerformIncrement() -> Bool {
        guard let onStep else { return false }
        onStep(1)
        return true
    }

    override func accessibilityPerformDecrement() -> Bool {
        guard let onStep else { return false }
        onStep(-1)
        return true
    }
}
