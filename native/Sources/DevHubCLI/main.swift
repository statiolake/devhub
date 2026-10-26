import DevHubCore
import Foundation

// The `devhub` command. Phase 0: `--version` and `--help` only. The full
// command line (`devhub <file>`, `-g`, `-w`, `-`, `--agent`, `--tell ...`) is
// work package WP7 in docs/PLAN.md; it speaks the TypeScript app's control
// protocol (one JSON object per line over `<userData>/devhub/control.sock`),
// so either app answers either CLI.

let arguments = Array(CommandLine.arguments.dropFirst())

func printUsage() {
    print("""
    Usage: devhub [options] [<path>...]

      --version        print the version
      -h, --help       print this help

    The rest of the command line is not implemented in the native build yet.
    """)
}

switch arguments.first {
case "--version", "-v":
    print(DevHubVersion.description)
case "--help", "-h":
    printUsage()
default:
    FileHandle.standardError.write(Data("devhub: not implemented in the native build yet: \(arguments.joined(separator: " "))\n".utf8))
    exit(2)
}
