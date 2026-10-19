// swift-tools-version: 6.0
//
// speech-bench: measures Apple's on-device SpeechAnalyzer (macOS 26) for
// Japanese dictation, to compare against the whisper.cpp DevHub bundles.
// A standalone evaluation tool: not part of the app, the workspace or CI.
// See README.md.

import Foundation
import PackageDescription

// An Info.plist linked into the binary's __TEXT,__info_plist section, so the
// command-line tool carries the usage strings (microphone, speech
// recognition) that macOS looks for. See README.md, "Permissions".
let infoPlist = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .appendingPathComponent("Info.plist")
  .path

let package = Package(
  name: "speech-bench",
  platforms: [.macOS("26.0")],
  products: [
    .executable(name: "speech-bench", targets: ["speech-bench"])
  ],
  targets: [
    .executableTarget(
      name: "speech-bench",
      path: "Sources/speech-bench",
      swiftSettings: [
        // Swift 5 mode: the AVFoundation/Speech callbacks here are bridged by
        // hand with locks, and Swift 6's strict checking only adds noise.
        .swiftLanguageMode(.v5)
      ],
      linkerSettings: [
        .unsafeFlags([
          "-Xlinker", "-sectcreate",
          "-Xlinker", "__TEXT",
          "-Xlinker", "__info_plist",
          "-Xlinker", infoPlist,
        ])
      ]
    )
  ]
)
