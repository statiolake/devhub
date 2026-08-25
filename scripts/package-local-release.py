#!/usr/bin/env python3
"""Package one already-built DevHub.app without publishing or signing it.

The archive is intentionally assembled in Python rather than with ``ditto``:
input paths are sorted and every zip entry gets a fixed timestamp, so the
checksum procedure is stable for a byte-identical app bundle. This script does
not build the app, contact a network, sign, notarize, or mutate Git state.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP = ROOT / "target" / "release" / "bundle" / "macos" / "DevHub.app"
DEFAULT_OUTPUT = ROOT / "dist" / "release"
PRODUCT = "DevHub"
IDENTIFIER = "io.github.statiolake.devhub"
VERSION = "0.1.0"
ZIP_TIMESTAMP = (2000, 1, 1, 0, 0, 0)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fail(message: str) -> None:
    raise SystemExit(f"package-local-release: {message}")


def read_info_plist(app: Path) -> dict[str, object]:
    path = app / "Contents" / "Info.plist"
    if not path.is_file():
        fail(f"missing bundle metadata: {path}")
    try:
        with path.open("rb") as stream:
            value = plistlib.load(stream)
    except (OSError, plistlib.InvalidFileException) as error:
        fail(f"cannot read bundle metadata: {error}")
    if not isinstance(value, dict):
        fail(f"bundle metadata is not a dictionary: {path}")
    return value


def verify_app(app: Path) -> dict[str, object]:
    if app.suffix != ".app" or not app.is_dir():
        fail(f"expected a .app directory: {app}")
    info = read_info_plist(app)
    if info.get("CFBundleIdentifier") != IDENTIFIER:
        fail(f"unexpected bundle identifier: {info.get('CFBundleIdentifier')!r}")
    if info.get("CFBundleShortVersionString") != VERSION:
        fail(
            "unexpected app version: "
            f"{info.get('CFBundleShortVersionString')!r} (expected {VERSION})"
        )

    executable_name = info.get("CFBundleExecutable")
    if not isinstance(executable_name, str) or not executable_name:
        fail("CFBundleExecutable is missing")
    executable = app / "Contents" / "MacOS" / executable_name
    if not executable.is_file():
        fail(f"bundle executable is missing: {executable}")

    file_result = subprocess.run(
        ["file", str(executable)], capture_output=True, text=True, check=False
    )
    if file_result.returncode != 0 or "arm64" not in file_result.stdout:
        fail(f"bundle executable is not Apple Silicon arm64: {file_result.stdout.strip()}")

    resources = app / "Contents" / "Resources"
    required = [
        resources / "devhub-bridge.vsix",
        resources / "THIRD-PARTY-NOTICES.txt",
        resources / "INSTALL.md",
        resources / "licenses" / "DevHub-MIT.txt",
        resources / "licenses" / "Apache-2.0.txt",
        resources / "licenses" / "Tauri-API-MIT.txt",
        resources / "licenses" / "React-MIT.txt",
        resources / "licenses" / "Xterm-MIT.txt",
        resources / "licenses" / "WRY-MIT.txt",
    ]
    for path in required:
        if not path.is_file():
            fail(f"bundle is missing required notice/license resource: {path}")

    forbidden_provider_names = ("openvscode", "visual studio code", "openvscode-server")
    for path in resources.rglob("*") if resources.is_dir() else ():
        if any(part.lower() in forbidden_provider_names for part in path.parts):
            fail(f"legacy or official VS Code payload is present in Resources: {path}")
    return info


def copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def iter_files(root: Path) -> list[Path]:
    return sorted(
        (path for path in root.rglob("*") if path.is_file()),
        key=lambda path: path.relative_to(root).as_posix(),
    )


def write_bundle_manifest(app: Path, output: Path, artifact: str) -> tuple[Path, str]:
    """Write a stable per-file SHA-256 manifest for the generated app bundle."""
    entries = []
    for path in iter_files(app):
        relative = path.relative_to(app.parent).as_posix()
        entries.append(f"{sha256_file(path)}  {relative}")
    contents = ("\n".join(entries) + "\n").encode("utf-8")
    manifest = output / f"{artifact}.bundle-manifest.txt"
    manifest.write_bytes(contents)
    return manifest, sha256_bytes(contents)


def add_zip_file(archive: zipfile.ZipFile, path: Path, root: Path) -> None:
    relative = path.relative_to(root).as_posix()
    info = zipfile.ZipInfo(relative, ZIP_TIMESTAMP)
    mode = stat.S_IMODE(path.stat().st_mode)
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | mode) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)


def write_archive(stage: Path, archive_path: Path) -> None:
    """Write a stable zip with sorted entries and source-mtime-independent dates."""
    files = iter_files(stage)
    with zipfile.ZipFile(
        archive_path,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
        strict_timestamps=False,
    ) as archive:
        for path in files:
            add_zip_file(archive, path, stage)


def package(app: Path, output: Path) -> dict[str, str]:
    verify_app(app)
    output.mkdir(parents=True, exist_ok=True)
    artifact = f"{PRODUCT}-v{VERSION}-macos-arm64"
    archive_path = output / f"{artifact}.zip"
    archive_checksum_path = output / f"{artifact}.zip.sha256"
    manifest_checksum_path = output / f"{artifact}.bundle-manifest.sha256"

    with tempfile.TemporaryDirectory(prefix=".devhub-package-", dir=output) as root:
        stage = Path(root)
        staged_app = stage / app.name
        shutil.copytree(app, staged_app, symlinks=True)
        copy_file(ROOT / "LICENSE", stage / "LICENSE")
        copy_file(
            ROOT / "distribution" / "THIRD-PARTY-NOTICES.txt",
            stage / "THIRD-PARTY-NOTICES.txt",
        )
        copy_file(ROOT / "docs" / "INSTALL.md", stage / "INSTALL.md")
        write_archive(stage, archive_path)

    manifest, manifest_checksum = write_bundle_manifest(app, output, artifact)
    archive_checksum = sha256_file(archive_path)
    archive_checksum_path.write_text(f"{archive_checksum}  {archive_path.name}\n", encoding="utf-8")
    manifest_checksum_path.write_text(f"{manifest_checksum}  {manifest.name}\n", encoding="utf-8")
    return {
        "archive": str(archive_path),
        "archive_sha256": archive_checksum,
        "bundle_manifest": str(manifest),
        "bundle_manifest_sha256": manifest_checksum,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=DEFAULT_APP, help="built DevHub.app path")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    # pnpm 11 passes the run-script separator through on some installations.
    # Accept it once so both `pnpm run package:local-release -- --app ...` and
    # direct Python invocation have the same interface.
    argv = sys.argv[1:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    app = args.app.expanduser().resolve()
    output = args.output_dir.expanduser().resolve()
    print(json.dumps(package(app, output), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
