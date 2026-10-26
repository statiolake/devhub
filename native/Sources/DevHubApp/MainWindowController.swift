import AppKit
import DevHubCore

/// The one window. Phase 0 draws the two regions the layout owner
/// (`WindowLayout` in Core, WP9) will place children into: the Sidebar column
/// and the content area.
@MainActor
final class MainWindowController: NSWindowController {
    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "DevHub"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 640, height: 400)
        window.setFrameAutosaveName("DevHubMainWindow")
        window.center()
        super.init(window: window)
        window.contentView = PlaceholderContentView(frame: window.contentLayoutRect)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }
}

private final class PlaceholderContentView: NSView {
    private let sidebar = NSVisualEffectView()
    private let content = NSView()
    private let label = NSTextField(labelWithString: DevHubVersion.description)

    override init(frame: NSRect) {
        super.init(frame: frame)
        sidebar.material = .sidebar
        sidebar.blendingMode = .behindWindow
        sidebar.state = .followsWindowActiveState
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
        label.textColor = .secondaryLabelColor
        label.font = .systemFont(ofSize: 13)
        addSubview(sidebar)
        addSubview(content)
        content.addSubview(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func layout() {
        super.layout()
        let sidebarWidth: CGFloat = 249
        sidebar.frame = NSRect(x: 0, y: 0, width: sidebarWidth, height: bounds.height)
        content.frame = NSRect(x: sidebarWidth, y: 0, width: max(0, bounds.width - sidebarWidth), height: bounds.height)
        label.sizeToFit()
        label.frame.origin = NSPoint(
            x: (content.bounds.width - label.frame.width) / 2,
            y: (content.bounds.height - label.frame.height) / 2
        )
    }
}
