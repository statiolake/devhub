import AppKit
import SwiftTerm

/// Proves the terminal dependency resolves, builds and links on macOS.
/// WP9 replaces this with `TerminalSurface`, a SwiftTerm `TerminalView` fed by
/// `tmux attach-session` on a PTY.
@MainActor
enum TerminalSurfaceProbe {
    static func links() -> Bool {
        let view = TerminalView(frame: NSRect(x: 0, y: 0, width: 320, height: 200))
        view.feed(text: "devhub\r\n")
        return view.getTerminal().cols > 0
    }
}
