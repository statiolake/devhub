import hashlib
import sys
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import tmux_feasibility as harness  # noqa: E402


class TmuxHarnessUnitTests(unittest.TestCase):
    def test_workspace_name_uses_first_twenty_hex_digest(self) -> None:
        root = "/tmp/example-workspace"
        digest = hashlib.sha256(root.encode()).hexdigest()
        self.assertRegex("ws-" + digest[:20], r"^ws-[0-9a-f]{20}$")
        self.assertEqual(len("ws-" + digest[:20]), 23)

    def test_marker_and_socket_are_explicit(self) -> None:
        self.assertEqual(harness.SOCKET, "devhub")
        self.assertEqual(harness.PROTOCOL_MARKER, "1")

    def test_diagnostics_redact_content_like_values(self) -> None:
        value = f"token=secret-value user@example.test {Path.home()}/private"
        result = harness.sanitize(value)
        self.assertNotIn("secret-value", result)
        self.assertNotIn("user@example.test", result)
        self.assertNotIn(str(Path.home()), result)


if __name__ == "__main__":
    unittest.main()
