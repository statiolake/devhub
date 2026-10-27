// Port of apps/desktop/src/shell/conversation/icons.tsx.
//
// The few glyphs the conversation draws, on a 16-unit box, stroked at 1.5 in
// the ink of the text around them and at its size (`1em`): decorative, the
// control they sit in carries the name.

import Foundation

public enum ConversationIcons {
    /// The stroke every icon is drawn at, in its box's units.
    public static let stroke: Double = 1.5

    public static func drawing(_ icon: DocIcon) -> GlyphDrawing {
        switch icon {
        case .send, .arrowUp: return GlyphDrawing([.path("M8 13V3M3.5 7.5 8 3l4.5 4.5", filled: false)])
        case .clock:
            return GlyphDrawing([.circle(cx: 8, cy: 8, r: 5.5, filled: false), .path("M8 5v3l2 1.5", filled: false)])
        case .edit: return GlyphDrawing([.path("M10.5 3.5 12.5 5.5M3.5 12.5l.5-2.5 6.5-6.5 2 2L6 12z", filled: false)])
        case .rewind: return GlyphDrawing([.path("M4 3v3.5h3.5M4.3 6.2A5 5 0 1 1 3 9.5", filled: false)])
        case .mic:
            return GlyphDrawing([
                .rect(x: 5.75, y: 1.75, width: 4.5, height: 8, radius: 2.25),
                .path("M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25", filled: false),
            ])
        case .stop:
            return GlyphDrawing([.path("M5.5 4h5A1.5 1.5 0 0 1 12 5.5v5A1.5 1.5 0 0 1 10.5 12h-5A1.5 1.5 0 0 1 4 10.5v-5A1.5 1.5 0 0 1 5.5 4z", filled: true)])
        case .copy:
            return GlyphDrawing([
                .rect(x: 5.5, y: 5.5, width: 8, height: 8, radius: 1.5),
                .path("M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5", filled: false),
            ])
        case .check: return GlyphDrawing([.path("m3 8.5 3 3 7-7", filled: false)])
        case .arrowDown: return GlyphDrawing([.path("M8 3v10M3.5 8.5 8 13l4.5-4.5", filled: false)])
        case .close: return GlyphDrawing([.path("M4 4l8 8M12 4l-8 8", filled: false)])
        case .arrowLeft: return GlyphDrawing([.path("M13 8H3M7.5 3.5 3 8l4.5 4.5", filled: false)])
        case .chevronDown: return GlyphDrawing([.path("m4 6 4 4 4-4", filled: false)])
        case .chevronRight: return GlyphDrawing([.path("m6 4 4 4-4 4", filled: false)])
        case .maximize: return GlyphDrawing([.path("M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10", filled: false)])
        case .column:
            return GlyphDrawing([.rect(x: 2, y: 3, width: 12, height: 10, radius: 1.5), .path("M9.5 3v10", filled: false)])
        }
    }
}
