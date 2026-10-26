// Port of main/shell/menu.ts: the menu bar. Deliberately no accelerators but
// what the system draws itself: every DevHub command is a Cmd+Q chord, so a
// shortcut here would take a key from the terminal or the composer. The Edit
// items carry the Mac's keys only as the way they are reached in somebody
// else's window (an alert's field); on DevHub's own views the chord
// dispatcher performs them first (`editingCommands.ts`).

import AppKit
import DevHubCore

@MainActor
protocol MenuHost: AnyObject {
    /// The Workspace File ▸ Close names, if one other than Scratch is selected.
    func menuSelectedWorkspace() -> (id: String, label: String)?
    func menuCloseWorkspace(_ workspaceId: String)
    func menuOpenWorkspacePicker()
    func menuOpenSettings()
    func menuRestart()
    func menuInstallCli()
}

@MainActor
final class MainMenu: NSObject, NSMenuDelegate {
    weak var host: MenuHost?
    private let closeWorkspaceItem = NSMenuItem(title: "Close Workspace", action: #selector(closeWorkspace), keyEquivalent: "")

    func build() -> NSMenu {
        let main = NSMenu()
        main.addItem(submenu(appMenu()))
        main.addItem(submenu(fileMenu()))
        main.addItem(submenu(editMenu()))
        main.addItem(submenu(viewMenu()))
        let window = windowMenu()
        main.addItem(submenu(window))
        NSApp.windowsMenu = window
        let help = helpMenu()
        main.addItem(submenu(help))
        NSApp.helpMenu = help
        return main
    }

    private func submenu(_ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }

    private func item(_ title: String, _ action: Selector?, target: AnyObject? = nil, key: String = "", modifiers: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = target
        return item
    }

    private func appMenu() -> NSMenu {
        let menu = NSMenu(title: "DevHub")
        menu.addItem(item("About DevHub", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
        // The permanent items: Settings… and the CLI.
        menu.addItem(.separator())
        menu.addItem(item("Settings…", #selector(openSettings), target: self))
        menu.addItem(item("Install ‘devhub’ Command…", #selector(installCli), target: self))
        menu.addItem(.separator())
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "Services")
        services.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        menu.addItem(services)
        menu.addItem(.separator())
        menu.addItem(item("Hide DevHub", #selector(NSApplication.hide(_:))))
        menu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:))))
        menu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Restart DevHub", #selector(restart), target: self))
        // Quit has no key equivalent: Cmd+Q is DevHub's chord prefix and
        // Cmd+Q Cmd+Q quits (`forward_prefix`).
        menu.addItem(item("Quit DevHub", #selector(NSApplication.terminate(_:))))
        return menu
    }

    private func fileMenu() -> NSMenu {
        let menu = NSMenu(title: "File")
        menu.delegate = self
        menu.addItem(item("Add Workspace…", #selector(openWorkspacePicker), target: self))
        menu.addItem(.separator())
        closeWorkspaceItem.target = self
        menu.addItem(closeWorkspaceItem)
        menu.addItem(item("Close Window", #selector(NSWindow.performClose(_:))))
        return menu
    }

    private func editMenu() -> NSMenu {
        let menu = NSMenu(title: "Edit")
        for (index, group) in ShellKeys.editingGroups.enumerated() {
            if index > 0 { menu.addItem(.separator()) }
            for command in group {
                let entry: (String, Selector)
                switch command.role {
                case .undo: entry = ("Undo", Selector(("undo:")))
                case .redo: entry = ("Redo", Selector(("redo:")))
                case .cut: entry = ("Cut", #selector(NSText.cut(_:)))
                case .copy: entry = ("Copy", #selector(NSText.copy(_:)))
                case .paste: entry = ("Paste", #selector(NSText.paste(_:)))
                case .pasteAndMatchStyle: entry = ("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)))
                case .delete: entry = ("Delete", #selector(NSText.delete(_:)))
                case .selectAll: entry = ("Select All", #selector(NSText.selectAll(_:)))
                }
                menu.addItem(item(
                    entry.0, entry.1, key: command.key ?? "", modifiers: command.shift ? [.command, .shift] : [.command]))
            }
        }
        return menu
    }

    private func viewMenu() -> NSMenu {
        let menu = NSMenu(title: "View")
        menu.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), key: "f", modifiers: [.command, .control]))
        return menu
    }

    private func windowMenu() -> NSMenu {
        let menu = NSMenu(title: "Window")
        menu.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:))))
        menu.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))))
        return menu
    }

    private func helpMenu() -> NSMenu {
        let menu = NSMenu(title: "Help")
        menu.addItem(item("DevHub Help", #selector(openHelp), target: self))
        return menu
    }

    // MARK: Actions

    func menuNeedsUpdate(_ menu: NSMenu) {
        // `Close “<label>”`, and disabled with nothing to close.
        if let workspace = host?.menuSelectedWorkspace() {
            closeWorkspaceItem.title = "Close “\(workspace.label)”"
            closeWorkspaceItem.isEnabled = true
        } else {
            closeWorkspaceItem.title = "Close Workspace"
            closeWorkspaceItem.isEnabled = false
        }
    }

    @objc private func closeWorkspace() {
        if let workspace = host?.menuSelectedWorkspace() { host?.menuCloseWorkspace(workspace.id) }
    }

    @objc private func openWorkspacePicker() { host?.menuOpenWorkspacePicker() }
    @objc private func openSettings() { host?.menuOpenSettings() }
    @objc private func restart() { host?.menuRestart() }
    @objc private func installCli() { host?.menuInstallCli() }

    @objc private func openHelp() {
        if let url = URL(string: "https://github.com/statiolake/devhub#readme") { NSWorkspace.shared.open(url) }
    }
}

extension MainMenu: NSMenuItemValidation {
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem === closeWorkspaceItem { return host?.menuSelectedWorkspace() != nil }
        return true
    }
}
