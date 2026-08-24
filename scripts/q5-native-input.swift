import CoreGraphics
import Foundation

enum InputError: Error {
    case usage
    case invalidCoordinate
    case invalidKey
}

func coordinate(_ value: String) throws -> CGFloat {
    guard let number = Double(value), number.isFinite else {
        throw InputError.invalidCoordinate
    }
    return CGFloat(number)
}

func source() -> CGEventSource {
    CGEventSource(stateID: .hidSystemState)!
}

func postMouse(_ type: CGEventType, at point: CGPoint) {
    let event = CGEvent(
        mouseEventSource: source(),
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: .left
    )!
    event.post(tap: .cghidEventTap)
}

func click(at point: CGPoint) {
    postMouse(.mouseMoved, at: point)
    usleep(50_000)
    postMouse(.leftMouseDown, at: point)
    usleep(50_000)
    postMouse(.leftMouseUp, at: point)
}

func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
    let down = CGEvent(keyboardEventSource: source(), virtualKey: code, keyDown: true)!
    down.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(30_000)
    let up = CGEvent(keyboardEventSource: source(), virtualKey: code, keyDown: false)!
    up.flags = flags
    up.post(tap: .cghidEventTap)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let operation = arguments.first else { throw InputError.usage }

switch operation {
case "click", "activate":
    guard arguments.count == 3 else { throw InputError.usage }
    let point = CGPoint(x: try coordinate(arguments[1]), y: try coordinate(arguments[2]))
    click(at: point)
    if operation == "activate" {
        usleep(80_000)
        key(36)
    }
case "key":
    guard arguments.count == 2, let code = UInt16(arguments[1]) else { throw InputError.invalidKey }
    key(CGKeyCode(code))
case "command-key":
    guard arguments.count == 2, let code = UInt16(arguments[1]) else { throw InputError.invalidKey }
    key(CGKeyCode(code), flags: .maskCommand)
default:
    throw InputError.usage
}
