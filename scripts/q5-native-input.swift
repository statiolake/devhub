import CoreGraphics
import AppKit
import Foundation

enum InputError: Error {
    case invalidCoordinate
    case invalidCommand
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

func click(at point: CGPoint) -> Int64 {
    postMouse(.mouseMoved, at: point)
    // Capture the common wall-clock event boundary immediately before the
    // action-producing mouse-down post. CGEvent.post can synchronously wait
    // while the app dispatches the event, so sampling after post would measure
    // product work before the reported start and create a false clock-order
    // failure.
    let timestamp = wallClockNanoseconds()
    postMouse(.leftMouseDown, at: point)
    postMouse(.leftMouseUp, at: point)
    return timestamp
}

func key(_ code: CGKeyCode, flags: CGEventFlags = []) -> Int64 {
    let timestamp = wallClockNanoseconds()
    let down = CGEvent(keyboardEventSource: source(), virtualKey: code, keyDown: true)!
    down.flags = flags
    down.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: source(), virtualKey: code, keyDown: false)!
    up.flags = flags
    up.post(tap: .cghidEventTap)
    return timestamp
}

func wallClockNanoseconds() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1_000_000_000.0)
}

func emit(_ value: String) {
    let data = (value + "\n").data(using: .utf8)!
    FileHandle.standardOutput.write(data)
}

func run(_ fields: [Substring]) throws -> Int64 {
    guard let operation = fields.first else { throw InputError.invalidCommand }
    switch operation {
    case "click":
        guard fields.count == 3 else { throw InputError.invalidCommand }
        let point = CGPoint(
            x: try coordinate(String(fields[1])),
            y: try coordinate(String(fields[2]))
        )
        return click(at: point)
    case "press-enter":
        guard fields.count == 1 else { throw InputError.invalidCommand }
        // The acceptance sentinel is an empty command line. It is fixed,
        // harmless, and its content is never emitted to diagnostics.
        return key(36)
    case "activate-pid":
        guard fields.count == 2, let pid = Int32(fields[1]), pid > 0,
              let application = NSRunningApplication(processIdentifier: pid),
              application.activate(options: [.activateIgnoringOtherApps]) else {
            throw InputError.invalidCommand
        }
        return wallClockNanoseconds()
    case "key":
        guard fields.count == 2, let code = UInt16(fields[1]) else {
            throw InputError.invalidCommand
        }
        return key(CGKeyCode(code))
    case "command-key":
        guard fields.count == 2, let code = UInt16(fields[1]) else {
            throw InputError.invalidCommand
        }
        return key(CGKeyCode(code), flags: .maskCommand)
    case "quit":
        guard fields.count == 1 else { throw InputError.invalidCommand }
        exit(0)
    default:
        throw InputError.invalidCommand
    }
}

while let line = readLine(strippingNewline: true) {
    do {
        let fields = line.split(separator: " ", omittingEmptySubsequences: true)
        emit("posted \(try run(fields))")
    } catch {
        // Keep the actor protocol closed and content-free. Python treats any
        // non-posted response as an input failure and never records it.
        emit("error invalid_command")
    }
}
