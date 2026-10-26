import DevHubCore
import Foundation

// The `devhub` command (port of apps/desktop/src/main/cli/devhubCliEntry.ts).
//
// Thin on purpose: the parser, the control-socket client, the cold start and
// `--wait` are `DevhubCommandLine` in DevHubCore, where they are tested. It
// speaks the TypeScript app's control protocol (one JSON object per line over
// `<userData>/devhub/control.sock`), so either app answers either CLI.

#if canImport(Glibc)
    import Glibc
#elseif canImport(Darwin)
    import Darwin
#endif

// A write to a socket whose peer has gone is an error, not the end of us.
signal(SIGPIPE, SIG_IGN)

let status = await DevhubCommandLine.run(Array(CommandLine.arguments.dropFirst()), io: ProcessDevhubIO())
exit(status)
