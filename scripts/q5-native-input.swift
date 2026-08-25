import CoreGraphics
import AppKit
import Foundation
import ApplicationServices

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

func unicodeText(_ text: String) -> Int64 {
    let timestamp = wallClockNanoseconds()
    let units = Array(text.utf16)
    let down = CGEvent(keyboardEventSource: source(), virtualKey: 0, keyDown: true)!
    units.withUnsafeBufferPointer { buffer in
        guard let baseAddress = buffer.baseAddress else { return }
        down.keyboardSetUnicodeString(
            stringLength: buffer.count,
            unicodeString: baseAddress
        )
    }
    down.post(tap: .cghidEventTap)
    // Unicode text is carried by the key-down event; pair it with a neutral
    // key-up so the helper never leaves a synthetic key held in the target.
    let up = CGEvent(keyboardEventSource: source(), virtualKey: 0, keyDown: false)!
    up.post(tap: .cghidEventTap)
    return timestamp
}

let q5FileName = "q5-input.txt"
let q5FileNameKeyCodes: [CGKeyCode] = [
    CGKeyCode(12), // q
    CGKeyCode(23), // 5
    CGKeyCode(27), // -
    CGKeyCode(34), // i
    CGKeyCode(45), // n
    CGKeyCode(35), // p
    CGKeyCode(32), // u
    CGKeyCode(17), // t
    CGKeyCode(47), // .
    CGKeyCode(17), // t
    CGKeyCode(7),  // x
    CGKeyCode(17), // t
]

func typeQ5FileName() -> Int64 {
    // Use one Unicode text event for the generated fixture. A keycode burst can
    // outrun a WebKit text field and lose one character before Quick Open has
    // accepted the complete canonical filename. The action remains a fixed,
    // user-faithful native keyboard input and diagnostics never retain text.
    precondition(q5FileName.utf8.count == q5FileNameKeyCodes.count)
    return unicodeText(q5FileName)
}

func typeEditCharacter() -> Int64 {
    // Use the physical x key so the edit follows Monaco's native key path.
    return key(CGKeyCode(7))
}

func wallClockNanoseconds() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1_000_000_000.0)
}

func boundedWindowFact(_ value: Int) -> Int {
    min(max(value, 0), 64)
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
        return nil
    }
    return value as? String
}

func axIsVisible(_ element: AXUIElement) -> Bool {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXHiddenAttribute as CFString,
        &value
    ) == .success,
    let hidden = value as? Bool else {
        // This fact is diagnostic-only. Activation uses the on-screen
        // layer-0 CGWindow identity because AXHidden is unreliable during
        // native WebView restoration.
        return false
    }
    return !hidden
}

func focusedPID() -> pid_t? {
    let system = AXUIElementCreateSystemWide()
    var focusedValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        system,
        kAXFocusedUIElementAttribute as CFString,
        &focusedValue
    ) == .success,
    let focusedValue,
    CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
        return nil
    }
    let focused = focusedValue as! AXUIElement
    var pid: pid_t = 0
    guard AXUIElementGetPid(focused, &pid) == .success else {
        return nil
    }
    return pid
}

func hasExactlyOneOnScreenLayerZeroWindow(for pid: pid_t) -> Bool {
    guard let infoList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return false
    }
    let matches = infoList.filter { info in
        let ownerPID = info[kCGWindowOwnerPID as String] as? Int ?? -1
        let layer = info[kCGWindowLayer as String] as? Int ?? -1
        return ownerPID == Int(pid) && layer == 0
    }
    return matches.count == 1
}

func exactDevHubWindow(for pid: pid_t, application: AXUIElement) -> AXUIElement? {
    // AXHidden is unreliable while a native WebView is being restored. The
    // on-screen layer-0 CGWindow identity is the visibility gate; AX is used
    // only to select the uniquely titled DevHub window, never to pick a first
    // or otherwise arbitrary window.
    guard hasExactlyOneOnScreenLayerZeroWindow(for: pid) else {
        return nil
    }
    var windowsValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        application,
        kAXWindowsAttribute as CFString,
        &windowsValue
    ) == .success,
    let windows = windowsValue as? [AXUIElement] else {
        return nil
    }
    let matches = windows.filter { axString($0, kAXTitleAttribute as CFString) == "DevHub" }
    return matches.count == 1 ? matches[0] : nil
}

func activatePID(_ pid: pid_t) -> Int64? {
    let timestamp = wallClockNanoseconds()
    let deadline = Date().addingTimeInterval(2.0)
    while Date() < deadline {
        // Every attempt re-discovers the exact process and uniquely titled
        // DevHub window. A missing target is transient, never a reason to
        // select an arbitrary window or fail before the deadline.
        guard let application = NSRunningApplication(processIdentifier: pid) else {
            Thread.sleep(forTimeInterval: 0.05)
            continue
        }
        // These activation results are advisory. macOS may report failure even
        // when the observed frontmost/focused state settles successfully.
        _ = application.unhide()
        _ = application.activate(options: [.activateAllWindows])
        let axApplication = AXUIElementCreateApplication(pid)
        _ = AXUIElementSetAttributeValue(
            axApplication,
            kAXFrontmostAttribute as CFString,
            kCFBooleanTrue
        )
        guard let window = exactDevHubWindow(for: pid, application: axApplication) else {
            Thread.sleep(forTimeInterval: 0.05)
            continue
        }
        // These setters are advisory. Pin the exact uniquely identified
        // window as both the app's focused window and the window's main and
        // focused target before raising it; the postcondition below still
        // relies only on the observed final PID-bound frontmost/focus state.
        _ = AXUIElementSetAttributeValue(
            window,
            kAXMainAttribute as CFString,
            kCFBooleanTrue
        )
        _ = AXUIElementSetAttributeValue(
            window,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
        _ = AXUIElementSetAttributeValue(
            axApplication,
            kAXFocusedWindowAttribute as CFString,
            window
        )
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        if frontmost && focusedPID() == pid {
            return timestamp
        }
        if Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
    }
    return nil
}

func probePID(_ pid: pid_t) -> String {
    var cgWindowCount = 0
    var cgOrigin: CGPoint?
    if let infoList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] {
        for info in infoList {
            let ownerPID = info[kCGWindowOwnerPID as String] as? Int ?? -1
            let layer = info[kCGWindowLayer as String] as? Int ?? -1
            if ownerPID == Int(pid) && layer == 0 {
                cgWindowCount += 1
                if cgOrigin == nil,
                   let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                   let rect = CGRect(dictionaryRepresentation: bounds) {
                    cgOrigin = rect.origin
                }
            }
        }
    }

    var axWindowCount = 0
    var axDevHubTitleMatchCount = 0
    var axWindowRoleCount = 0
    var axStandardRoleCount = 0
    var axVisibleWindowCount = 0
    var axStandardVisibleCount = 0
    var axRoleAttributeSuccessCount = 0
    var axUnknownRoleCount = 0
    var axHiddenTrueCount = 0
    var axHiddenFalseCount = 0
    let application = AXUIElementCreateApplication(pid)
    var windowsValue: CFTypeRef?
    let axStatus = AXUIElementCopyAttributeValue(
        application,
        kAXWindowsAttribute as CFString,
        &windowsValue
    )
    if axStatus == .success, let windows = windowsValue as? [AXUIElement] {
        axWindowCount = windows.count
        for window in windows {
            if axString(window, kAXTitleAttribute as CFString) == "DevHub" {
                axDevHubTitleMatchCount += 1
            }
            var roleValue: CFTypeRef?
            let roleStatus = AXUIElementCopyAttributeValue(
                window,
                kAXRoleAttribute as CFString,
                &roleValue
            )
            if roleStatus == .success {
                axRoleAttributeSuccessCount += 1
            }
            let role = roleValue as? String
            if role == "AXUnknown" {
                axUnknownRoleCount += 1
            }
            let subrole = axString(window, kAXSubroleAttribute as CFString)
            let isWindowRole = role == (kAXWindowRole as String)
            let isStandardRole = isWindowRole && subrole == (kAXStandardWindowSubrole as String)
            let isVisible = axIsVisible(window)
            if isVisible {
                axHiddenFalseCount += 1
            } else {
                axHiddenTrueCount += 1
            }
            if isWindowRole {
                axWindowRoleCount += 1
            }
            if isStandardRole {
                axStandardRoleCount += 1
            }
            if isWindowRole && isVisible {
                axVisibleWindowCount += 1
            }
            if isStandardRole && isVisible {
                axStandardVisibleCount += 1
            }
        }
    }
    let origin = cgOrigin.map { "\(Int($0.x)),\(Int($0.y))" } ?? "none"
    return "window-probe status=ok cg_count=\(boundedWindowFact(cgWindowCount)) cg_origin=\(origin) ax_count=\(boundedWindowFact(axWindowCount)) devhub=\(boundedWindowFact(axDevHubTitleMatchCount)) window_role=\(boundedWindowFact(axWindowRoleCount)) standard_role=\(boundedWindowFact(axStandardRoleCount)) visible_window=\(boundedWindowFact(axVisibleWindowCount)) standard_visible=\(boundedWindowFact(axStandardVisibleCount)) role_success=\(boundedWindowFact(axRoleAttributeSuccessCount)) unknown_role=\(boundedWindowFact(axUnknownRoleCount)) hidden_true=\(boundedWindowFact(axHiddenTrueCount)) hidden_false=\(boundedWindowFact(axHiddenFalseCount))"
}

func emit(_ value: String) {
    let data = (value + "\n").data(using: .utf8)!
    FileHandle.standardOutput.write(data)
}

func runProbe(_ fields: [Substring]) throws -> String {
    guard fields.count == 2, fields[0] == "probe-pid", let pid = Int32(fields[1]), pid > 0 else {
        throw InputError.invalidCommand
    }
    return probePID(pid)
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
    case "type-q5-file":
        guard fields.count == 1 else { throw InputError.invalidCommand }
        return typeQ5FileName()
    case "type-edit-character":
        guard fields.count == 1 else { throw InputError.invalidCommand }
        return typeEditCharacter()
    case "activate-pid":
        guard fields.count == 2, let pid = Int32(fields[1]), pid > 0,
              let timestamp = activatePID(pid) else {
            throw InputError.invalidCommand
        }
        return timestamp
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
        if fields.first == "probe-pid" {
            emit(try runProbe(fields))
        } else {
            emit("posted \(try run(fields))")
        }
    } catch {
        // Keep the actor protocol closed and content-free. Python treats any
        // non-posted response as an input failure and never records it.
        emit("error invalid_command")
    }
}
