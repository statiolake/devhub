#!/usr/bin/env python3
"""The parts of build_whisper.py that decide, without building anything.

What is pinned, what a cache entry is filed under, and when a directory counts
as a recogniser to bundle. The build itself runs only on a Mac; these run
anywhere.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import build_whisper as bw


class Pins(unittest.TestCase):
	def test_pins_a_full_commit_and_a_sha1(self) -> None:
		self.assertRegex(bw.WHISPER_CPP_COMMIT, r"^[0-9a-f]{40}$")
		for model in bw.MODELS.values():
			self.assertRegex(model.sha1, r"^[0-9a-f]{40}$")

	def test_installs_no_model_unless_told_to(self) -> None:
		self.assertEqual(bw.DEFAULT_MODEL, "ggml-small.bin")
		# whisper.cpp's models/README.md at v1.9.4.
		self.assertEqual(bw.MODELS["ggml-small.bin"].sha1, "55356645c2b361a969dfd0ef2c5a50d530afd8d5")
		self.assertIsNone(bw.chosen_model({}))
		self.assertEqual(
			bw.chosen_model({bw.MODEL_ENV: "ggml-large-v3-turbo-q5_0.bin"}), "ggml-large-v3-turbo-q5_0.bin"
		)
		with self.assertRaises(SystemExit):
			bw.chosen_model({bw.MODEL_ENV: "ggml-tiny.bin"})

	def test_reads_the_pins_the_app_downloads_by(self) -> None:
		product = json.loads(bw.PRODUCT_FILE.read_text())
		for pin in product["whisperModels"].values():
			self.assertEqual(bw.MODELS[pin["file"]].sha1, pin["sha1"])
			self.assertEqual(bw.model_url(pin["file"]), pin["url"])
		self.assertIn("ggml-large-v3-turbo-q5_0.bin", bw.MODELS)

	def test_cannot_fetch_anything_at_runtime(self) -> None:
		self.assertIn("-DWHISPER_CURL=OFF", bw.CMAKE_FLAGS)

	def test_builds_the_server_for_streaming_dictation(self) -> None:
		self.assertIn("-DWHISPER_BUILD_SERVER=ON", bw.CMAKE_FLAGS)
		self.assertIn(("whisper-server", bw.SERVER_BINARY), bw.PROGRAMS)

	def test_is_one_portable_file(self) -> None:
		self.assertIn("-DBUILD_SHARED_LIBS=OFF", bw.CMAKE_FLAGS)
		self.assertIn("-DGGML_METAL_EMBED_LIBRARY=ON", bw.CMAKE_FLAGS)
		self.assertIn("-DGGML_NATIVE=OFF", bw.CMAKE_FLAGS)


class BinaryKey(unittest.TestCase):
	def test_changes_with_the_commit_and_the_flags(self) -> None:
		base = bw.binary_key()
		self.assertEqual(base, bw.binary_key())
		self.assertNotEqual(base, bw.binary_key(commit="0" * 40))
		self.assertNotEqual(base, bw.binary_key(flags=bw.CMAKE_FLAGS + ("-DX=1",)))


class ForeignLibraries(unittest.TestCase):
	def test_accepts_only_what_macos_ships(self) -> None:
		output = (
			"build/bin/whisper-cli:\n"
			"\t/System/Library/Frameworks/Metal.framework/Versions/A/Metal (compatibility version 1.0.0)\n"
			"\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0)\n"
			"\t/opt/homebrew/opt/libomp/lib/libomp.dylib (compatibility version 5.0.0)\n"
			"\t@rpath/libggml.dylib (compatibility version 0.0.0)\n"
		)
		self.assertEqual(
			bw.foreign_libraries(output),
			["/opt/homebrew/opt/libomp/lib/libomp.dylib", "@rpath/libggml.dylib"],
		)


class InstallProblems(unittest.TestCase):
	def setUp(self) -> None:
		self.dir = Path(tempfile.mkdtemp())
		binary = self.dir / bw.BINARY
		binary.write_bytes(b"#!/bin/sh\n")
		binary.chmod(0o755)
		server = self.dir / bw.SERVER_BINARY
		server.write_bytes(b"#!/bin/sh\n# server\n")
		server.chmod(0o755)
		(self.dir / bw.LICENSE).write_text("MIT")
		self.write(bw.statement(bw.hash_file(binary, "sha256"), bw.hash_file(server, "sha256")))

	def write(self, said: dict) -> None:
		(self.dir / bw.STATEMENT).write_text(json.dumps(said))

	def test_accepts_what_install_writes(self) -> None:
		self.assertEqual(bw.install_problems(self.dir), [])

	def test_states_no_model(self) -> None:
		said = json.loads((self.dir / bw.STATEMENT).read_text())
		self.assertNotIn("model", said)

	def test_refuses_a_statement_from_when_the_model_was_bundled(self) -> None:
		said = json.loads((self.dir / bw.STATEMENT).read_text())
		self.write({**said, "model": "ggml-small.bin"})
		self.assertIn("names a model", bw.install_problems(self.dir)[0])

	def test_refuses_a_binary_that_changed(self) -> None:
		(self.dir / bw.BINARY).write_bytes(b"#!/bin/sh\n# other\n")
		self.assertEqual(len(bw.install_problems(self.dir)), 1)
		self.assertEqual(bw.install_problems(self.dir, deep=False), [])

	def test_refuses_another_commit(self) -> None:
		said = json.loads((self.dir / bw.STATEMENT).read_text())
		self.write({**said, "commit": "0" * 40})
		self.assertIn("built from", bw.install_problems(self.dir)[0])

	def test_refuses_a_directory_with_no_statement(self) -> None:
		(self.dir / bw.STATEMENT).unlink()
		self.assertEqual(len(bw.install_problems(self.dir)), 1)

	def test_refuses_a_binary_that_cannot_run(self) -> None:
		(self.dir / bw.BINARY).chmod(0o644)
		self.assertIn("not executable", bw.install_problems(self.dir)[0])

	def test_refuses_a_directory_without_the_server(self) -> None:
		(self.dir / bw.SERVER_BINARY).unlink()
		self.assertIn(bw.SERVER_BINARY, bw.install_problems(self.dir)[0])

	def test_ignores_a_development_model_unless_asked_about_it(self) -> None:
		(self.dir / bw.DEFAULT_MODEL).write_bytes(b"model")
		self.assertEqual(bw.install_problems(self.dir), [])
		self.assertIn("too small", bw.install_problems(self.dir, model=bw.DEFAULT_MODEL)[0])

	def test_bundles_the_programs_and_never_a_model(self) -> None:
		(self.dir / bw.DEFAULT_MODEL).write_bytes(b"model")
		(self.dir / "ggml-large-v3-turbo-q5_0.bin.part").write_bytes(b"part")
		self.assertEqual(
			[path.name for path in bw.bundled_files(self.dir)],
			sorted([bw.BINARY, bw.SERVER_BINARY, bw.LICENSE, bw.STATEMENT]),
		)


class ModelProblem(unittest.TestCase):
	def test_refuses_a_file_too_small_to_be_the_model(self) -> None:
		with tempfile.NamedTemporaryFile() as handle:
			self.assertIn("too small", bw.model_problem(Path(handle.name)) or "")


if __name__ == "__main__":
	unittest.main()
