#!/usr/bin/env python3
"""Compare Apple's SpeechAnalyzer (speech-bench) with whisper.cpp on a set of clips.

    tools/speech-bench/compare.py CLIPS_DIR [--model small --model large-v3-turbo]
    tools/speech-bench/compare.py CLIPS_DIR --record 8 --say "useDictationのフックを直して"

CLIPS_DIR holds audio files (.wav .m4a .mp3 .aiff .caf .flac) and, optionally, a
reference transcript beside each (`clip.wav` + `clip.txt`, UTF-8). For every clip
it runs

  apple      speech-bench file CLIP --json      (SpeechTranscriber, on-device)
  whisper    DevHub's whisper.cpp build, once per --model

and prints wall time, real-time factor (wall / audio length; below 1 is faster
than real time) and, where a reference exists, the character error rate. CER is
the measure for Japanese: there are no spaces to count words by. Both sides are
normalised the same way before comparing (NFKC, lower case, punctuation and
spaces removed), so 「直して。」 and 「直して」 are not an error, but 「治して」 is.

whisper.cpp runs the way DevHub runs it. `--whisper-mode server` (the default
when the server binary is found) is what dictation uses: the model loaded once
and kept, each clip one POST to /inference, so the time is the transcription
alone; the load is reported separately and one warm-up request is not counted.
`--whisper-mode cli` is DevHub's fallback: a process per clip, model load
included in every time.

Every clip is first converted to 16 kHz mono 16-bit WAV (afconvert, or ffmpeg)
and both engines get that same file.

Nothing here leaves the machine except, with --download, the whisper model
files from huggingface.co (the same URL scripts/build_whisper.py uses).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
AUDIO_SUFFIXES = {".wav", ".m4a", ".mp3", ".aiff", ".aif", ".caf", ".flac", ".mp4"}
HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# Names --model accepts, each to the file it means. The quantised files are the
# ones DevHub ships or considers (scripts/build_whisper.py).
MODEL_ALIASES = {
	"small": "ggml-small.bin",
	"small-q5_1": "ggml-small-q5_1.bin",
	"large-v3-turbo": "ggml-large-v3-turbo-q5_0.bin",
	"large-v3-turbo-q8": "ggml-large-v3-turbo-q8_0.bin",
	"large-v3-turbo-f16": "ggml-large-v3-turbo.bin",
	"medium": "ggml-medium-q5_0.bin",
	"base": "ggml-base-q5_1.bin",
}


def say(message: str) -> None:
	print(f"==> {message}", file=sys.stderr, flush=True)


def fail(message: str) -> "None":
	print(f"compare.py: {message}", file=sys.stderr)
	raise SystemExit(1)


# --- CER ----------------------------------------------------------------------


def normalise(text: str) -> str:
	"""What is compared: NFKC (full-width ＡＢＣ and half-width ｶﾅ folded), lower
	case, and no punctuation, symbols-as-punctuation or whitespace. The long
	vowel mark ー is a letter (Lm) and stays."""
	text = unicodedata.normalize("NFKC", text).lower()
	return "".join(ch for ch in text if unicodedata.category(ch)[0] not in "PZC")


def edit_distance(a: str, b: str) -> int:
	if len(a) < len(b):
		a, b = b, a
	previous = list(range(len(b) + 1))
	for i, ca in enumerate(a, 1):
		current = [i]
		for j, cb in enumerate(b, 1):
			current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
		previous = current
	return previous[-1]


def cer(reference: str, hypothesis: str) -> tuple[int, int]:
	"""(edits, reference length) after normalising; CER is their ratio."""
	ref, hyp = normalise(reference), normalise(hypothesis)
	return edit_distance(ref, hyp), len(ref)


# --- audio --------------------------------------------------------------------


def to_wav16k(source: Path, target: Path) -> None:
	if shutil.which("afconvert"):
		command = ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(source), str(target)]
	elif shutil.which("ffmpeg"):
		command = ["ffmpeg", "-loglevel", "error", "-y", "-i", str(source), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(target)]
	else:
		fail("need afconvert (macOS) or ffmpeg to convert audio to 16 kHz WAV")
	subprocess.run(command, check=True)


def wav_seconds(path: Path) -> float:
	with wave.open(str(path), "rb") as w:
		return w.getnframes() / float(w.getframerate())


# --- finding things -----------------------------------------------------------


def cache_root() -> Path:
	"""Where scripts/build_whisper.py caches (DEVHUB_WHISPER_CACHE, XDG_CACHE_HOME)."""
	override = os.environ.get("DEVHUB_WHISPER_CACHE")
	if override:
		return Path(override)
	xdg = os.environ.get("XDG_CACHE_HOME")
	return (Path(xdg) if xdg else Path.home() / ".cache") / "devhub" / "whisper"


def find_binary(explicit: str | None, devhub_name: str, upstream_name: str) -> Path | None:
	"""--whisper-bin, else DevHub's dist/whisper build, else the build cache, else
	whisper.cpp's own name on PATH (e.g. Homebrew's whisper-cpp)."""
	if explicit:
		path = Path(explicit).expanduser()
		if not (path.is_file() and os.access(path, os.X_OK)):
			fail(f"{path} is not an executable")
		return path
	candidates = [REPO_ROOT / "dist" / "whisper" / devhub_name]
	candidates += sorted(
		(Path(p) for p in glob.glob(str(cache_root() / "bin" / "*" / devhub_name))),
		key=lambda p: p.stat().st_mtime,
		reverse=True,
	)
	for candidate in candidates:
		if candidate.is_file() and os.access(candidate, os.X_OK):
			return candidate
	found = shutil.which(upstream_name)
	return Path(found) if found else None


def model_dirs(extra: list[str]) -> list[Path]:
	return [Path(d).expanduser() for d in extra] + [REPO_ROOT / "dist" / "whisper", cache_root() / "models"]


def find_model(name: str, dirs: list[Path], download: bool) -> Path:
	"""A path, an alias (small, large-v3-turbo, ...) or a ggml file name."""
	path = Path(name).expanduser()
	if path.suffix == ".bin" and path.is_file():
		return path
	filename = MODEL_ALIASES.get(name, name if name.endswith(".bin") else f"ggml-{name}.bin")
	for directory in dirs:
		if (directory / filename).is_file():
			return directory / filename
	if not download:
		fail(
			f"no {filename} in {', '.join(str(d) for d in dirs)}. "
			"Pass a path, --models-dir, or --download to fetch it from huggingface.co"
		)
	target = cache_root() / "models" / filename
	target.parent.mkdir(parents=True, exist_ok=True)
	partial = target.with_suffix(".part")
	url = f"{HF_BASE}/{filename}"
	say(f"downloading {filename} from {url}")
	try:
		with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as out:
			shutil.copyfileobj(response, out, 1 << 20)
	except OSError as error:
		partial.unlink(missing_ok=True)
		fail(f"could not download {filename}: {error}")
	partial.replace(target)
	return target


# --- engines ------------------------------------------------------------------

NON_SPEECH_PREFIXES = ("[", "(", "（", "*", "♪")


def clean_whisper(text: str) -> str:
	"""Drop whisper's non-speech segments ([BLANK_AUDIO], (音楽), ...), as DevHub does."""
	lines = []
	for line in text.splitlines():
		stripped = line.strip()
		if not stripped:
			continue
		if stripped.startswith(NON_SPEECH_PREFIXES) and stripped.endswith(("]", ")", "）", "*", "♪")):
			continue
		lines.append(stripped)
	return ("" if any(not line.isascii() for line in lines) else " ").join(lines)


def run_apple(bench: Path, wav: Path, locale: str, extra: list[str]) -> dict:
	command = [str(bench), "file", str(wav), "--locale", locale, "--json", "--quiet", *extra]
	started = time.monotonic()
	completed = subprocess.run(command, capture_output=True, text=True)
	elapsed = time.monotonic() - started
	if completed.returncode != 0:
		return {"error": completed.stderr.strip()[-800:] or f"exit {completed.returncode}"}
	summary = json.loads(completed.stdout)
	return {
		"text": summary["text"],
		"wall": summary["wallSeconds"],
		"process": elapsed,
		"prepare": summary.get("prepareSeconds"),
		"assetsDownloaded": summary.get("assets", {}).get("downloaded"),
		"summary": summary,
	}


def run_whisper_cli(binary: Path, model: Path, wav: Path, language: str, threads: int) -> dict:
	with tempfile.TemporaryDirectory(prefix="speech-bench-") as scratch:
		base = Path(scratch) / "transcript"
		# The arguments DevHub passes (apps/desktop/src/main/voice/whisper.ts).
		command = [str(binary), "-m", str(model), "-f", str(wav), "-l", language, "-t", str(threads), "-nt", "-np", "-otxt", "-of", str(base)]
		started = time.monotonic()
		completed = subprocess.run(command, capture_output=True, text=True)
		elapsed = time.monotonic() - started
		if completed.returncode != 0:
			return {"error": completed.stderr.strip()[-800:] or f"exit {completed.returncode}"}
		text = Path(f"{base}.txt").read_text(encoding="utf-8")
	return {"text": clean_whisper(text), "wall": elapsed, "process": elapsed}


class WhisperServer:
	"""whisper-server as DevHub runs it (main/voice/whisperServer.ts): 127.0.0.1,
	a free port, a random request path."""

	def __init__(self, binary: Path, model: Path, threads: int):
		with socket.socket() as s:
			s.bind(("127.0.0.1", 0))
			self.port = s.getsockname()[1]
		self.path = f"/{uuid.uuid4().hex}"
		self.base = f"http://127.0.0.1:{self.port}{self.path}"
		command = [str(binary), "-m", str(model), "--host", "127.0.0.1", "--port", str(self.port), "--request-path", self.path, "-t", str(threads), "-nt"]
		started = time.monotonic()
		self.process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
		deadline = started + 120
		while True:
			if self.process.poll() is not None:
				fail(f"whisper-server exited: {self.process.stderr.read()[-800:] if self.process.stderr else ''}")
			try:
				with urllib.request.urlopen(f"{self.base}/health", timeout=2) as response:
					if response.status == 200:
						break
			except (urllib.error.URLError, OSError):
				pass
			if time.monotonic() > deadline:
				self.close()
				fail("whisper-server did not become ready within 120 s")
			time.sleep(0.2)
		self.load_seconds = time.monotonic() - started

	def transcribe(self, wav: Path, language: str) -> dict:
		boundary = uuid.uuid4().hex
		fields = {"response_format": "text", "no_timestamps": "true", "temperature": "0", "language": language}
		body = bytearray()
		for key, value in fields.items():
			body += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
		body += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
		body += wav.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
		request = urllib.request.Request(
			f"{self.base}/inference",
			data=bytes(body),
			headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
			method="POST",
		)
		started = time.monotonic()
		try:
			with urllib.request.urlopen(request, timeout=600) as response:
				text = response.read().decode("utf-8")
		except (urllib.error.URLError, OSError) as error:
			return {"error": str(error)}
		elapsed = time.monotonic() - started
		return {"text": clean_whisper(text), "wall": elapsed, "process": elapsed}

	def close(self) -> None:
		if self.process.poll() is None:
			self.process.terminate()
			try:
				self.process.wait(timeout=5)
			except subprocess.TimeoutExpired:
				self.process.kill()


def peak_rss_of_children() -> int | None:
	"""Largest RSS among finished children (bytes on macOS); whisper's memory."""
	try:
		import resource

		value = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
		return value if sys.platform == "darwin" else value * 1024
	except Exception:
		return None


# --- recording ----------------------------------------------------------------


def record(bench: Path, directory: Path, seconds: float, locale: str, name: str | None, text: str | None) -> None:
	directory.mkdir(parents=True, exist_ok=True)
	stem = name or time.strftime("clip-%Y%m%d-%H%M%S")
	wav = directory / f"{stem}.wav"
	if text:
		print(f"\nRead this aloud after the prompt:\n\n    {text}\n", file=sys.stderr)
		input("Press Enter to start recording... ")
	subprocess.run([str(bench), "mic", "--locale", locale, "--seconds", str(seconds), "--save", str(wav), "--quiet"], check=True)
	reference = text
	if reference is None and sys.stdin.isatty():
		reference = input("Reference transcript (what you actually said; Enter to skip): ").strip() or None
	if reference:
		(directory / f"{stem}.txt").write_text(reference + "\n", encoding="utf-8")
	say(f"saved {wav}" + (" and its reference" if reference else ""))


# --- report -------------------------------------------------------------------


def preview(text: str, width: int = 40) -> str:
	text = text.replace("\n", " ")
	return text if len(text) <= width else text[: width - 1] + "…"


def print_table(rows: list[dict]) -> None:
	header = ("engine", "clip", "audio s", "wall s", "RTF", "CER", "text")
	table = [header]
	for row in rows:
		if "error" in row:
			table.append((row["engine"], row["clip"], f"{row['audio']:.1f}", "-", "-", "-", "ERROR: " + preview(row["error"], 60)))
			continue
		cer_text = f"{row['edits'] / row['refLength'] * 100:.1f}%" if row.get("refLength") else "-"
		table.append((row["engine"], row["clip"], f"{row['audio']:.1f}", f"{row['wall']:.2f}", f"{row['wall'] / row['audio']:.3f}" if row["audio"] else "-", cer_text, preview(row["text"])))
	widths = [max(display_width(str(r[i])) for r in table) for i in range(len(header) - 1)]
	for r in table:
		cells = [pad(str(r[i]), widths[i]) for i in range(len(header) - 1)]
		print("  ".join(cells + [str(r[-1])]))


def print_totals(rows: list[dict], extras: dict[str, str]) -> None:
	print()
	print("totals per engine (CER over all clips with a reference: total edits / total reference characters)")
	engines = []
	for row in rows:
		if row["engine"] not in engines:
			engines.append(row["engine"])
	width = max(len(e) for e in engines)
	for engine in engines:
		mine = [r for r in rows if r["engine"] == engine and "error" not in r]
		audio = sum(r["audio"] for r in mine)
		wall = sum(r["wall"] for r in mine)
		edits = sum(r.get("edits", 0) for r in mine if r.get("refLength"))
		length = sum(r.get("refLength", 0) for r in mine)
		errors = sum(1 for r in rows if r["engine"] == engine and "error" in r)
		parts = [engine.ljust(width), f"clips {len(mine)}", f"audio {audio:.1f}s", f"wall {wall:.2f}s", f"RTF {wall / audio:.3f}" if audio else "RTF -"]
		parts.append(f"CER {edits / length * 100:.1f}% ({edits}/{length})" if length else "CER -")
		if errors:
			parts.append(f"{errors} error(s)")
		if engine in extras:
			parts.append(extras[engine])
		print("  ".join(parts))


def display_width(text: str) -> int:
	return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def pad(text: str, width: int) -> str:
	return text + " " * (width - display_width(text))


# --- main ---------------------------------------------------------------------


def main(argv: list[str]) -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("clips", help="directory of audio clips (and optional .txt references)")
	parser.add_argument("--speech-bench", default=str(HERE / ".build" / "release" / "speech-bench"), help="speech-bench binary (default: this package's release build)")
	parser.add_argument("--locale", default="ja_JP", help="speech-bench locale (default ja_JP)")
	parser.add_argument("--language", default="ja", help="whisper language (default ja)")
	parser.add_argument("--apple-arg", action="append", default=[], help="extra argument for speech-bench file, e.g. --apple-arg=--engine --apple-arg=dictation (repeatable)")
	parser.add_argument("--skip-apple", action="store_true")
	parser.add_argument("--whisper-bin", help="whisper-cli (DevHub: dist/whisper/devhub-whisper)")
	parser.add_argument("--whisper-server-bin", help="whisper-server (DevHub: dist/whisper/devhub-whisper-server)")
	parser.add_argument("--whisper-mode", choices=("server", "cli", "both"), help="default: server if found, else cli")
	parser.add_argument("--model", action="append", help="whisper model: alias (" + ", ".join(MODEL_ALIASES) + "), ggml file name or path; repeatable. Default: small and large-v3-turbo")
	parser.add_argument("--models-dir", action="append", default=[], help="another directory to look for models in")
	parser.add_argument("--download", action="store_true", help="fetch missing models from huggingface.co into the DevHub whisper cache")
	parser.add_argument("--skip-whisper", action="store_true")
	parser.add_argument("--threads", type=int, default=min(8, os.cpu_count() or 4), help="whisper threads (DevHub: cores, at most 8)")
	parser.add_argument("--out", help="also write every result (texts, timings, speech-bench summaries) as JSON here")
	parser.add_argument("--record", type=float, metavar="SECONDS", help="instead of comparing, record one clip of SECONDS into CLIPS with speech-bench mic --save")
	parser.add_argument("--name", help="--record: file name stem (default clip-<timestamp>)")
	parser.add_argument("--say", help="--record: the sentence to read aloud; saved as the reference")
	args = parser.parse_args(argv)

	clips_dir = Path(args.clips).expanduser()
	bench = Path(args.speech_bench).expanduser()
	needs_bench = args.record is not None or not args.skip_apple
	if needs_bench and not (bench.is_file() and os.access(bench, os.X_OK)):
		fail(f"no speech-bench at {bench}. Build it: (cd {HERE} && swift build -c release), or pass --speech-bench / --skip-apple")

	if args.record is not None:
		record(bench, clips_dir, args.record, args.locale, args.name, args.say)
		return 0

	clips = sorted(p for p in clips_dir.iterdir() if p.suffix.lower() in AUDIO_SUFFIXES) if clips_dir.is_dir() else []
	if not clips:
		fail(f"no audio clips in {clips_dir}")

	cli_bin = server_bin = None
	models: list[Path] = []
	modes: list[str] = []
	if not args.skip_whisper:
		cli_bin = find_binary(args.whisper_bin, "devhub-whisper", "whisper-cli")
		server_bin = find_binary(args.whisper_server_bin, "devhub-whisper-server", "whisper-server")
		mode = args.whisper_mode or ("server" if server_bin else "cli")
		modes = ["server", "cli"] if mode == "both" else [mode]
		for m in modes:
			if (server_bin if m == "server" else cli_bin) is None:
				fail(f"no whisper {m} binary found; build DevHub's with scripts/build_whisper.py or pass --whisper-{'server-' if m == 'server' else ''}bin")
		dirs = model_dirs(args.models_dir)
		models = [find_model(name, dirs, args.download) for name in (args.model or ["small", "large-v3-turbo"])]
		say(f"whisper: {', '.join(modes)} · models: {', '.join(m.name for m in models)} · {args.threads} threads")

	rows: list[dict] = []
	extras: dict[str, str] = {}
	with tempfile.TemporaryDirectory(prefix="speech-bench-clips-") as scratch:
		prepared = []
		for clip in clips:
			wav = Path(scratch) / f"{clip.stem}.wav"
			to_wav16k(clip, wav)
			reference_path = clip.with_suffix(".txt")
			reference = reference_path.read_text(encoding="utf-8").strip() if reference_path.is_file() else None
			prepared.append((clip, wav, wav_seconds(wav), reference))

		def add(engine: str, clip: Path, audio: float, reference: str | None, result: dict) -> None:
			row = {"engine": engine, "clip": clip.name, "audio": audio, **{k: v for k, v in result.items() if k != "summary"}}
			if "summary" in result:
				row["speechBench"] = result["summary"]
			if reference is not None and "error" not in result:
				row["edits"], row["refLength"] = cer(reference, result["text"])
				row["reference"] = reference
			rows.append(row)

		if not args.skip_apple:
			engine = "apple " + " ".join(args.apple_arg) if args.apple_arg else "apple SpeechTranscriber"
			for clip, wav, audio, reference in prepared:
				say(f"{engine}: {clip.name}")
				result = run_apple(bench, wav, args.locale, args.apple_arg)
				add(engine, clip, audio, reference, result)
			downloaded = [r for r in rows if r["engine"] == engine and r.get("assetsDownloaded")]
			prepares = [r["prepare"] for r in rows if r["engine"] == engine and r.get("prepare") is not None]
			note = f"prepare (not in wall) median {sorted(prepares)[len(prepares) // 2]:.2f}s" if prepares else ""
			if downloaded:
				note += " · model assets were downloaded during the first clip (its time includes no download: that happens before timing)"
			extras[engine] = note

		for model in models:
			for mode in modes:
				engine = f"whisper {mode} {model.name.removeprefix('ggml-').removesuffix('.bin')}"
				if mode == "server":
					assert server_bin is not None
					say(f"{engine}: loading model")
					server = WhisperServer(server_bin, model, args.threads)
					try:
						# One request not counted: the first inference allocates the GPU buffers.
						server.transcribe(prepared[0][1], args.language)
						for clip, wav, audio, reference in prepared:
							say(f"{engine}: {clip.name}")
							add(engine, clip, audio, reference, server.transcribe(wav, args.language))
					finally:
						server.close()
					extras[engine] = f"model load {server.load_seconds:.2f}s (not in wall)"
				else:
					assert cli_bin is not None
					for clip, wav, audio, reference in prepared:
						say(f"{engine}: {clip.name}")
						add(engine, clip, audio, reference, run_whisper_cli(cli_bin, model, wav, args.language, args.threads))
					extras[engine] = "process per clip, model load in every wall time"

	print()
	print_table(rows)
	print_totals(rows, extras)
	rss = peak_rss_of_children()
	if rss:
		print(f"\npeak RSS of any child process (largest whisper run, or speech-bench itself): {rss / 1048576:.0f} MB")
	print("speech-bench's own memory excludes Apple's model, which runs in a system process: see each clip's speechProcesses in --out.")
	if args.out:
		Path(args.out).write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
		say(f"wrote {args.out}")
	return 0


if __name__ == "__main__":
	raise SystemExit(main(sys.argv[1:]))
