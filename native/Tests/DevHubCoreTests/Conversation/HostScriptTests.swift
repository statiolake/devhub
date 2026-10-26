// The host scripts, byte for byte the TS app's.
//
// Fixtures/conversation/host-scripts.json is every export of
// apps/desktop/src/main/agent/conversation/hostScript.ts as Node evaluates
// the module (`node dump.mjs` over it, Node 24 stripping its types), so a
// host either app starts, follows, writes to or restarts is the other's.

import XCTest
@testable import DevHubCore

final class HostScriptTests: XCTestCase {
    func exported() throws -> JsonObject {
        try XCTUnwrap(try JsonValue.parse(Fixtures.text("conversation", "host-scripts.json")).objectValue)
    }

    func testEveryScriptIsTheTSAppsByteForByte() throws {
        let ts = try exported()
        let scripts: [(String, String)] = [
            ("HOST_SCRIPT", HOST_SCRIPT), ("STREAM_SCRIPT", STREAM_SCRIPT), ("WRITE_SCRIPT", WRITE_SCRIPT),
            ("RESTART_SCRIPT", RESTART_SCRIPT), ("SENT_LOG_SCRIPT", SENT_LOG_SCRIPT), ("ENDING_SCRIPT", ENDING_SCRIPT),
            ("HOST_NAME", HOST_NAME), ("STREAM_NAME", STREAM_NAME),
        ]
        for (name, script) in scripts {
            XCTAssertEqual(script, ts[name]?.stringValue, name)
        }
    }

    func testTheNumbersAreTheTSAppsToo() throws {
        let ts = try exported()
        XCTAssertEqual(ts["HOST_START_SECONDS"], .number(Double(HOST_START_SECONDS)))
        XCTAssertEqual(ts["STDERR_TAIL_BYTES"], .number(Double(STDERR_TAIL_BYTES)))
        XCTAssertEqual(
            ts["STREAM_EXIT"],
            [
                "hostOver": .number(Double(STREAM_EXIT.hostOver)), "notStarted": .number(Double(STREAM_EXIT.notStarted)),
                "stateMissing": .number(Double(STREAM_EXIT.stateMissing)), "truncated": .number(Double(STREAM_EXIT.truncated)),
                "tailStopped": .number(Double(STREAM_EXIT.tailStopped)),
            ])
        XCTAssertEqual(
            ts["WRITE_EXIT"],
            ["stateMissing": .number(Double(WRITE_EXIT.stateMissing)), "hostGone": .number(Double(WRITE_EXIT.hostGone))])
    }
}
