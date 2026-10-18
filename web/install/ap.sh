#!/usr/bin/env bash
# Installs the sty+ct+ap dedicated server with the WebRTC DataChannel transport for
# browser clients (branch server) into a user's home directory, the way the
# community ap.sh (vixen.international/assets/pub/ap.sh) installs plain sty+ct+ap.
#
#   curl -fsSL https://raw.githubusercontent.com/nanubula/retrocycles.io/server/web/install/ap.sh | sudo bash
#   curl -fsSL .../ap.sh | sudo AP_USER=arma bash      # without the question
#
# Environment (all optional):
#   AP_USER     unix user that owns and runs the server (asked for if unset)
#   PREFIX      install prefix, default /home/$AP_USER/armagetronad
#   GIT_URL     repository to clone, default $DEFAULT_GIT_URL
#   GIT_BRANCH  branch to build, default server
#   LOCAL_SRC   build from this source tree instead of cloning (for testing the script)
#   LDC_VERSION libdatachannel tag, default v0.24.5
#   LDC_COMMIT  the commit LDC_VERSION must be (default: v0.24.5's); empty skips the check
#   JOBS        make -j, default nproc
#   BEHIND_PROXY 1 when a local TLS reverse proxy (Caddy, nginx) will front the signalling
#               port: the starter config then pins WEBRTC_SIGNAL_BIND 127.0.0.1. Default 0:
#               signalling on every interface, for Direct Connect by host:port.
#
# Ubuntu 22.04 / Debian 12 or newer. Needs root for apt; everything else runs as $AP_USER.
set -euo pipefail

DEFAULT_GIT_URL="https://github.com/nanubula/retrocycles.io.git"
GIT_URL="${GIT_URL:-$DEFAULT_GIT_URL}"
GIT_BRANCH="${GIT_BRANCH:-server}"
LDC_VERSION="${LDC_VERSION:-v0.24.5}"
# the commit that tag names, checked after the clone (a moved tag stops the install);
# set LDC_COMMIT= (empty) to build another LDC_VERSION unchecked
LDC_COMMIT="${LDC_COMMIT-443f6934d9007eb7076ab7825ba330f355fcbead}"
JOBS="${JOBS:-$(nproc)}"
LOCAL_SRC="${LOCAL_SRC:-}"
# the starter config keeps the default game port; the ports browser players need follow it
SERVER_PORT=4534
BEHIND_PROXY="${BEHIND_PROXY:-0}"
SIGNAL_PORT=$((SERVER_PORT + 1))
ICE_PORT=$((SERVER_PORT + 1000))

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script as root (sudo); it installs packages with apt." >&2
    exit 1
fi

TARGET_USER="${AP_USER:-}"
if [ -z "$TARGET_USER" ]; then
    # from the terminal: under "curl ... | sudo bash" stdin is the script itself
    read -r -p "Unix user that will own and run the server: " TARGET_USER </dev/tty
fi
if ! id "$TARGET_USER" >/dev/null 2>&1; then
    echo "User '$TARGET_USER' does not exist; create it first (adduser $TARGET_USER)." >&2
    exit 1
fi
HOME_DIR="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
PREFIX="${PREFIX:-$HOME_DIR/armagetronad}"
SRC_DIR="$PREFIX/src"
LDC_PREFIX="$PREFIX/deps/libdatachannel"

echo "== user: $TARGET_USER, prefix: $PREFIX, branch: $GIT_BRANCH"

# --- packages -----------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
    sudo git ca-certificates build-essential g++ make automake autoconf autotools-dev libtool \
    pkg-config bison patch bzip2 python3 \
    libxml2-dev libzthread-dev libboost-dev libprotobuf-dev protobuf-compiler \
    cmake ninja-build libssl-dev

as_user() { sudo -u "$TARGET_USER" -H env HOME="$HOME_DIR" "$@"; }

as_user mkdir -p "$PREFIX/deps"

# --- libdatachannel (WebRTC) -------------------------------------------------------
# Built without media, examples and tests into the prefix; the server links with an
# rpath to it, so nothing needs to be installed system wide.
if [ ! -e "$LDC_PREFIX/lib/libdatachannel.so" ]; then
    LDC_SRC="$PREFIX/deps/libdatachannel-src"
    as_user rm -rf "$LDC_SRC"
    as_user git clone --depth 1 --branch "$LDC_VERSION" --recursive \
        https://github.com/paullouisageneau/libdatachannel.git "$LDC_SRC"
    # the submodules are pinned by that commit
    if [ -n "$LDC_COMMIT" ] && [ "$(as_user git -C "$LDC_SRC" rev-parse HEAD)" != "$LDC_COMMIT" ]; then
        echo "libdatachannel $LDC_VERSION is not commit $LDC_COMMIT; stopping." >&2
        exit 1
    fi
    as_user cmake -S "$LDC_SRC" -B "$LDC_SRC/build" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$LDC_PREFIX" \
        -DNO_MEDIA=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON
    as_user cmake --build "$LDC_SRC/build" -j "$JOBS"
    as_user cmake --install "$LDC_SRC/build"
    as_user rm -rf "$LDC_SRC"
fi

# --- sources ------------------------------------------------------------------------
as_user rm -rf "$SRC_DIR"
if [ -n "$LOCAL_SRC" ]; then
    echo "== copying sources from $LOCAL_SRC"
    as_user mkdir -p "$SRC_DIR"
    tar -C "$LOCAL_SRC" --exclude=./build --exclude=./.git -cf - . | as_user tar -C "$SRC_DIR" -xf -
else
    as_user git clone --depth 1 --branch "$GIT_BRANCH" "$GIT_URL" "$SRC_DIR"
fi

# --- build --------------------------------------------------------------------------
cd "$SRC_DIR"
as_user ./bootstrap.sh
as_user mkdir -p build
cd build
as_user ../configure --prefix="$PREFIX" \
    --disable-glout --enable-authentication --with-zthread \
    --disable-sysinstall --disable-useradd --disable-etc --disable-desktop --disable-uninstall \
    --enable-webrtc --with-libdatachannel="$LDC_PREFIX"
as_user make -j"$JOBS"
as_user make install
as_user chmod 755 "$PREFIX/bin"

# --- first configuration --------------------------------------------------------------
CFG_DIR="$HOME_DIR/.armagetronad-dedicated"
as_user mkdir -p "$CFG_DIR/var"
if [ "$BEHIND_PROXY" = 1 ]; then
    BIND_LINES="# signalling WebSocket, plain ws:// on TCP $SIGNAL_PORT (SERVER_PORT + 1);
# only the local TLS reverse proxy in front of it may reach it (wss://)
WEBRTC_SIGNAL_BIND 127.0.0.1
# WEBRTC_SIGNAL_PORT $SIGNAL_PORT"
else
    BIND_LINES="# signalling WebSocket, plain ws:// on TCP $SIGNAL_PORT (SERVER_PORT + 1), on every
# interface (the default), so browser players can join by host:port with Direct Connect;
# set 127.0.0.1 when only a local TLS reverse proxy (Caddy, nginx) should reach it
# WEBRTC_SIGNAL_BIND 127.0.0.1
# WEBRTC_SIGNAL_PORT $SIGNAL_PORT"
fi
if [ ! -e "$CFG_DIR/var/autoexec.cfg" ]; then
    as_user tee "$CFG_DIR/var/autoexec.cfg" >/dev/null <<EOF
# WebRTC transport for browser clients; see $SRC_DIR/web/docs/HOSTING.md for the settings.
WEBRTC_ENABLE 1
$BIND_LINES
# ICE (browser game traffic): by default one UDP port shared by all browser players,
# SERVER_PORT + 1000 (UDP $ICE_PORT); open it in the firewall. A range gives each player
# its own port from it instead.
# WEBRTC_PORT_MIN 50000
# WEBRTC_PORT_MAX 50100
# public IPv4 for hosts behind 1:1 NAT or a port forward
# WEBRTC_PUBLIC_IP 203.0.113.1
EOF
fi

if [ "$BEHIND_PROXY" = 1 ]; then
    PORT_HINT="$SERVER_PORT/udp (game), $ICE_PORT/udp (browser game traffic, ICE); TCP $SIGNAL_PORT stays on loopback"
    PROXY_HINT="Proxy wss:// to 127.0.0.1:$SIGNAL_PORT with Caddy or nginx (TLS, open 80/443 for it)."
else
    PORT_HINT="$SERVER_PORT/udp (game), $SIGNAL_PORT/tcp (browser signalling, ws://), $ICE_PORT/udp (browser game traffic, ICE)"
    PROXY_HINT="Browser players join by host:port with Direct Connect; a wss:// proxy is optional."
fi

cat <<EOF

== done. Dedicated server with WebRTC transport installed in $PREFIX
   binary:   $PREFIX/bin/armagetronad-dedicated
   settings: $CFG_DIR/var/autoexec.cfg (WEBRTC_ENABLE 1 is already set)
   start:    sudo -u $TARGET_USER $PREFIX/bin/armagetronad-dedicated --daemon
   ports:    $PORT_HINT
             (game port $SERVER_PORT, + 1 and + 1000; the server prints them at start: "WebRTC: firewall: ...")
   $PROXY_HINT
   Guide:    $SRC_DIR/web/docs/HOSTING.md
EOF
