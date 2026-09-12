# Server installation script
#
# DevHub patch: this script is POSIX sh (dash / BusyBox ash / ksh), not bash.
# It is piped into `sh -l` on the remote host, and plenty of hosts DevHub is
# expected to reach have no bash at all -- a NAS whose /bin/sh is BusyBox,
# for one, where the unpatched script died with `sh: bash: not found`
# before printing a single marker, so the extension could only report "Failed
# parsing install script output". Every construct below is one the POSIX shell
# command language defines: the `test` builtin rather than bash's conditional
# keyword, `cd` rather than a directory stack, a counted `while` rather than a
# brace range, an explicit `>file 2>&1` rather than bash's combining redirect,
# and no arrays. `local` is not used anywhere, so the question of which shells
# have it does not arise.
#
# The lines print_install_results_and_exit writes are the extension's parse
# format and are unchanged, byte for byte.

TMP_DIR="${XDG_RUNTIME_DIR:-"/tmp"}"

DISTRO_VERSION="%%DISTRO_VERSION%%"
DISTRO_COMMIT="%%DISTRO_COMMIT%%"
DISTRO_QUALITY="%%DISTRO_QUALITY%%"
DISTRO_VSCODIUM_RELEASE="%%DISTRO_VSCODIUM_RELEASE%%"

SERVER_APP_NAME="%%SERVER_APP_NAME%%"
SERVER_INITIAL_EXTENSIONS="%%SERVER_INITIAL_EXTENSIONS%%"
SERVER_LISTEN_FLAG="%%SERVER_LISTEN_FLAG%%"
SERVER_DATA_DIR="%%SERVER_DATA_DIR%%"
SERVER_DATA_DIR_FLAG="%%SERVER_DATA_DIR_FLAG%%"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_LOGFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.log"
SERVER_PIDFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.pid"
SERVER_TOKENFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.token"
SERVER_ARCH=
SERVER_CONNECTION_TOKEN=
SERVER_DOWNLOAD_URL=
SERVER_VALIDATION_FLAG="%%SERVER_VALIDATION_FLAG%%"

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=

# Mimic output from logs of remote-ssh extension
print_install_results_and_exit() {
  echo "%%SCRIPT_ID%%: start"
  echo "exitCode==$1=="
  echo "listeningOn==$LISTENING_ON=="
  echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
  echo "logFile==$SERVER_LOGFILE=="
  echo "osReleaseId==$OS_RELEASE_ID=="
  echo "arch==$ARCH=="
  echo "platform==$PLATFORM=="
  echo "tmpDir==$TMP_DIR=="
%%ENV_VAR_LINES%%
  echo "%%SCRIPT_ID%%: end"
  exit 0
}

LOCKFILE="$TMP_DIR/server_install.lock"

if command -v flock >/dev/null 2>&1; then
  # Automatic file descriptor allocation ({FD}) requires bash >= 4.1,
  # and macOS still ships bash 3.2, so use a fixed descriptor instead.
  FD=9
  exec 9<>"$LOCKFILE"

  if flock --help 2>&1 | grep -q -- '-w'; then
    # wait 30s to acquire lock, otherwise fail
    flock -x -w 30 $FD || print_install_results_and_exit 1
  else
    ELAPSED=0

    while [ "$ELAPSED" -lt 30 ]; do
        if flock -n -x $FD; then
            break
        fi

        sleep 1

        ELAPSED=$((ELAPSED + 1))
    done

    if [ "$ELAPSED" -ge 30 ]; then
      echo "Warning: flock cannot acquire the install lock"
      print_install_results_and_exit 1
    fi
  fi

  trap "flock -u $FD; trap - EXIT INT HUP; exit" EXIT INT HUP
else
  echo "Warning: flock not available, skipping install lock"
fi

# Check if platform is supported
if ! command -v uname >/dev/null 2>&1; then
  echo "Error: 'uname' command not found, could not get platform/arch data."
  print_install_results_and_exit 1
fi

KERNEL="$(uname -s)"
case $KERNEL in
  Darwin)
    PLATFORM="darwin"
    ;;
  Linux)
    PLATFORM="linux"
    ;;
  FreeBSD)
    PLATFORM="freebsd"
    ;;
  DragonFly)
    PLATFORM="dragonfly"
    ;;
  "")
    echo "Error: uname -s yields empty result"
    print_install_results_and_exit 1
    ;;
  *)
    echo "Error: platform not supported: $KERNEL"
    print_install_results_and_exit 1
    ;;
esac

# Check machine architecture
ARCH="$(uname -m)"
case $ARCH in
  x86_64 | amd64)
    SERVER_ARCH="x64"
    ;;
  armv7l | armv8l)
    SERVER_ARCH="armhf"
    ;;
  arm64 | aarch64)
    SERVER_ARCH="arm64"
    ;;
  ppc64le)
    SERVER_ARCH="ppc64le"
    ;;
  riscv64)
    SERVER_ARCH="riscv64"
    ;;
  loongarch64)
    SERVER_ARCH="loong64"
    ;;
  s390x)
    SERVER_ARCH="s390x"
    ;;
  *)
    echo "Error: architecture not supported: $ARCH"
    print_install_results_and_exit 1
    ;;
esac

# https://www.freedesktop.org/software/systemd/man/os-release.html
OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
if [ -z "$OS_RELEASE_ID" ]; then
  OS_RELEASE_ID="$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
  if [ -z "$OS_RELEASE_ID" ]; then
    OS_RELEASE_ID="unknown"
  fi
fi

# Create installation folder
if [ ! -d "$SERVER_DIR" ]; then
  if ! mkdir -p "$SERVER_DIR"; then
    echo "Error: creating server install directory"
    print_install_results_and_exit 1
  fi
fi

# adjust platform for vscodium download, if needed
if [ "$OS_RELEASE_ID" = alpine ]; then
  PLATFORM=$OS_RELEASE_ID
fi

SERVER_DOWNLOAD_URL="$(echo "%%SERVER_DOWNLOAD_URL_TEMPLATE%%" | sed "s/\${quality}/$DISTRO_QUALITY/g" | sed "s/\${version}/$DISTRO_VERSION/g" | sed "s/\${commit}/$DISTRO_COMMIT/g" | sed "s/\${os}/$PLATFORM/g" | sed "s/\${arch}/$SERVER_ARCH/g" | sed "s/\${release}/$DISTRO_VSCODIUM_RELEASE/g")"

# Check if server script is already installed
if [ ! -f "$SERVER_SCRIPT" ]; then
  case "$PLATFORM" in
    darwin | linux | alpine | freebsd )
      ;;
    *)
      echo "Error: '$PLATFORM' needs manual installation of remote extension host"
      print_install_results_and_exit 1
      ;;
  esac

  # A directory stack is a bash builtin. The download and extract below are
  # the only thing that needs the install directory as its working directory,
  # so remember where we were and go back by hand.
  SERVER_DIR_PREVIOUS_PWD="$(pwd)"
  if ! cd "$SERVER_DIR"; then
    echo "Error: cannot enter server install directory $SERVER_DIR"
    print_install_results_and_exit 1
  fi

  DOWNLOAD_OK=0
  if command -v wget >/dev/null 2>&1; then
    wget --tries=3 --timeout=10 --continue --no-verbose -O vscode-server.tar.gz "$SERVER_DOWNLOAD_URL" && DOWNLOAD_OK=1
  elif command -v curl >/dev/null 2>&1; then
    curl --retry 3 --connect-timeout 10 --location --show-error --silent --output vscode-server.tar.gz "$SERVER_DOWNLOAD_URL" && DOWNLOAD_OK=1
  elif command -v fetch >/dev/null 2>&1; then
    fetch --retry --timeout=10 --quiet --output=vscode-server.tar.gz "$SERVER_DOWNLOAD_URL" && DOWNLOAD_OK=1
  else
    echo "Error: no tool to download server binary"
    print_install_results_and_exit 1
  fi

  if [ "$DOWNLOAD_OK" -ne 1 ]; then
    echo "Error downloading server from $SERVER_DOWNLOAD_URL"
    rm -rf vscode-server.tar.gz
    print_install_results_and_exit 1
  fi

  if ! tar -xOf vscode-server.tar.gz >/dev/null 2>&1; then
    echo "Error downloaded tarball is corrupt or incomplete"
    rm -rf vscode-server.tar.gz
    print_install_results_and_exit 1
  fi

  if ! tar -xf vscode-server.tar.gz --strip-components 1; then
    echo "Error while extracting server contents"
    rm -rf vscode-server.tar.gz
    print_install_results_and_exit 1
  fi

  if [ ! -f "$SERVER_SCRIPT" ] || [ ! -s "$SERVER_SCRIPT" ]; then
    rm -rf "$SERVER_DIR"/*
    echo "Error: server contents are corrupted"
    print_install_results_and_exit 1
  fi

  rm -f vscode-server.tar.gz

  cd "$SERVER_DIR_PREVIOUS_PWD" || true
else
  echo "Server script already installed in $SERVER_SCRIPT"
fi

# Modify the commit in the remote server to match the local value
if %%MODIFY_PRODUCT_JSON%%; then
  if command -v sed >/dev/null 2>&1; then
    echo "Will modify product.json on remote to match the commit value"
    sed -i -E 's/"commit": "[0-9a-f]+",/"commit": "'"$DISTRO_COMMIT"'",/' "$SERVER_DIR/product.json";
  else
    echo "Cannot find the 'sed' command, make sure it is installed to modify product.json with the matching commit."
  fi
fi

# Try to find if server is already running.
#
# Upstream asked `ps -p "$(cat $SERVER_PIDFILE)"` when a pid file was there and
# `ps -A` otherwise. BusyBox `ps` accepts neither `-p` nor `-A` -- it lists
# every process and ignores the rest -- so on such a host the pid-file branch
# printed a usage error, found nothing, and started a second extension host on
# every resolve. One branch for both cases: scan the full table for the server
# script, which is what upstream's fallback already did and what BusyBox gives
# us anyway.
SERVER_RUNNING_PROCESS="$(ps -o pid,args -A 2>/dev/null | grep "$SERVER_SCRIPT" | grep -v grep)"

if [ -z "$SERVER_RUNNING_PROCESS" ]; then
  if [ -f "$SERVER_LOGFILE" ]; then
    rm "$SERVER_LOGFILE"
  fi
  if [ -f "$SERVER_TOKENFILE" ]; then
    rm "$SERVER_TOKENFILE"
  fi

  touch "$SERVER_TOKENFILE"
  chmod 600 "$SERVER_TOKENFILE"
  SERVER_CONNECTION_TOKEN="%%SERVER_CONNECTION_TOKEN%%"
  echo $SERVER_CONNECTION_TOKEN > "$SERVER_TOKENFILE"

  $SERVER_SCRIPT --start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_DATA_DIR_FLAG $SERVER_VALIDATION_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file "$SERVER_TOKENFILE" --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms > "$SERVER_LOGFILE" 2>&1 &
  echo $! > "$SERVER_PIDFILE"
else
  echo "Server script is already running $SERVER_SCRIPT"
fi

if [ -f "$SERVER_TOKENFILE" ]; then
  SERVER_CONNECTION_TOKEN="$(cat "$SERVER_TOKENFILE")"
else
  echo "Error: server token file not found $SERVER_TOKENFILE"
  print_install_results_and_exit 1
fi

# `sleep` with a fractional argument is a GNU/BusyBox extension, not POSIX.
# Ask once: where it is refused, wait a whole second instead, which trades a
# slower resolve for a resolve that happens at all.
SERVER_POLL_SLEEP=0.5
if ! sleep 0.5 >/dev/null 2>&1; then
  SERVER_POLL_SLEEP=1
fi

if [ -f "$SERVER_LOGFILE" ]; then
  POLLS_LEFT=35
  while [ "$POLLS_LEFT" -gt 0 ]; do
    if [ -n "$(grep 'Error loading shared library libstdc++.so' "$SERVER_LOGFILE")" ]; then
      echo "Error: missing libstdc++"
      break
    fi

    LISTENING_ON="$(grep -E 'Extension host agent listening on .+' "$SERVER_LOGFILE" | sed 's/Extension host agent listening on //')"
    if [ -n "$LISTENING_ON" ]; then
      break
    fi

    sleep "$SERVER_POLL_SLEEP"

    POLLS_LEFT=$((POLLS_LEFT - 1))
  done

  if [ -z "$LISTENING_ON" ]; then
    echo "Error: server did not start successfully"
    print_install_results_and_exit 1
  fi
else
  echo "Error: server log file not found $SERVER_LOGFILE"
  print_install_results_and_exit 1
fi

# Finish server setup
print_install_results_and_exit 0
