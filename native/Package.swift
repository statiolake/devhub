// swift-tools-version:6.0
//
// DevHub, native: a macOS app written in Swift, with no TypeScript, no
// JavaScript and no web views. See docs/PLAN.md.
//
// Three products:
//
//   DevHubCore  Foundation only. Model, coordinator, config, persistence, tmux,
//               git/gh, the conversation protocols, the Neovim client, the
//               control-socket protocol. Builds and is tested on Linux too.
//   devhub      The command-line client (`devhub <file>`, `devhub --tell ...`).
//               Foundation only; builds on Linux.
//   DevHubApp   The AppKit/SwiftUI application. macOS only: the target is not
//               even declared on other platforms, so `swift build` on Linux
//               builds Core + CLI and resolves no UI dependencies.

import PackageDescription

var products: [Product] = [
    .library(name: "DevHubCore", targets: ["DevHubCore"]),
    .executable(name: "devhub", targets: ["DevHubCLI"]),
]

var dependencies: [Package.Dependency] = []

var targets: [Target] = [
    .target(
        name: "DevHubCore",
        path: "Sources/DevHubCore",
        // VS Code's built-in colour themes (MIT), vendored: WP8, Theme/.
        // Shiki's TextMate grammars and Light+/Dark+ (MIT), vendored: WP10, Markdown/.
        resources: [.copy("Theme/BuiltinThemes"), .copy("Markdown/Grammars")]
    ),
    .executableTarget(
        name: "DevHubCLI",
        dependencies: ["DevHubCore"],
        path: "Sources/DevHubCLI"
    ),
    .testTarget(
        name: "DevHubCoreTests",
        dependencies: ["DevHubCore"],
        path: "Tests/DevHubCoreTests",
        // Fixtures captured from the TS app, read by path (#filePath).
        exclude: ["Fixtures"]
    ),
]

#if os(macOS)
// The UI's dependencies are pure Swift, MIT/Apache, fetched from GitHub.
//  - SwiftTerm (MIT): the terminal surface (xterm emulation + AppKit view).
//    libghostty is a possible later swap behind the same TerminalSurface
//    protocol (docs/PLAN.md, "Terminal surface").
dependencies += [
    .package(url: "https://github.com/migueldeicaza/SwiftTerm", .upToNextMinor(from: "1.20.0")),
]
products += [
    .executable(name: "DevHubApp", targets: ["DevHubApp"]),
]
targets += [
    .executableTarget(
        name: "DevHubApp",
        dependencies: [
            "DevHubCore",
            .product(name: "SwiftTerm", package: "SwiftTerm"),
        ],
        path: "Sources/DevHubApp"
    ),
]
#endif

let package = Package(
    name: "DevHub",
    platforms: [.macOS(.v14)],
    products: products,
    dependencies: dependencies,
    targets: targets,
    swiftLanguageModes: [.v6]
)
