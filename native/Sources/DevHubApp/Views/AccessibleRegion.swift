// What VoiceOver reads of a control a view draws itself — the title bar's
// buttons, the seams, the Sidebar's resize handle — as the TS app's DOM has
// them (`aria-label`, `role="separator"` with its value and its arrow keys).
// A region sits over the drawn control and takes no pointer: the view under it
// keeps the clicks and drags; the region answers the accessibility actions.
//
// A separator's region is also its keyboard stop (`tabIndex={0}`): `focusable`
// puts it in the key view loop its owner keeps (Tab and Shift-Tab), its owner
// answers the keys (`onKey`, the separator's arrow keys) and draws it lit
// while it has the keys (`onFocusChange`, `:focus-visible`). The pointer never
// gives it the keys — a drag leaves them where they were, so a terminal keeps
// typing after its seam is moved.

import AppKit
import DevHubCore

@MainActor
class AccessibleRegion: NSView {
    /// Press (a button).
    var onPress: (() -> Void)?
    /// Increment (+1) or decrement (−1) (a separator: the arrow keys' step).
    var onStep: ((Int) -> Void)?
    /// A keyboard stop (a separator): Tab reaches it, its keys are `onKey`'s.
    var focusable = false
    /// A key while it has the keyboard, by `MacKeys.key` name. True: handled.
    var onKey: ((String) -> Bool)?
    /// It took (true) or gave up (false) the keyboard.
    var onFocusChange: ((Bool) -> Void)?
    /// Whether it has the keyboard now.
    var hasKeyboard: Bool { window?.firstResponder === self }

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

    override var acceptsFirstResponder: Bool { focusable && !isHiddenOrHasHiddenAncestor }
    override var canBecomeKeyView: Bool { acceptsFirstResponder && window != nil }
    override var focusRingType: NSFocusRingType { get { .none } set {} }

    override func becomeFirstResponder() -> Bool {
        onFocusChange?(true)
        return true
    }

    override func resignFirstResponder() -> Bool {
        onFocusChange?(false)
        return true
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection([.command, .control, .option])
        if flags.isEmpty, let onKey, onKey(MacKeys.key(characters: event.charactersIgnoringModifiers, keyCode: event.keyCode)) {
            return
        }
        // Tab and everything else: the owner's (its key view loop).
        super.keyDown(with: event)
    }

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

/// A view's own key view loop: Tab and Shift-Tab step through `stops` (those
/// that can take the keys now), from the one that has them, wrapping.
@MainActor
enum KeyViewLoop {
    /// Link `stops` as the window's key view loop (`nextKeyView`), in order.
    static func link(_ stops: [NSView]) {
        for (index, stop) in stops.enumerated() { stop.nextKeyView = stops[(index + 1) % stops.count] }
    }

    /// Move the keys along `stops` for a Tab (`backward`: Shift-Tab). False:
    /// not a Tab, or nowhere to go.
    static func step(_ event: NSEvent, in window: NSWindow?, stops: [NSView]) -> Bool {
        guard let window, event.keyCode == 0x30,
              event.modifierFlags.intersection([.command, .control, .option]).isEmpty else { return false }
        let valid = stops.filter(\.canBecomeKeyView)
        guard !valid.isEmpty else { return false }
        let backward = event.modifierFlags.contains(.shift)
        let current = valid.firstIndex { stop in
            guard let view = window.firstResponder as? NSView else { return false }
            return view === stop || view.isDescendant(of: stop)
        }
        let next: Int
        if let current {
            next = (current + (backward ? valid.count - 1 : 1)) % valid.count
        } else {
            next = backward ? valid.count - 1 : 0
        }
        window.makeFirstResponder(valid[next])
        return true
    }
}
