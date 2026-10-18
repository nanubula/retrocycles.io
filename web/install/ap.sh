#!/usr/bin/env bash
# Installs the sty+ct+ap dedicated server with the WebRTC DataChannel transport for
# browser clients (branch server) for one unix user, as a systemd service, the way
# the community ap.sh (vixen.international/assets/pub/ap.sh) installs plain sty+ct+ap.
# By default it installs the latest signed release; running it again updates.
#
#   curl -fsSL https://raw.githubusercontent.com/nanubula/retrocycles.io/server/web/install/ap.sh | sudo bash
#   curl -fsSL .../ap.sh | sudo AP_USER=arma bash        # without the question
#   sudo AP_USER=arma bash ap.sh --from-source    # build the branch instead (10-20 minutes)
#
# Environment (all optional):
#   AP_USER     unix user that owns and runs the server (asked for if unset)
#   PREFIX      install prefix, default /home/$AP_USER/armagetronad (versions/, current)
#   RELEASE     release to install, e.g. 0.2.9-sty+ct+ap+io.3; default the latest
#   AUTO_UPDATE on: install new releases daily while the server is empty (default off;
#               only used when /etc/retrocycles-server.conf is first written)
#   BEHIND_PROXY 1 when a local TLS reverse proxy (Caddy, nginx) will front the signalling
#               port: the starter config then pins WEBRTC_SIGNAL_BIND 127.0.0.1. Default 0:
#               signalling on every interface, for Direct Connect by host:port.
# For --from-source (also used on architectures without a release build):
#   GIT_URL     repository to clone, default $DEFAULT_GIT_URL
#   GIT_BRANCH  branch or tag to build, default the tag of RELEASE or of the latest release
#               (the branch server, the public name of this line, if GitHub cannot be asked)
#   LOCAL_SRC   build from this source tree instead of cloning (for testing the script)
#   LDC_VERSION libdatachannel tag, default v0.24.5
#   LDC_COMMIT  the commit LDC_VERSION must be (default: v0.24.5's); empty skips the check
#   JOBS        make -j, default nproc
#
# Ubuntu 22.04 / Debian 12 or newer, with systemd. Needs root for apt and the service;
# the server's files belong to $AP_USER.
set -euo pipefail

DEFAULT_GIT_URL="https://github.com/nanubula/retrocycles.io.git"
GIT_URL="${GIT_URL:-$DEFAULT_GIT_URL}"
GIT_BRANCH="${GIT_BRANCH:-}"
LDC_VERSION="${LDC_VERSION:-v0.24.5}"
# the commit that tag names, checked after the clone (a moved tag stops the install);
# set LDC_COMMIT= (empty) to build another LDC_VERSION unchecked
LDC_COMMIT="${LDC_COMMIT-443f6934d9007eb7076ab7825ba330f355fcbead}"
JOBS="${JOBS:-$(nproc)}"
LOCAL_SRC="${LOCAL_SRC:-}"
RELEASE="${RELEASE:-}"
AUTO_UPDATE="${AUTO_UPDATE:-off}"
# releases and the key that signs them (the same key is in the updater)
RELEASE_API="${RC_RELEASE_API:-https://api.github.com/repos/nanubula/retrocycles.io}"
PUBLIC_KEY="RWSIKpeOYWO+3TDSp+ycEWZ68jvOe8vgRGz2weCXIKYNQorr43zegka+"
CONF=/etc/retrocycles-server.conf
UPDATER=/usr/local/bin/retrocycles-server
# the starter config keeps the default game port; the ports browser players need follow it
SERVER_PORT=4534
BEHIND_PROXY="${BEHIND_PROXY:-0}"
SIGNAL_PORT=$((SERVER_PORT + 1))
ICE_PORT=$((SERVER_PORT + 1000))

FROM_SOURCE=0
for arg in "$@"; do
    case "$arg" in
        --from-source) FROM_SOURCE=1 ;;
        *) echo "unknown option $arg (ap.sh [--from-source])" >&2; exit 2 ;;
    esac
done

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
DATA_DIR="$HOME_DIR/.armagetronad-dedicated"
SRC_DIR="$PREFIX/src"
LDC_PREFIX="$PREFIX/deps/libdatachannel"

case "$(uname -m)" in
    x86_64|amd64) ARCH=x86_64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) ARCH=""
       if [ "$FROM_SOURCE" = 0 ]; then
           echo "== no release build for $(uname -m); building from source."
           FROM_SOURCE=1
       fi ;;
esac

as_user() { sudo -u "$TARGET_USER" -H env HOME="$HOME_DIR" "$@"; }

# first of the given package names this distribution has (Ubuntu 24.04 renamed some to *t64)
pkg() {
    local p
    for p in "$@"; do
        if apt-cache show "$p" >/dev/null 2>&1; then echo "$p"; return 0; fi
    done
    echo "none of the packages $* exists here" >&2
    return 1
}

# the updater's verify_signature, kept the same:
# checks a minisign signature: with minisign where it is installed, else with openssl
# (Ubuntu 22.04 has no minisign package). Ed25519 over the file's BLAKE2b-512 hash ("ED") or
# over the file ("Ed"), plus the global signature over the signature and trusted comment.
verify_signature() { # verify_signature <file> <minisig> <public key>
    if command -v minisign >/dev/null 2>&1; then
        minisign -V -q -P "$3" -m "$1" -x "$2"
        return
    fi
    local t rc=1
    t="$(mktemp -d)"
    if base64 -d <<<"$3" > "$t/pk" 2>/dev/null && sed -n 2p "$2" | base64 -d > "$t/sig" 2>/dev/null &&
        sed -n 4p "$2" | base64 -d > "$t/gsig" 2>/dev/null &&
        [ "$(head -c 2 "$t/pk")" = Ed ] && [ "$(stat -c %s "$t/pk")" = 42 ] && [ "$(stat -c %s "$t/sig")" = 74 ] &&
        [ "$(tail -c +3 "$t/pk" | head -c 8 | od -An -tx1)" = "$(tail -c +3 "$t/sig" | head -c 8 | od -An -tx1)" ]; then
        { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; tail -c 32 "$t/pk"; } > "$t/pk.der"
        tail -c 64 "$t/sig" > "$t/sig.bin"
        case "$(head -c 2 "$t/sig")" in
            ED) openssl dgst -blake2b512 -binary "$1" > "$t/msg" ;;
            Ed) cp "$1" "$t/msg" ;;
            *) : > "$t/msg"; rm -f "$t/sig.bin" ;;
        esac
        { cat "$t/sig.bin"; sed -n 3p "$2" | sed 's/^trusted comment: //' | tr -d '\n'; } > "$t/gmsg" 2>/dev/null
        if [ -s "$t/sig.bin" ] &&
            openssl pkeyutl -verify -pubin -inkey "$t/pk.der" -keyform DER -rawin -in "$t/msg" -sigfile "$t/sig.bin" >/dev/null 2>&1 &&
            openssl pkeyutl -verify -pubin -inkey "$t/pk.der" -keyform DER -rawin -in "$t/gmsg" -sigfile "$t/gsig" >/dev/null 2>&1; then
            rc=0
        fi
    fi
    rm -rf "$t"
    return "$rc"
}

echo "== user: $TARGET_USER, prefix: $PREFIX, $([ "$FROM_SOURCE" = 1 ] && echo "from source" || echo "release ${RELEASE:-latest}")"

# --- packages -----------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update
# the updater's tools (minisign where the distribution has it, else openssl checks the
# signatures) and the server's runtime libraries
MINISIGN="$(pkg minisign 2>/dev/null || echo openssl)"
apt-get install -y --no-install-recommends \
    sudo ca-certificates curl jq openssl "$MINISIGN" \
    libxml2 "$(pkg libzthread-2.3-2 libzthread-2.3-2t64)" "$(pkg libssl3 libssl3t64)" \
    "$(pkg libcurl4 libcurl4t64)"
if [ "$FROM_SOURCE" = 1 ]; then
    apt-get install -y --no-install-recommends \
        git build-essential g++ make automake autoconf autotools-dev libtool \
        pkg-config bison patch bzip2 python3 \
        libxml2-dev libzthread-dev libboost-dev libprotobuf-dev protobuf-compiler \
        cmake ninja-build libssl-dev libcurl4-openssl-dev
fi

as_user mkdir -p "$PREFIX/versions"

if [ "$FROM_SOURCE" = 0 ]; then
    # --- the release ------------------------------------------------------------------
    if [ -n "$RELEASE" ]; then
        TAG="v${RELEASE#v}"
        API_PATH="releases/tags/${TAG//+/%2B}"
    else
        API_PATH="releases/latest"
    fi
    RELEASE_JSON="$(curl -fsSL --max-time 20 -H 'Accept: application/vnd.github+json' "$RELEASE_API/$API_PATH")"
    VERSION="$(jq -r .tag_name <<<"$RELEASE_JSON")"
    VERSION="${VERSION#v}"
    TARBALL="retrocycles-server-$VERSION-linux-$ARCH.tar.gz"
    VERSION_DIR="$PREFIX/versions/$VERSION"
    echo "== release $VERSION"
    DL="$(mktemp -d)"
    trap 'rm -rf "$DL"' EXIT
    for f in "$TARBALL" SHA256SUMS SHA256SUMS.minisig; do
        URL="$(jq -r --arg n "$f" '.assets[] | select(.name == $n) | .browser_download_url' <<<"$RELEASE_JSON")"
        if [ -z "$URL" ]; then
            echo "Release $VERSION has no $f; for this machine use: sudo bash ap.sh --from-source" >&2
            exit 1
        fi
        curl -fsSL --max-time 900 -o "$DL/$f" "$URL"
    done
    if ! verify_signature "$DL/SHA256SUMS" "$DL/SHA256SUMS.minisig" "$PUBLIC_KEY"; then
        echo "SHA256SUMS of $VERSION has no valid signature; stopping." >&2
        exit 1
    fi
    WANT="$(awk -v f="$TARBALL" '$2 == f || $2 == "*" f { print $1 }' "$DL/SHA256SUMS")"
    if [ -z "$WANT" ] || [ "$WANT" != "$(sha256sum "$DL/$TARBALL" | cut -d ' ' -f 1)" ]; then
        echo "$TARBALL does not match the signed SHA256SUMS; stopping." >&2
        exit 1
    fi
    chmod 755 "$DL"
    if [ ! -x "$VERSION_DIR/bin/armagetronad-dedicated" ]; then
        UNPACK="$(as_user mktemp -d "$PREFIX/versions/.unpack.XXXXXX")"
        as_user tar -xzf "$DL/$TARBALL" -C "$UNPACK"
        as_user mv "$UNPACK/${TARBALL%.tar.gz}" "$VERSION_DIR"
        as_user rm -rf "$UNPACK"
    fi
    VERSION_NAME="$VERSION"
else
    # --- libdatachannel (WebRTC) -------------------------------------------------------
    # Built without media, examples and tests into the prefix; the server links with an
    # rpath to it, so nothing needs to be installed system wide.
    as_user mkdir -p "$PREFIX/deps"
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

    # --- sources ----------------------------------------------------------------------
    as_user rm -rf "$SRC_DIR"
    if [ -n "$LOCAL_SRC" ]; then
        echo "== copying sources from $LOCAL_SRC"
        as_user mkdir -p "$SRC_DIR"
        tar -C "$LOCAL_SRC" --exclude=./build --exclude=./.git -cf - . | as_user tar -C "$SRC_DIR" -xf -
    else
        # a release's tag, so the build reports that release's version
        if [ -z "$GIT_BRANCH" ]; then
            if [ -n "$RELEASE" ]; then
                GIT_BRANCH="v${RELEASE#v}"
            elif ! GIT_BRANCH="$(curl -fsSL --max-time 20 -H 'Accept: application/vnd.github+json' \
                    "$RELEASE_API/releases/latest" | jq -er .tag_name)"; then
                GIT_BRANCH=server
            fi
        fi
        echo "== building $GIT_BRANCH of $GIT_URL"
        as_user git clone --depth 1 --branch "$GIT_BRANCH" "$GIT_URL" "$SRC_DIR"
    fi

    # --- build: into its own versions/ directory, next to the releases -----------------
    cd "$SRC_DIR"
    as_user ./bootstrap.sh
    VERSION="$(sed -n 's/^m4_define(AUTOMATIC_VERSION,\[\(.*\)\])$/\1/p' version.m4)"
    VERSION_NAME="source-$(date +%Y%m%d-%H%M%S)"
    VERSION_DIR="$PREFIX/versions/$VERSION_NAME"
    as_user mkdir -p build
    cd build
    as_user ../configure --prefix="$VERSION_DIR" \
        --disable-glout --enable-authentication --with-zthread \
        --disable-sysinstall --disable-useradd --disable-etc --disable-desktop --disable-uninstall \
        --enable-webrtc --enable-platform --with-libdatachannel="$LDC_PREFIX"
    as_user make -j"$JOBS"
    as_user make install
    as_user chmod 755 "$VERSION_DIR/bin"
    as_user install -m 755 "$SRC_DIR/web/release/retrocycles-server" "$VERSION_DIR/bin/retrocycles-server"
    echo "$VERSION" | as_user tee "$VERSION_DIR/VERSION" >/dev/null
fi

# --- the updater and its settings ----------------------------------------------------
install -m 755 "$VERSION_DIR/bin/retrocycles-server" "$UPDATER.new"
mv -f "$UPDATER.new" "$UPDATER"
if [ ! -e "$CONF" ]; then
    cat > "$CONF" <<EOF
# Settings of retrocycles-server, the updater of the Retrocycles dedicated server
# (see HOSTING.md, "Updating"). Written by ap.sh; it keeps your changes when run again.
SERVER_USER=$TARGET_USER
PREFIX=$PREFIX
DATA_DIR=$DATA_DIR
# on: install new releases once a day while nobody is playing (retrocycles-server auto-update on|off)
AUTO_UPDATE=$AUTO_UPDATE
# on: say at start and once a day when a newer release exists (asks api.github.com, nothing else)
UPDATE_CHECK=on
EOF
else
    sed -i -e "s|^SERVER_USER=.*|SERVER_USER=$TARGET_USER|" -e "s|^PREFIX=.*|PREFIX=$PREFIX|" \
        -e "s|^DATA_DIR=.*|DATA_DIR=$DATA_DIR|" "$CONF"
fi

# --- first configuration --------------------------------------------------------------
CFG_DIR="$DATA_DIR"
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
# WebRTC transport for browser clients; see HOSTING.md for the settings.
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

# --- the service: start it, or switch it to this version ---------------------------------
"$UPDATER" install-service
"$UPDATER" switch "$VERSION_NAME"

if [ "$BEHIND_PROXY" = 1 ]; then
    PORT_HINT="$SERVER_PORT/udp (game), $ICE_PORT/udp (browser game traffic, ICE); TCP $SIGNAL_PORT stays on loopback"
    PROXY_HINT="Proxy wss:// to 127.0.0.1:$SIGNAL_PORT with Caddy or nginx (TLS, open 80/443 for it)."
else
    PORT_HINT="$SERVER_PORT/udp (game), $SIGNAL_PORT/tcp (browser signalling, ws://), $ICE_PORT/udp (browser game traffic, ICE)"
    PROXY_HINT="Browser players join by host:port with Direct Connect; a wss:// proxy is optional."
fi
OLD_HINT=""
if [ -x "$PREFIX/bin/armagetronad-dedicated" ]; then
    OLD_HINT="
   Note:     $PREFIX/bin is an older install and no longer used; stop any server started from it."
fi

cat <<EOF

== done. Dedicated server $VERSION with WebRTC transport installed in $PREFIX/current
   service:  systemctl status retrocycles-server   (log: journalctl -u retrocycles-server)
   settings: $CFG_DIR/var/autoexec.cfg (WEBRTC_ENABLE 1 is already set)
   updates:  retrocycles-server status | sudo retrocycles-server update | sudo retrocycles-server auto-update on
   ports:    $PORT_HINT
             (game port $SERVER_PORT, + 1 and + 1000; the server prints them at start: "WebRTC: firewall: ...")
   $PROXY_HINT$OLD_HINT
   Guide:    https://github.com/nanubula/retrocycles.io/blob/server/web/docs/HOSTING.md
EOF
