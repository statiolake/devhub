// The theme's values in AppKit's terms: colours, appearances and the terminal
// font. The rules are Core's (`DevHubTheme`, `AppearanceMode`,
// `TerminalFontStack`); this file only converts.

import AppKit
import DevHubCore

extension DevHubColor {
    /// The colour in sRGB, as the TS app's pages paint it.
    var nsColor: NSColor {
        NSColor(srgbRed: CGFloat(red), green: CGFloat(green), blue: CGFloat(blue), alpha: CGFloat(alpha))
    }

    var cgColor: CGColor { nsColor.cgColor }
}

extension ThemeColor {
    var nsColor: NSColor { DevHubColor(self).nsColor }
}

extension NSAppearance {
    /// What `AppearanceMode` asks the application to be: `nil` follows the OS.
    static func devHub(_ source: AppearanceSource) -> NSAppearance? {
        switch source {
        case .system: return nil
        case .light: return NSAppearance(named: .aqua)
        case .dark: return NSAppearance(named: .darkAqua)
        }
    }

    /// Whether this appearance is a dark one (Dark Aqua, or its high-contrast
    /// and vibrant variants).
    var isDarkAppearance: Bool {
        bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }
}

enum TerminalFonts {
    /// Whether a family (or a PostScript name) is installed.
    static func isInstalled(_ name: String) -> Bool {
        NSFontManager.shared.availableMembers(ofFontFamily: name) != nil || NSFont(name: name, size: 12) != nil
    }

    /// The font a `terminal_font_family` stack lands on at `size`, as CSS
    /// lands on one: the first installed family, else the system monospace.
    static func font(family: String?, size: CGFloat) -> NSFont {
        let fallback = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
        switch TerminalFontStack.resolve(family, isInstalled: isInstalled) {
        case .family(let name):
            return NSFontManager.shared.font(withFamily: name, traits: [], weight: 5, size: size)
                ?? NSFont(name: name, size: size)
                ?? fallback
        case .systemMonospace:
            return fallback
        case .generic(let name):
            switch name {
            case "serif":
                let descriptor = NSFont.systemFont(ofSize: size).fontDescriptor.withDesign(.serif)
                return descriptor.flatMap { NSFont(descriptor: $0, size: size) } ?? NSFont.systemFont(ofSize: size)
            default:
                return NSFont.systemFont(ofSize: size)
            }
        }
    }
}
