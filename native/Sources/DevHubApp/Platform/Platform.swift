// The Mac's own services, behind Core's ports:
//
//   AppDock           `AttentionDock` (windowAttention.ts `platformDock`): the
//                     Dock badge and the critical bounce.
//   Notifications     `UNUserNotificationCenter` for an Agent's turn
//                     (`showAgentNotification`) and `devhub --tell notify`.
//   TISInputSources   `InputSourcePort` (main/native/inputSource.c): the
//                     ASCII-capable input source while a chord is armed.

import AppKit
import Carbon
import DevHubCore
import UserNotifications

@MainActor
final class AppDock: AttentionDock {
    nonisolated func setBadge(_ text: String) {
        MainActor.assumeIsolated { NSApp.dockTile.badgeLabel = text.isEmpty ? nil : text }
    }

    nonisolated func bounceCritical() -> Int {
        MainActor.assumeIsolated { NSApp.requestUserAttention(.criticalRequest) }
    }

    nonisolated func cancelBounce(_ id: Int) {
        MainActor.assumeIsolated { NSApp.cancelUserAttentionRequest(id) }
    }
}

/// The notifications DevHub posts, and what a click on one does.
@MainActor
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    /// A click on an Agent's notification: that Agent, in front.
    var onAgentClicked: ((String) -> Void)?
    /// A click on any other notification: DevHub in front.
    var onClicked: (() -> Void)?
    private var authorized: Bool?

    /// `UNUserNotificationCenter` needs a bundle; a bare executable (a test,
    /// `swift run`) has no notifications.
    var isSupported: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }

    func install() {
        guard isSupported else { return }
        UNUserNotificationCenter.current().delegate = self
    }

    private func authorize(_ then: @escaping @MainActor @Sendable (Bool) -> Void) {
        if let authorized { then(authorized); return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            Task { @MainActor [weak self] in
                self?.authorized = granted
                then(granted)
            }
        }
    }

    func post(title: String, body: String, sound: Bool, agentId: String?) {
        guard isSupported else { return }
        authorize { granted in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            if sound { content.sound = UNNotificationSound(named: UNNotificationSoundName("Glass")) }
            if let agentId { content.userInfo = ["agentId": agentId] }
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request) { error in
                if let error { MainLog.shared.warn("[devhub] a notification could not be shown: \(error.localizedDescription)") }
            }
        }
    }

    /// `devhub --tell notify`: refused where this Mac shows none.
    func postTold(_ text: String) throws {
        guard isSupported else { throw DevhubFailure("this Mac does not show notifications.") }
        post(title: "DevHub", body: text, sound: false, agentId: nil)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let agentId = response.notification.request.content.userInfo["agentId"] as? String
        Task { @MainActor [weak self] in
            if let agentId { self?.onAgentClicked?(agentId) } else { self?.onClicked?() }
        }
        completionHandler()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

/// The text input sources, through the Text Input Sources API.
final class TISInputSources: InputSourcePort {
    struct Failure: Error, CustomStringConvertible {
        var description: String
    }

    private static func string(_ source: TISInputSource, _ key: CFString) -> String? {
        guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
        return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
    }

    private static func flag(_ source: TISInputSource, _ key: CFString) -> Bool {
        guard let pointer = TISGetInputSourceProperty(source, key) else { return false }
        return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(pointer).takeUnretainedValue())
    }

    func selectAscii() throws -> InputSourceSwitch? {
        guard let current = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else {
            throw Failure(description: "DevHub could not read the current input source.")
        }
        if Self.flag(current, kTISPropertyInputSourceIsASCIICapable) { return nil }
        guard let ascii = TISCopyCurrentASCIICapableKeyboardInputSource()?.takeRetainedValue() else {
            throw Failure(description: "DevHub could not find an ASCII-capable input source.")
        }
        let status = TISSelectInputSource(ascii)
        if status != noErr { throw Failure(description: "DevHub could not select the ASCII input source (\(status)).") }
        return InputSourceSwitch(
            previous: Self.string(current, kTISPropertyInputSourceID) ?? "",
            selected: Self.string(ascii, kTISPropertyInputSourceID) ?? "")
    }

    @discardableResult
    func restore(_ change: InputSourceSwitch) throws -> Bool {
        guard let current = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else { return false }
        // The person chose another source since: theirs stays.
        guard Self.string(current, kTISPropertyInputSourceID) == change.selected else { return false }
        let filter = [kTISPropertyInputSourceID as String: change.previous] as CFDictionary
        guard let list = TISCreateInputSourceList(filter, false)?.takeRetainedValue() as? [TISInputSource],
              let previous = list.first else { return false }
        let status = TISSelectInputSource(previous)
        if status != noErr { throw Failure(description: "DevHub could not restore the input source (\(status)).") }
        return true
    }
}
