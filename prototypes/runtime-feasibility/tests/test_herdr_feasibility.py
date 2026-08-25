import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import herdr_feasibility as harness  # noqa: E402


class HerdrHarnessUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.probe = harness.HerdrProbe.__new__(harness.HerdrProbe)

    def test_profile_gate_accepts_only_codex_and_claude(self) -> None:
        self.assertEqual(
            self.probe.validate_profile({"id": "codex", "kind": "codex", "args": [], "env": {}}),
            (True, "ok"),
        )
        self.assertEqual(
            self.probe.validate_profile({"id": "shell", "kind": "bash", "args": [], "env": {}})[0],
            False,
        )
        self.assertEqual(
            self.probe.validate_profile({"id": "bad", "kind": "claude", "args": [], "env": {"BAD-NAME": "x"}})[0],
            False,
        )

    def test_schema_capability_walk_is_recursive(self) -> None:
        names = self.probe.schema_method_names({"one": {"const": "events.subscribe"}, "many": [{"const": "agent.start"}]})
        self.assertEqual(names, {"events.subscribe", "agent.start"})

    def test_subscription_event_kinds_drop_terminal_payload(self) -> None:
        events = [
            {"event": "workspace_created", "data": {"type": "workspace_created", "workspace": {"workspace_id": "w2"}}},
            {"event": "pane_created", "data": {"type": "pane_created", "pane": {"pane_id": "w2:p1"}}},
        ]
        self.assertEqual(harness.event_kinds(events), ["workspace_created", "pane_created"])

    def test_diagnostics_are_content_free(self) -> None:
        home_path = f"{Path.home()}/private"
        result = harness.sanitize(f"token=secret user@example.test {home_path}")
        self.assertNotIn("secret", result)
        self.assertNotIn("user@example.test", result)
        self.assertNotIn(str(Path.home()), result)

    def test_auth_status_reduces_logged_out_payload(self) -> None:
        result = harness.auth_state_from_status(
            {"loggedIn": False, "apiProvider": "firstParty", "authMethod": "none", "token": "secret"}
        )
        self.assertEqual(result["state"], "unauthenticated")
        self.assertFalse(result["logged_in"])
        self.assertNotIn("token", result)

    def test_auth_status_unknown_payload_does_not_claim_auth(self) -> None:
        result = harness.auth_state_from_status({"message": "not a status"})
        self.assertEqual(result["state"], "unknown")
        self.assertIsNone(result["logged_in"])

    def test_process_observation_keeps_only_structural_fields(self) -> None:
        result = harness.process_observation(
            "claude",
            {
                "id": "x",
                "result": {
                    "process_info": {
                        "shell_pid": 10,
                        "foreground_process_group_id": 11,
                        "foreground_processes": [
                            {"name": "claude", "argv0": "/tmp/claude", "cmdline": "claude"}
                        ],
                    }
                },
            },
        )
        self.assertTrue(result["provider_process_present"])
        self.assertEqual(result["foreground_process_count"], 1)
        self.assertNotIn("cmdline", result)

    def test_status_summary_is_blocked_when_raw_substatus_is_blocked(self) -> None:
        result = harness.summarize_statuses(
            [{"id": "ok", "status": "pass"}, {"id": "claude-natural", "status": "blocked"}]
        )
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["hard_gate_blockers"], ["claude-natural"])

    def test_status_summary_keeps_nonblocking_provider_debt(self) -> None:
        result = harness.summarize_statuses(
            [{"id": "codex-natural", "status": "pass"}, {"id": "claude-natural", "status": "blocked", "blocks_release": False}]
        )
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["acceptance_debt"], ["claude-natural"])

    def test_status_summary_fails_before_blocked(self) -> None:
        result = harness.summarize_statuses(
            [{"id": "blocked", "status": "blocked"}, {"id": "failed", "status": "fail"}]
        )
        self.assertEqual(result["status"], "fail")


if __name__ == "__main__":
    unittest.main()
