#!/usr/bin/env python3
"""Build and smoke-test the pinned upstream OpenVSCode Darwin arm64 server.

The script intentionally writes only hashes, relative names, version strings,
and bounded smoke results to its ledger.  Source clones, credentials, server
logs, and generated bundles stay below the caller-provided temporary root.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any, Iterable, Sequence


UPSTREAM_REPOSITORY = "https://github.com/gitpod-io/openvscode-server.git"
OPENVSCODE_TAG = "openvscode-server-v1.109.5"
OPENVSCODE_COMMIT = "4ffe2270acdf711bbefecc3e8c79f4b3631640e5"
OPENVSCODE_VERSION = "1.109.5"
NODE_VERSION = "22.21.1"
NODE_ARCHIVE = f"node-v{NODE_VERSION}-darwin-arm64.tar.gz"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}"
PNPM_VERSION = "11.20.0"
RUST_VERSION = "1.97.1"
BUILD_TASK = "vscode-reh-web-darwin-arm64"
FALLBACK_BUILD_TASK = "vscode-reh-web-darwin-arm64-min-ci (requires the upstream core-ci compilation outputs)"
LOCKFILE_NAMES = {
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
}


class ProvenanceError(RuntimeError):
    """Raised when a reproducibility or acceptance assertion fails."""


def command_text(command: Sequence[str]) -> str:
    return " ".join(str(part) for part in command)


def run(
    command: Sequence[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    capture: bool = False,
    check: bool = True,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a command without shell interpolation."""

    try:
        return subprocess.run(
            [str(part) for part in command],
            cwd=str(cwd) if cwd else None,
            env=env,
            check=check,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ProvenanceError(f"command failed: {command_text(command)}") from exc


def output(command: Sequence[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    result = run(command, cwd=cwd, env=env, capture=True)
    return result.stdout.strip()


def optional_output(command: Sequence[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str | None:
    result = run(command, cwd=cwd, env=env, capture=True, check=False)
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def relative_files(root: Path, names: set[str]) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if any(part in {".git", "node_modules", "target"} for part in path.relative_to(root).parts):
            continue
        if path.name in names:
            files.append(path)
    return sorted(files, key=lambda item: item.relative_to(root).as_posix())


def hash_manifest(root: Path) -> tuple[str, int, int, Path]:
    """Hash regular files and symlink targets using repository-relative names."""

    manifest = root.parent / f".{root.name}.bundle-manifest"
    count = 0
    total_bytes = 0
    with manifest.open("w", encoding="utf-8") as handle:
        entries = sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix())
        for path in entries:
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                handle.write(f"symlink\t{relative}\t{os.readlink(path)}\n")
                count += 1
            elif path.is_file():
                digest = sha256_file(path)
                size = path.stat().st_size
                handle.write(f"file\t{relative}\t{size}\t{digest}\n")
                count += 1
                total_bytes += size
    return sha256_file(manifest), count, total_bytes, manifest


def file_kind(path: Path) -> tuple[bool, bool, str]:
    """Return (is Mach-O, contains arm64, stable description)."""

    raw = optional_output(["file", str(path)]) or ""
    # The temporary root itself contains "darwin-arm64". Strip the filename
    # before classifying the output so a non-arm64 object cannot pass by
    # matching its evidence path rather than its Mach-O header.
    description_text = raw.replace(str(path), "")
    is_macho = "Mach-O" in description_text
    has_arm64 = bool(re.search(r"\barm64\b", description_text))
    if is_macho and has_arm64:
        description = "Mach-O arm64"
    elif is_macho:
        description = "Mach-O non-arm64"
    elif "PE32" in description_text:
        description = "PE/COFF non-Darwin"
    elif "script" in description_text.lower():
        description = "script"
    else:
        description = "other"
    return is_macho, has_arm64, description


def lipo_architectures(path: Path) -> list[str]:
    raw = optional_output(["lipo", "-info", str(path)]) or ""
    raw = raw.replace(str(path), "")
    known = {"arm64", "arm64e", "x86_64", "i386", "ppc", "ppc64"}
    return sorted({item for item in re.findall(r"\b(?:arm64e|arm64|x86_64|i386|ppc64|ppc)\b", raw) if item in known})


def source_metadata(source: Path) -> dict[str, Any]:
    commit = output(["git", "rev-parse", "HEAD"], cwd=source)
    if commit != OPENVSCODE_COMMIT:
        raise ProvenanceError(f"unexpected OpenVSCode commit: {commit}")
    origin = output(["git", "config", "--get", "remote.origin.url"], cwd=source)
    normalized_origin = origin.removesuffix(".git")
    if normalized_origin != UPSTREAM_REPOSITORY.removesuffix(".git"):
        raise ProvenanceError("source origin is not the upstream OpenVSCode repository")
    status = output(["git", "status", "--porcelain"], cwd=source)
    if status:
        raise ProvenanceError("OpenVSCode source clone is not clean")

    version_file = source / ".nvmrc"
    node_pin = version_file.read_text(encoding="utf-8").strip()
    if node_pin != NODE_VERSION:
        raise ProvenanceError(f"unexpected .nvmrc: {node_pin}")

    inputs: list[dict[str, str]] = []
    for path in [version_file, source / "package.json", source / "build" / "checksums" / "nodejs.txt"]:
        if path.is_file():
            inputs.append(
                {
                    "path": path.relative_to(source).as_posix(),
                    "sha256": sha256_file(path),
                }
            )
    lockfiles = []
    for path in relative_files(source, LOCKFILE_NAMES):
        lockfiles.append(
            {
                "path": path.relative_to(source).as_posix(),
                "sha256": sha256_file(path),
            }
        )
    if not any(item["path"] == "package-lock.json" for item in lockfiles):
        raise ProvenanceError("upstream package-lock.json is missing")

    lockfile_manifest = "\n".join(
        f"{item['path']}\t{item['sha256']}" for item in lockfiles
    ).encode("utf-8")

    return {
        "repository": UPSTREAM_REPOSITORY,
        "tag": OPENVSCODE_TAG,
        "commit": commit,
        "version": OPENVSCODE_VERSION,
        "source_inputs": inputs,
        "lockfiles": lockfiles,
        "lockfiles_manifest_sha256": sha256_bytes(lockfile_manifest),
    }


def node_and_package_provenance(node_bin: Path, env: dict[str, str], work_root: Path) -> dict[str, Any]:
    node_version = output([str(node_bin), "--version"], env=env)
    npm_bin = node_bin.parent / "npm"
    npm_version = output([str(npm_bin), "--version"], env=env)
    if node_version != f"v{NODE_VERSION}":
        raise ProvenanceError(f"unexpected Node version: {node_version}")

    corepack = node_bin.parent / "corepack"
    pnpm_bin = shutil.which("pnpm", path=env.get("PATH"))
    pnpm_version = output([pnpm_bin, "--version"], env=env) if pnpm_bin else ""
    if pnpm_version != PNPM_VERSION and corepack.is_file():
        run([str(corepack), "enable"], env=env)
        run([str(corepack), "prepare", f"pnpm@{PNPM_VERSION}", "--activate"], env=env)
        pnpm_bin = shutil.which("pnpm", path=env.get("PATH"))
        pnpm_version = output([pnpm_bin, "--version"], env=env) if pnpm_bin else ""
    if pnpm_version != PNPM_VERSION:
        raise ProvenanceError(f"pnpm {PNPM_VERSION} is required, got {pnpm_version or 'unavailable'}")

    rustup = shutil.which("rustup")
    rustc_version = ""
    cargo_version = ""
    if rustup:
        rustc_command = [rustup, "run", RUST_VERSION, "rustc", "--version", "--verbose"]
        cargo_command = [rustup, "run", RUST_VERSION, "cargo", "--version", "--verbose"]
        check = run([rustup, "run", RUST_VERSION, "rustc", "--version"], capture=True, check=False)
        if check.returncode != 0:
            run([rustup, "toolchain", "install", RUST_VERSION, "--profile", "minimal"], timeout=900)
        rustc_version = output(rustc_command)
        cargo_version = output(cargo_command)
    else:
        rustc_version = optional_output(["rustc", "--version", "--verbose"]) or ""
        cargo_version = optional_output(["cargo", "--version", "--verbose"]) or ""
    if not rustc_version.startswith(f"rustc {RUST_VERSION}"):
        raise ProvenanceError(f"Rust {RUST_VERSION} is required, got {rustc_version.splitlines()[0] if rustc_version else 'unavailable'}")
    if not cargo_version.startswith(f"cargo {RUST_VERSION}"):
        raise ProvenanceError(f"Cargo {RUST_VERSION} is required")

    return {
        "node": {"version": node_version, "binary": "node-v22.21.1-darwin-arm64"},
        "npm": {"version": npm_version, "command": "npm ci"},
        "pnpm": {"required": PNPM_VERSION, "version": pnpm_version, "used": False},
        "rust": {"version": RUST_VERSION, "rustc": rustc_version, "cargo": cargo_version, "used": False},
    }


def host_provenance() -> dict[str, Any]:
    machine = platform.machine()
    if platform.system() != "Darwin":
        raise ProvenanceError("F0.1 requires a Darwin runner")
    if machine != "arm64":
        raise ProvenanceError(f"F0.1 requires arm64, got {machine}")

    sw_product = optional_output(["sw_vers", "-productVersion"]) or "unknown"
    sw_build = optional_output(["sw_vers", "-buildVersion"]) or "unknown"
    xcode = optional_output(["xcodebuild", "-version"]) or "unknown"
    sdk = optional_output(["xcrun", "--sdk", "macosx", "--show-sdk-version"]) or "unknown"
    clang = optional_output(["clang", "--version"]) or "unknown"
    python = optional_output(["python3", "--version"]) or "unknown"
    return {
        "os": {"name": "macOS", "product_version": sw_product, "build": sw_build},
        "architecture": machine,
        "xcode": xcode,
        "macos_sdk": sdk,
        "clang": clang.splitlines()[0],
        "python": python.splitlines()[0],
    }


def http_status(opener: urllib.request.OpenerDirector, url: str) -> tuple[int, int]:
    request = urllib.request.Request(url, headers={"User-Agent": "devhub-f0.1-smoke"})
    try:
        with opener.open(request, timeout=15) as response:
            body = response.read()
            return response.status, len(body)
    except urllib.error.HTTPError as exc:
        body = exc.read()
        return exc.code, len(body)
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, 0


def websocket_handshake(port: int, token: str) -> int:
    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    encoded_token = urllib.parse.quote(token, safe="")
    request = (
        f"GET /?tkn={encoded_token}&skipWebSocketFrames=true HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    with socket.create_connection(("127.0.0.1", port), timeout=15) as connection:
        connection.sendall(request.encode("ascii"))
        response = b""
        while b"\r\n\r\n" not in response and len(response) < 64 * 1024:
            block = connection.recv(4096)
            if not block:
                break
            response += block
    first_line = response.split(b"\r\n", 1)[0].decode("ascii", errors="replace")
    match = re.match(r"HTTP/\d(?:\.\d)?\s+(\d{3})", first_line)
    return int(match.group(1)) if match else 0


def smoke_artifact(artifact: Path, work_root: Path) -> dict[str, Any]:
    entrypoint = artifact / "bin" / "openvscode-server"
    if not entrypoint.is_file():
        raise ProvenanceError("OpenVSCode entrypoint is missing")

    help_root = work_root / "runtime-help"
    help_root.mkdir(parents=True, exist_ok=True)
    help_result = run(
        [
            str(entrypoint),
            "--server-data-dir",
            str(help_root / "server-data"),
            "--user-data-dir",
            str(help_root / "user-data"),
            "--help",
        ],
        cwd=artifact,
        capture=True,
        check=False,
        timeout=60,
    )
    help_text = (help_result.stdout or "") + (help_result.stderr or "")
    if help_result.returncode != 0 or f"OpenVSCode Server {OPENVSCODE_VERSION}" not in help_text:
        raise ProvenanceError("OpenVSCode --help assertion failed")

    runtime_root = work_root / "runtime-smoke"
    runtime_root.mkdir(parents=True, exist_ok=True)
    token_file = runtime_root / "connection-token"
    token = secrets.token_hex(32)
    descriptor = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(descriptor, (token + "\n").encode("ascii"))
    finally:
        os.close(descriptor)
    os.chmod(token_file, 0o600)
    mode = stat.S_IMODE(token_file.stat().st_mode)
    if mode != 0o600:
        raise ProvenanceError("connection token file is not mode 0600")

    folder = runtime_root / "folder"
    folder.mkdir()
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = int(probe.getsockname()[1])
    probe.close()
    base_url = f"http://127.0.0.1:{port}/"
    encoded_token = urllib.parse.quote(token, safe="")
    encoded_folder = urllib.parse.quote(str(folder), safe="")
    server_log = runtime_root / "server.log"
    server_log_handle = server_log.open("w", encoding="utf-8")
    server: subprocess.Popen[str] | None = None
    try:
        server = subprocess.Popen(
            [
                str(entrypoint),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--connection-token-file",
                str(token_file),
                "--accept-server-license-terms",
                "--server-data-dir",
                str(runtime_root / "server-data"),
                "--user-data-dir",
                str(runtime_root / "user-data"),
                "--log",
                "error",
            ],
            cwd=str(artifact),
            stdout=server_log_handle,
            stderr=subprocess.STDOUT,
            text=True,
        )
        unauthenticated = 0
        for _ in range(60):
            unauthenticated, _ = http_status(urllib.request.build_opener(), base_url)
            if unauthenticated == 403:
                break
            if server.poll() is not None:
                raise ProvenanceError("OpenVSCode exited before readiness")
            time.sleep(1)
        if unauthenticated != 403:
            raise ProvenanceError(f"unauthenticated loopback status was {unauthenticated}")

        cookies = CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
        folderless_status, folderless_bytes = http_status(opener, f"{base_url}?ew=true&tkn={encoded_token}")
        folder_status, folder_bytes = http_status(opener, f"{base_url}?folder={encoded_folder}&tkn={encoded_token}")
        if folderless_status != 200 or folderless_bytes == 0:
            raise ProvenanceError(f"authenticated folderless status was {folderless_status}")
        if folder_status != 200 or folder_bytes == 0:
            raise ProvenanceError(f"authenticated folder status was {folder_status}")
        websocket_status = websocket_handshake(port, token)
        if websocket_status != 101:
            raise ProvenanceError(f"WebSocket handshake status was {websocket_status}")
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=15)
        server_log_handle.close()
        shutil.rmtree(runtime_root, ignore_errors=True)

    return {
        "help": "PASS",
        "unauthenticated_http": 403,
        "folderless_authenticated_http": 200,
        "folder_authenticated_http": 200,
        "websocket_handshake_http": 101,
        "bind_host": "127.0.0.1",
        "connection_token_file_mode": "0600",
        "shutdown": "PASS",
        "token_and_response_content": "not recorded",
    }


def artifact_provenance(artifact: Path, source: Path, work_root: Path) -> dict[str, Any]:
    product_path = artifact / "product.json"
    product = json.loads(product_path.read_text(encoding="utf-8"))
    if product.get("version") != OPENVSCODE_VERSION or product.get("commit") != OPENVSCODE_COMMIT:
        raise ProvenanceError("artifact product.json does not match the pinned source")

    bundle_sha, bundle_file_count, bundle_size, manifest = hash_manifest(artifact)
    representative_paths = [
        Path("node"),
        Path("node_modules/node-pty/build/Release/pty.node"),
        Path("node_modules/@parcel/watcher/build/Release/watcher.node"),
    ]
    executable_checks: list[dict[str, Any]] = []
    for relative in representative_paths:
        path = artifact / relative
        if not path.is_file():
            raise ProvenanceError(f"representative artifact executable missing: {relative}")
        is_macho, has_arm64, description = file_kind(path)
        if not is_macho or not has_arm64:
            raise ProvenanceError(f"artifact executable is not Darwin arm64: {relative}")
        executable_checks.append(
            {
                "path": relative.as_posix(),
                "sha256": sha256_file(path),
                "file": description,
                "lipo_architectures": lipo_architectures(path),
            }
        )

    macho_count = 0
    non_arm64_macho: list[str] = []
    native_candidates = [artifact / "node"] + sorted(artifact.rglob("*.node"), key=lambda item: item.relative_to(artifact).as_posix())
    for path in native_candidates:
        if not path.is_file() or path.is_symlink():
            continue
        is_macho, has_arm64, _ = file_kind(path)
        if is_macho:
            macho_count += 1
            if not has_arm64:
                non_arm64_macho.append(path.relative_to(artifact).as_posix())
    if non_arm64_macho:
        raise ProvenanceError("artifact contains Mach-O files without arm64")

    license_files: list[dict[str, Any]] = []
    for path in sorted(artifact.rglob("*"), key=lambda item: item.relative_to(artifact).as_posix()):
        if not path.is_file() or path.is_symlink():
            continue
        if re.search(r"(?:license|licence|notice|copying)", path.name, flags=re.IGNORECASE):
            license_files.append(
                {
                    "path": path.relative_to(artifact).as_posix(),
                    "sha256": sha256_file(path),
                }
            )
    license_manifest_bytes = "\n".join(
        f"{entry['path']}\t{entry['sha256']}" for entry in license_files
    ).encode("utf-8")
    notice_files = []
    for name in ("LICENSE.txt", "ThirdPartyNotices.txt", "cglicenses.json"):
        path = source / name
        if path.is_file():
            notice_files.append({"path": name, "sha256": sha256_file(path)})
    return {
        "root": artifact.name,
        "product": {
            "version": product.get("version"),
            "commit": product.get("commit"),
            "application_name": product.get("applicationName"),
            "darwin_bundle_identifier": product.get("darwinBundleIdentifier"),
        },
        "bundle_sha256": bundle_sha,
        "bundle_file_count": bundle_file_count,
        "bundle_size_bytes": bundle_size,
        "bundle_manifest_sha256": sha256_file(manifest),
        "mach_o_file_count": macho_count,
        "representative_executables": executable_checks,
        "license_inventory": {
            "source_notice_files": notice_files,
            "bundled_license_file_count": len(license_files),
            "bundled_license_manifest_sha256": sha256_bytes(license_manifest_bytes),
        },
    }


def resolve_artifact(work_root: Path) -> Path:
    candidates = [
        path
        for path in work_root.glob("vscode-reh-web-darwin-arm64*")
        if path.is_dir() and (path / "bin" / "openvscode-server").is_file()
    ]
    if not candidates:
        raise ProvenanceError("Darwin arm64 OpenVSCode build output was not found")
    candidates.sort(key=lambda path: (path.name != "vscode-reh-web-darwin-arm64-min-ci", path.name))
    return candidates[0]


def setup_source(work_root: Path) -> Path:
    source = work_root / "source"
    source.parent.mkdir(parents=True, exist_ok=True)
    run(["git", "clone", "--branch", OPENVSCODE_TAG, "--depth", "1", UPSTREAM_REPOSITORY, str(source)])
    return source


def environment_provenance() -> dict[str, Any]:
    environment_kind = os.environ.get("DEVHUB_PROVENANCE_ENV", "local")
    hosted = (
        environment_kind == "github-macos-15"
        and os.environ.get("GITHUB_ACTIONS", "").lower() == "true"
        and platform.system() == "Darwin"
        and platform.machine() == "arm64"
    )
    repository = os.environ.get("GITHUB_REPOSITORY")
    run_id = os.environ.get("GITHUB_RUN_ID")
    run_url = None
    if os.environ.get("GITHUB_SERVER_URL") and repository and run_id:
        run_url = f"{os.environ['GITHUB_SERVER_URL']}/{repository}/actions/runs/{run_id}"
    return {
        "kind": environment_kind,
        "github_actions": os.environ.get("GITHUB_ACTIONS", "").lower() == "true",
        "runner_label": "macos-15" if hosted else None,
        "hosted_gate_proven": hosted,
        "actions_run_url": run_url,
        "actions_run_status": "success" if hosted else None,
        "actions_artifact_digest": os.environ.get("DEVHUB_ACTIONS_ARTIFACT_DIGEST"),
    }


def build(args: argparse.Namespace) -> dict[str, Any]:
    if args.work_root:
        work_root = Path(args.work_root).resolve()
        work_root.mkdir(parents=True, exist_ok=True)
    else:
        work_root = Path(tempfile.mkdtemp(prefix="openvscode-darwin-arm64-"))
    source = setup_source(work_root)
    source_info = source_metadata(source)

    archive = work_root / NODE_ARCHIVE
    if not archive.exists():
        run(["curl", "--fail", "--location", "--retry", "3", "--silent", "--show-error", "--output", str(archive), NODE_URL])
    expected_node_sha = None
    for line in (source / "build" / "checksums" / "nodejs.txt").read_text(encoding="utf-8").splitlines():
        if NODE_ARCHIVE in line:
            expected_node_sha = line.split()[0]
            break
    if not expected_node_sha:
        raise ProvenanceError("Node archive checksum is not pinned by upstream")
    actual_node_sha = sha256_file(archive)
    if actual_node_sha != expected_node_sha:
        raise ProvenanceError("Node archive checksum mismatch")
    run(["tar", "-xzf", str(archive), "-C", str(work_root)])
    node_root = work_root / f"node-v{NODE_VERSION}-darwin-arm64"
    node_bin = node_root / "bin" / "node"
    if not node_bin.is_file():
        raise ProvenanceError("downloaded Node arm64 runtime is missing")

    build_env = os.environ.copy()
    build_env["PATH"] = f"{node_root / 'bin'}{os.pathsep}{build_env.get('PATH', '')}"
    build_env["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
    build_env["ELECTRON_SKIP_BINARY_DOWNLOAD"] = "1"
    build_env["NPM_CONFIG_UPDATE_NOTIFIER"] = "false"
    package_info = node_and_package_provenance(node_bin, build_env, work_root)
    npm = node_root / "bin" / "npm"
    run([str(npm), "ci"], cwd=source, env=build_env)
    run([str(npm), "run", "gulp", "--", BUILD_TASK], cwd=source, env=build_env)
    artifact = resolve_artifact(work_root)
    (work_root / "artifact-root.txt").write_text(artifact.name + "\n", encoding="utf-8")

    host_info = host_provenance()
    artifact_info = artifact_provenance(artifact, source, work_root)
    smoke_info = smoke_artifact(artifact, work_root)
    environment_info = environment_provenance()
    cache_key = os.environ.get("DEVHUB_BUILD_CACHE_KEY")
    cache_info = {
        "enabled": bool(cache_key),
        "restored": os.environ.get("DEVHUB_BUILD_CACHE_RESTORED", "false").lower() == "true",
        "key": cache_key,
        "key_inputs": [
            "runner.os",
            "runner.arch",
            OPENVSCODE_COMMIT,
            NODE_VERSION,
            actual_node_sha,
            source_info["lockfiles_manifest_sha256"],
        ],
        "npm_cache_path": "not recorded",
    }
    status = "PROVEN" if environment_info["hosted_gate_proven"] else "PARTIAL"
    status_reason = (
        "Pinned upstream source build and bounded smoke passed on the hosted GitHub macos-15 arm64 runner."
        if status == "PROVEN"
        else "Source build and smoke passed, but a successful hosted GitHub macos-15 arm64 run is still required."
    )
    ledger = {
        "schema_version": 1,
        "status": status,
        "status_reason": status_reason,
        "captured_at_utc": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "environment": environment_info,
        "source": source_info,
        "build": {
            "command": ["npm ci", f"npm run gulp -- {BUILD_TASK}"],
            "equivalent_fallback_task": FALLBACK_BUILD_TASK,
            "source_modifications": "none; clean upstream clone asserted",
            "node_archive": {"name": NODE_ARCHIVE, "sha256": actual_node_sha, "upstream_expected_sha256": expected_node_sha},
            "cache": cache_info,
            "environment_variables": {
                "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1",
                "ELECTRON_SKIP_BINARY_DOWNLOAD": "1",
                "NPM_CONFIG_UPDATE_NOTIFIER": "false",
            },
        },
        "toolchain": {**package_info, "host": host_info},
        "artifact": artifact_info,
        "smoke": smoke_info,
    }
    return ledger


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-root", help="temporary build root; source and bundle are created below it")
    parser.add_argument(
        "--ledger",
        default="provenance/openvscode-darwin-arm64.json",
        help="content-free JSON ledger path (default: provenance/openvscode-darwin-arm64.json)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        ledger = build(args)
        write_json(Path(args.ledger), ledger)
        print(json.dumps({"status": ledger["status"], "bundle_sha256": ledger["artifact"]["bundle_sha256"]}, sort_keys=True))
        return 0
    except ProvenanceError as exc:
        print(f"F0.1 provenance failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
