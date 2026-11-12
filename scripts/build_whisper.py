#!/usr/bin/env python3
"""Build the speech recogniser DevHub carries.

The GUI Agent composer takes dictation (`docs/agent-gui.md`, "Voice input").
What is said never leaves the Mac: there is no service to send it to. The
recogniser's programs are in the bundle, put there by this script at build
time:

    DevHub.app/Contents/Resources/whisper/
      devhub-whisper                 whisper.cpp's `whisper-cli`, renamed
      devhub-whisper-server          whisper.cpp's `whisper-server`, renamed
      whisper.json                   the statement: which build, and hashes
      LICENSE-whisper.cpp            MIT, travels with the binary

The model is not. Voice input is off until the person turns it on, and the
model it reads (466 MiB, most of what the bundle used to weigh) is downloaded
then, once, after they agree — from the URL and checked against the hash
`apps/desktop/product.json` pins (`whisperModels`), by the app
(`src/main/voice/voiceSetup.ts`). This script reads the same pins.

For working on DevHub itself, `--model NAME` (or `DEVHUB_WHISPER_MODEL`)
also puts a model in the output directory, downloaded and verified the same
way: a source run (or `DEVHUB_WHISPER_DIR`) with a model beside the programs
uses it and downloads nothing. Packaging never takes one into the bundle.

## Why whisper.cpp

It is the one implementation of Whisper that is a single native executable on
Apple Silicon with nothing to install beside it: Metal for the GPU, Accelerate
for the CPU, no Python, no ONNX runtime, no Core ML model to compile on first
use. MLX-based ports are as fast or faster on the GPU, but they are Python
packages, and a Python in the bundle is two hundred megabytes of runtime for
one feature. Core ML (`WHISPER_COREML`) speeds up the encoder further, but it
needs a second, separately converted model next to the ggml one and a first
run that compiles it for the device — minutes, in front of the person, the
first time they press the button. Metal alone is fast enough that this is not
worth it (see the model, below).

It is run as a program, not loaded as a Node addon. An addon would have to be
built against Electron's ABI and rebuilt with every Electron bump, and a crash
in it — a Metal driver fault, an out-of-memory on a long recording — would take
DevHub's main process with it. A child process per recording costs a model
load (the file is mmapped, so after the first recording that is the page cache
and well under a second) and dies alone.

Two programs from the one build. `devhub-whisper-server` is what dictation
uses: it loads the model once and keeps it in GPU memory, so the composer can
transcribe the utterance being spoken about once a second and show the words
as they come (`main/voice/whisperServer.ts`). It
listens on 127.0.0.1 only, on a port and under a random path main chooses,
and is stopped when dictation has been idle a while. `devhub-whisper` (the
CLI) is the fallback for a directory built before the server was: final text
only, on stop.

## Why small, in f16

The composer is for Japanese and English, often mixed in one sentence, and
full of identifiers. Dictation streams: the phrase being spoken is
transcribed again while it is spoken, and each phrase once more when the
speaker pauses (`main/voice/dictationStream.ts`), so the recogniser runs
several times a second-of-speech and its cost is the feature's cost. The
model was `large-v3-turbo` (q5_0, 547 MiB) for its Japanese; it was too heavy
to run that often beside everything else on the Mac — fans, a busy GPU, and
words that lag. `small` (244 M parameters, 12 decoder layers, against turbo's
809 M with a 32-layer encoder) is several times cheaper per pass, and the
author's podcast-maker, which transcribes Japanese with `small` resident and
one greedy pass per utterance, showed its quality is decent for this: what
it gets wrong is mostly homophones the person reads and fixes before sending.

f16 (`ggml-small.bin`, 466 MiB) rather than a quantised file: it is the one
`small` whisper.cpp publishes a hash for (models/README.md lists no hash for
`ggml-small-q8_0.bin` or `-q5_1`, and this script takes nothing it cannot
verify against upstream), it is exactly what podcast-maker runs, and on
Metal a quantised model this size is not clearly faster: its encoder is
bound by compute rather than by reading weights, and the quantised kernels
dequantise as they go. q8_0 would save ~200 MiB of download; that
is not worth an unverifiable file and a model whose quality was never judged.

`large-v3-turbo` stays selectable for a person who wants its accuracy and
has the GPU for it: Settings → General → 音声入力 → モデル downloads it the
same way (and `--model ggml-large-v3-turbo-q5_0.bin` puts it in a
development directory).

## Pinned, verified, cached

whisper.cpp is pinned by tag *and* commit, and the clone is refused if the tag
does not name that commit. A model is pinned in `product.json` by the SHA-1
whisper.cpp's own `models/README.md` publishes for it (the only hash upstream
publishes; a pin may state a sha256 too), and a download that does not hash
to it is deleted, not used.

Both are cached under `~/.cache/devhub/whisper/` (`$XDG_CACHE_HOME`,
`DEVHUB_WHISPER_CACHE` overrides): a model by its name, the binary by a key
over the commit and the build flags. A second build is a copy.

    scripts/build_whisper.py [--out-dir dist/whisper] [--no-cache] [--model NAME]

This builds for the machine it runs on and only on macOS on Apple Silicon:
the binary is for the bundle, and Metal is the point. `--check DIR` says what
is wrong with an already-built directory, without building, on any machine.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = REPO_ROOT / "dist" / "whisper"

WHISPER_CPP_REPOSITORY = "https://github.com/ggml-org/whisper.cpp"
WHISPER_CPP_VERSION = "v1.9.4"
WHISPER_CPP_COMMIT = "927cfce34f31707e17f2bff35c349632fb9e2c3a"


class Model(NamedTuple):
	# Pinned in apps/desktop/product.json (`whisperModels`), from whisper.cpp's
	# models/README.md at the pinned tag.
	sha1: str
	# The size upstream lists, for what is said while downloading.
	size: str
	# Anything far below the listed size is not this model.
	min_bytes: int
	url: str
	sha256: str | None = None


PRODUCT_FILE = REPO_ROOT / "apps" / "desktop" / "product.json"


def pinned_models(product: dict | None = None) -> dict[str, Model]:
	"""The models product.json pins, by file name: the app's pins, read here too."""
	product = json.loads(PRODUCT_FILE.read_text()) if product is None else product
	return {
		pin["file"]: Model(pin["sha1"], pin["size"], pin["minBytes"], pin["url"], pin.get("sha256"))
		for pin in product["whisperModels"].values()
	}


MODELS: dict[str, Model] = pinned_models()
# What the app downloads unless told otherwise (`[voice] model = "small"`).
DEFAULT_MODEL = "ggml-small.bin"
MODEL_ENV = "DEVHUB_WHISPER_MODEL"


def model_url(model: str) -> str:
	return MODELS[model].url


def chosen_model(env: dict[str, str] | None = None) -> str | None:
	"""The development model to install: `DEVHUB_WHISPER_MODEL` when it names one
	of MODELS; None — no model, the default — when it names nothing."""
	named = (os.environ if env is None else env).get(MODEL_ENV, "")
	if not named:
		return None
	if named not in MODELS:
		fail(f"{MODEL_ENV}={named} is not one of {', '.join(MODELS)}")
	return named

BINARY = "devhub-whisper"
SERVER_BINARY = "devhub-whisper-server"
# (cmake target, installed name)
PROGRAMS = (("whisper-cli", BINARY), ("whisper-server", SERVER_BINARY))
STATEMENT = "whisper.json"
LICENSE = "LICENSE-whisper.cpp"

# Static libraries, so the binary is one file; the Metal shaders compiled into
# it (EMBED_LIBRARY), so it does not look for a `.metal` file beside itself;
# not -march=native, so a build on an M3 still runs on an M1. No libcurl: the
# program cannot fetch anything, which is the property this feature promises.
CMAKE_FLAGS = (
	"-DCMAKE_BUILD_TYPE=Release",
	"-DBUILD_SHARED_LIBS=OFF",
	"-DGGML_METAL=ON",
	"-DGGML_METAL_EMBED_LIBRARY=ON",
	"-DGGML_NATIVE=OFF",
	"-DGGML_BLAS=ON",
	"-DWHISPER_CURL=OFF",
	"-DWHISPER_SDL2=OFF",
	"-DWHISPER_BUILD_TESTS=OFF",
	"-DWHISPER_BUILD_SERVER=ON",
	"-DWHISPER_BUILD_EXAMPLES=ON",
	"-DCMAKE_OSX_ARCHITECTURES=arm64",
	"-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0",
)

# Bump when the meaning of the binary key changes without its inputs changing.
KEY_VERSION = "2"


# --- pure ---------------------------------------------------------------------


def binary_key(commit: str = WHISPER_CPP_COMMIT, flags: tuple[str, ...] = CMAKE_FLAGS) -> str:
	"""What a cached binary is filed under: the source and how it was built."""
	h = hashlib.sha256()
	for part in (f"key-version:{KEY_VERSION}", f"commit:{commit}", *flags):
		h.update(part.encode() + b"\0")
	return h.hexdigest()[:16]


def statement(binary_sha256: str, server_sha256: str = "") -> dict[str, str]:
	"""What `whisper.json` says, and what `install_problems` holds a directory to.

	The programs only: the model is not part of what is bundled."""
	return {
		"engine": "whisper.cpp",
		"version": WHISPER_CPP_VERSION,
		"commit": WHISPER_CPP_COMMIT,
		"binary": BINARY,
		"binarySha256": binary_sha256,
		"serverBinary": SERVER_BINARY,
		"serverSha256": server_sha256,
	}


def hash_file(path: Path, algorithm: str) -> str:
	digest = hashlib.new(algorithm)
	with path.open("rb") as handle:
		while chunk := handle.read(1 << 20):
			digest.update(chunk)
	return digest.hexdigest()


def model_problem(path: Path, model: str = DEFAULT_MODEL) -> str | None:
	"""Why `path` is not the pinned `model`, or None when it is."""
	if not path.is_file():
		return f"{path} is missing"
	if path.stat().st_size < MODELS[model].min_bytes:
		return f"{path} is {path.stat().st_size} bytes, too small to be {model}"
	if hash_file(path, "sha1") != MODELS[model].sha1:
		return f"{path} does not hash to the SHA-1 whisper.cpp publishes for {model}"
	sha256 = MODELS[model].sha256
	if sha256 is not None and hash_file(path, "sha256") != sha256:
		return f"{path} does not hash to the sha256 product.json pins for {model}"
	return None


def install_problems(directory: Path, *, deep: bool = True, model: str | None = None) -> list[str]:
	"""Why `directory` is not a recogniser to bundle; empty when it is.

	`deep` re-hashes the programs against the statement. Packaging asks for
	it: a half-copied binary is a recogniser that fails on first use. A model
	in the directory is not looked at (packaging leaves it out) unless `model`
	names one the directory should have for development, which is then checked
	against its pin.
	"""
	try:
		said = json.loads((directory / STATEMENT).read_text())
	except (OSError, ValueError):
		return [f"no readable {directory / STATEMENT}"]
	problems = []
	if said.get("commit") != WHISPER_CPP_COMMIT:
		problems.append(f"built from {said.get('commit')}, not {WHISPER_CPP_COMMIT} ({WHISPER_CPP_VERSION})")
	if "model" in said:
		# Written when the model was bundled: install again for a statement
		# that says what the bundle now carries.
		problems.append(f"{directory / STATEMENT} names a model, from when the model was bundled")
	for name, key in ((BINARY, "binarySha256"), (SERVER_BINARY, "serverSha256")):
		binary = directory / name
		if not binary.is_file() or not os.access(binary, os.X_OK):
			problems.append(f"{binary} is missing or not executable")
		elif deep and hash_file(binary, "sha256") != said.get(key):
			problems.append(f"{binary} does not hash to its statement")
	if model is not None:
		path = directory / model
		problem = model_problem(path, model) if deep else (None if path.is_file() else f"{path} is missing")
		if problem is not None:
			problems.append(problem)
	return problems


def bundled_files(directory: Path) -> list[Path]:
	"""What of `directory` goes into the app: everything but a model or a part.

	A development model (`--model`) stays where it is, for source runs."""
	return sorted(
		path
		for path in directory.iterdir()
		if path.is_file() and not path.name.endswith((".bin", ".part"))
	)


def foreign_libraries(otool_output: str) -> list[str]:
	"""The dylibs `otool -L` lists that a stock macOS does not have.

	A Homebrew libomp or libggml linked in by accident is a binary that runs on
	the Mac that built it and nowhere else, so packaging refuses it.
	"""
	found = []
	for line in otool_output.splitlines()[1:]:
		library = line.strip().split(" ", 1)[0]
		if library and not library.startswith(("/usr/lib/", "/System/Library/")):
			found.append(library)
	return found


# --- caches -------------------------------------------------------------------


def cache_root() -> Path:
	override = os.environ.get("DEVHUB_WHISPER_CACHE")
	if override:
		return Path(override)
	xdg = os.environ.get("XDG_CACHE_HOME")
	return (Path(xdg) if xdg else Path.home() / ".cache") / "devhub" / "whisper"


def say(message: str) -> None:
	print(f"==> {message}", file=sys.stderr, flush=True)


def fail(message: str) -> "None":
	print(f"\nbuild_whisper.py: {message}", file=sys.stderr)
	raise SystemExit(1)


def ensure_model(root: Path, *, use_cache: bool = True, model: str = DEFAULT_MODEL) -> Path:
	"""The pinned model in the cache, downloaded and verified if it is not.

	For development only (`--model`): no build of the app needs a model.
	"""
	target = root / "models" / model
	if use_cache and target.is_file():
		problem = model_problem(target, model)
		if problem is None:
			return target
		say(f"cached model unusable ({problem}); downloading again")
		target.unlink()
	target.parent.mkdir(parents=True, exist_ok=True)
	partial = target.with_suffix(".part")
	url = model_url(model)
	say(f"downloading {model} (~{MODELS[model].size}) from {url}")
	try:
		with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as out:
			shutil.copyfileobj(response, out, 1 << 20)
	except OSError as error:
		partial.unlink(missing_ok=True)
		fail(f"could not download {model}: {error}")
	problem = model_problem(partial, model)
	if problem is not None:
		partial.unlink(missing_ok=True)
		fail(problem)
	partial.replace(target)
	return target


def ensure_binary(root: Path, *, use_cache: bool = True) -> Path:
	"""whisper-cli and whisper-server for this commit and these flags, from the
	cache or built. Returns the directory holding both (as BINARY, SERVER_BINARY)."""
	key = binary_key()
	cached_dir = root / "bin" / key
	if use_cache and all(
		(cached_dir / name).is_file() and os.access(cached_dir / name, os.X_OK) for _, name in PROGRAMS
	):
		return cached_dir
	for tool in ("git", "cmake"):
		if shutil.which(tool) is None:
			fail(f"{tool} is missing; whisper.cpp needs it to build. Install it with: brew install {tool}")
	say(f"building whisper.cpp {WHISPER_CPP_VERSION} with Metal (a few minutes, once)")
	with tempfile.TemporaryDirectory(prefix="devhub-whisper-") as scratch:
		source = Path(scratch) / "whisper.cpp"
		subprocess.run(
			["git", "clone", "--quiet", "--depth", "1", "--branch", WHISPER_CPP_VERSION, WHISPER_CPP_REPOSITORY, str(source)],
			check=True,
		)
		head = subprocess.run(
			["git", "-C", str(source), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
		).stdout.strip()
		if head != WHISPER_CPP_COMMIT:
			fail(f"{WHISPER_CPP_VERSION} is {head} upstream, not the pinned {WHISPER_CPP_COMMIT}; refusing to build it")
		build = source / "build"
		subprocess.run(["cmake", "-S", str(source), "-B", str(build), *CMAKE_FLAGS], check=True)
		subprocess.run(
			["cmake", "--build", str(build), "--target", *(t for t, _ in PROGRAMS), "--parallel", str(os.cpu_count() or 4)],
			check=True,
		)
		cached_dir.mkdir(parents=True, exist_ok=True)
		for target, name in PROGRAMS:
			built = build / "bin" / target
			if not built.is_file():
				fail(f"the build finished without {built}")
			otool = subprocess.run(["otool", "-L", str(built)], check=True, capture_output=True, text=True).stdout
			foreign = foreign_libraries(otool)
			if foreign:
				fail(f"{target} links libraries a stock macOS does not have: {', '.join(foreign)}")
			partial = cached_dir / (name + ".part")
			shutil.copyfile(built, partial)
			partial.chmod(0o755)
			partial.replace(cached_dir / name)
		shutil.copyfile(source / "LICENSE", cached_dir / LICENSE)
	return cached_dir


def install(out_dir: Path, *, use_cache: bool = True, model: str | None = None) -> None:
	"""Put the programs and their statement in `out_dir` — and, for development,
	`model` beside them. A model already there is left alone: packaging does
	not take it, and a source run may be using it."""
	root = cache_root()
	binaries = ensure_binary(root, use_cache=use_cache)
	out_dir.mkdir(parents=True, exist_ok=True)
	copies = [(binaries / name, name) for _, name in PROGRAMS]
	copies.append((binaries / LICENSE, LICENSE))
	if model is not None:
		copies.append((ensure_model(root, use_cache=use_cache, model=model), model))
	for source, name in copies:
		partial = out_dir / (name + ".part")
		shutil.copyfile(source, partial)
		partial.replace(out_dir / name)
	for _, name in PROGRAMS:
		(out_dir / name).chmod(0o755)
	(out_dir / STATEMENT).write_text(
		json.dumps(
			statement(hash_file(out_dir / BINARY, "sha256"), hash_file(out_dir / SERVER_BINARY, "sha256")),
			indent="\t",
		)
		+ "\n"
	)


def ensure(out_dir: Path = DEFAULT_OUT_DIR) -> int:
	"""Install the programs into `out_dir` unless what is there is already right.
	For package-nightly.py, which bundles no model."""
	if not install_problems(out_dir):
		return 0
	install(out_dir)
	problems = install_problems(out_dir)
	for problem in problems:
		print(f"  {problem}", file=sys.stderr)
	return 1 if problems else 0


def main(argv: list[str]) -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
	parser.add_argument("--no-cache", action="store_true", help="build and download again")
	parser.add_argument("--check", metavar="DIR", help="only say what is wrong with DIR")
	parser.add_argument(
		"--model",
		choices=tuple(MODELS),
		help=f"also install this model, for a source run (default: ${MODEL_ENV}, else none: the app downloads it)",
	)
	args = parser.parse_args(argv)
	model = args.model or chosen_model()
	if args.check:
		problems = install_problems(Path(args.check), model=model)
		for problem in problems:
			print(problem)
		return 1 if problems else 0
	if sys.platform != "darwin" or platform.machine() != "arm64":
		fail("the recogniser is built for the bundle: macOS on Apple Silicon only")
	install(Path(args.out_dir).resolve(), use_cache=not args.no_cache, model=model)
	problems = install_problems(Path(args.out_dir).resolve(), model=model)
	if problems:
		fail("; ".join(problems))
	say(f"recogniser ready in {args.out_dir}")
	return 0


if __name__ == "__main__":
	raise SystemExit(main(sys.argv[1:]))
