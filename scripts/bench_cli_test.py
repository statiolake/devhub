#!/usr/bin/env python3
"""bench_cli.py reads the trace line `cli/trace.go` writes.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import unittest

from bench_cli import parse_trace, stages_of, summarise


class Trace(unittest.TestCase):
	def test_reads_the_marks(self) -> None:
		marks = parse_trace("devhub: something\ndevhub-trace: connected=0.10 written=0.12 answered=2.50 exit=2.60\n")
		self.assertEqual(marks, {"connected": 0.10, "written": 0.12, "answered": 2.50, "exit": 2.60})

	def test_no_trace_is_no_marks(self) -> None:
		self.assertEqual(parse_trace("devhub: DevHub is not running.\n"), {})
		self.assertEqual(stages_of(5.0, {}), {})

	def test_stages_of_one_request(self) -> None:
		stages = stages_of(4.0, {"connected": 0.5, "written": 0.6, "answered": 2.6, "exit": 3.0})
		self.assertAlmostEqual(stages["start"], 1.0)
		self.assertAlmostEqual(stages["dial"], 0.5)
		self.assertAlmostEqual(stages["app"], 2.0)
		self.assertAlmostEqual(stages["print"], 0.4)
		self.assertNotIn("again", stages)

	def test_a_second_request_is_its_own_stage(self) -> None:
		stages = stages_of(
			10.0,
			{"connected": 0.5, "written": 0.6, "answered": 2.6, "written#2": 2.7, "answered#2": 5.7, "exit": 6.0},
		)
		self.assertAlmostEqual(stages["again"], 3.0)
		self.assertAlmostEqual(stages["print"], 0.3)

	def test_summary_is_first_median_min_and_stage_medians(self) -> None:
		summary = summarise([9.0, 3.0, 4.0], [{"app": 1.0}, {"app": 3.0}, {"app": 2.0}])
		self.assertEqual(summary["first"], 9.0)
		self.assertEqual(summary["median"], 4.0)
		self.assertEqual(summary["min"], 3.0)
		self.assertEqual(summary["app"], 2.0)


if __name__ == "__main__":
	unittest.main()
