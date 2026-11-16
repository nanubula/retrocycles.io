#!/usr/bin/env bash
# Builds the release tarball of the dedicated server with browser support:
#   retrocycles-server-<version>-linux-<arch>.tar.gz and SHA256SUMS
# in an Ubuntu 22.04 container (glibc 2.35, so it runs on Ubuntu 22.04 / Debian 12 and newer),
# for the architecture of the machine running Docker (x86_64 or arm64).
#
#   web/release/build-tarball.sh [--out DIR] [--ref GIT_REF]     # from the repository root
#
# Environment (all optional):
#   RELEASE_TAG  v<major_version>.<N>, e.g. v0.2.9-sty+ct+ap+io.1: the version of a release
#                build (batch/make/version). Unset: a dev build with a dev version.
#   BUILD_IMAGE  build image, default ubuntu:22.04
#   JOBS         make -j, default the container's nproc
#
# The sources are `git archive` of GIT_REF (default: HEAD plus uncommitted changes to tracked
# files), so line endings are the repository's even on a Windows checkout. The tarball holds a
# relocatable install (bin/, lib/, share/, etc/): libdatachannel is bundled in lib/ and the
# binary finds it through an $ORIGIN rpath. libxml2 is linked in statically, because the
# distributions ship different sonames (libxml2.so.2 on Ubuntu 24.04 and Debian 13,
# libxml2.so.16 on Ubuntu 26.04). Runtime packages on the target (Debian/Ubuntu):
#   libzthread-2.3-2 libssl3 libcurl4 ca-certificates
# (t64 names on Ubuntu 24.04, Debian 13 and newer: libzthread-2.3-2t64 libssl3t64 libcurl4t64).
set -euo pipefail

LDC_VERSION="${LDC_VERSION:-v0.24.5}"
# the commit that tag names; a moved tag stops the build
LDC_COMMIT="${LDC_COMMIT:-443f6934d9007eb7076ab7825ba330f355fcbead}"

# libxml2, static. 2.14 is the last series with the HTTP client (xmlNanoHTTP), which the
# server uses for authentication and resource downloads; 2.15 removed it.
# The sum is from download.gnome.org (libxml2-<version>.sha256sum).
LIBXML2_VERSION="2.14.6"
LIBXML2_SHA256="7ce458a0affeb83f0b55f1f4f9e0e55735dbfc1a9de124ee86fb4a66b597203a"

# configure flags of the release; web/docker/server.Dockerfile uses the same
CONFIGURE_FLAGS=(
    --disable-glout --enable-authentication --with-zthread
    --disable-sysinstall --disable-useradd --disable-etc --disable-desktop --disable-uninstall
    --enable-webrtc --enable-platform --enable-binreloc
)

# --- inside the build container ----------------------------------------------------------
in_container() {
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
        autoconf automake libtool pkg-config bison patch bzip2 xz-utils make g++ python3 git \
        ca-certificates curl libzthread-dev libboost-dev libprotobuf-dev protobuf-compiler \
        cmake ninja-build libssl-dev libcurl4-openssl-dev patchelf
    local jobs="${JOBS:-$(nproc)}"

    # libxml2, static only, with the HTTP client; no Python, ICU, zlib or lzma (the server
    # reads plain map files and DTDs)
    local xml_series="${LIBXML2_VERSION%.*}"
    curl -fsSL -o /tmp/libxml2.tar.xz \
        "https://download.gnome.org/sources/libxml2/$xml_series/libxml2-$LIBXML2_VERSION.tar.xz"
    if ! echo "$LIBXML2_SHA256  /tmp/libxml2.tar.xz" | sha256sum -c -; then
        echo "libxml2 $LIBXML2_VERSION does not match its sum; stopping." >&2
        exit 1
    fi
    tar -C /tmp -xJf /tmp/libxml2.tar.xz
    (cd "/tmp/libxml2-$LIBXML2_VERSION" &&
        ./configure --prefix=/opt/libxml2 --disable-shared --enable-static --with-pic \
            --with-http --without-python --without-icu --without-zlib --without-lzma \
            --without-readline --without-history &&
        make -j"$jobs" && make install)

    # libdatachannel, DataChannel + WebSocket only
    git clone --depth 1 --branch "$LDC_VERSION" --recursive \
        https://github.com/paullouisageneau/libdatachannel.git /tmp/libdatachannel
    if [ "$(git -C /tmp/libdatachannel rev-parse HEAD)" != "$LDC_COMMIT" ]; then
        echo "libdatachannel $LDC_VERSION is not commit $LDC_COMMIT; stopping." >&2
        exit 1
    fi
    cmake -S /tmp/libdatachannel -B /tmp/libdatachannel/build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/libdatachannel \
        -DNO_MEDIA=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON
    cmake --build /tmp/libdatachannel/build -j "$jobs"
    cmake --install /tmp/libdatachannel/build

    cd /src
    ./bootstrap.sh
    local version
    version="$(sed -n 's/^m4_define(AUTOMATIC_VERSION,\[\(.*\)\])$/\1/p' version.m4)"
    if [ -n "${RELEASE_TAG:-}" ] && [ "v$version" != "$RELEASE_TAG" ]; then
        echo "version $version does not match RELEASE_TAG $RELEASE_TAG; stopping." >&2
        exit 1
    fi
    local arch
    case "$(uname -m)" in
        x86_64) arch=x86_64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) arch="$(uname -m)" ;;
    esac
    local name="retrocycles-server-$version-linux-$arch"
    local prefix="/opt/$name"

    mkdir -p /build && cd /build
    # configure finds libxml2 by pkg-config; the static library needs its private libs too
    local xml_pc=/opt/libxml2/lib/pkgconfig
    /src/configure --prefix="$prefix" "${CONFIGURE_FLAGS[@]}" \
        --with-libdatachannel=/opt/libdatachannel \
        PKG_CONFIG_PATH="$xml_pc" \
        XML2_CFLAGS="$(PKG_CONFIG_PATH="$xml_pc" pkg-config --cflags libxml-2.0)" \
        XML2_LIBS="$(PKG_CONFIG_PATH="$xml_pc" pkg-config --static --libs libxml-2.0)"
    make -j"$jobs"
    make install-strip
    if readelf -d "$prefix/bin/armagetronad-dedicated" | grep -F NEEDED | grep -q libxml2; then
        readelf -d "$prefix/bin/armagetronad-dedicated" | grep -F NEEDED
        echo "the server links libxml2 dynamically; stopping." >&2
        exit 1
    fi

    # bundle libdatachannel next to the binary
    mkdir -p "$prefix/lib"
    cp -a /opt/libdatachannel/lib/libdatachannel.so* "$prefix/lib/"
    strip --strip-unneeded "$prefix"/lib/libdatachannel.so.*.*
    # shellcheck disable=SC2016 # $ORIGIN is for the dynamic loader
    patchelf --set-rpath '$ORIGIN/../lib' "$prefix/bin/armagetronad-dedicated"

    # the updater, the guide, the licence
    install -m 755 /src/web/release/retrocycles-server "$prefix/bin/retrocycles-server"
    mkdir -p "$prefix/share/doc/retrocycles-server"
    cp /src/web/docs/HOSTING.md /src/COPYING.txt "$prefix/share/doc/retrocycles-server/"
    echo "$version" > "$prefix/VERSION"

    # it must start from anywhere: move it, then ask its version
    mv "$prefix" "/tmp/$name"
    if ! /tmp/"$name"/bin/armagetronad-dedicated --version | grep -F "$version"; then
        echo "the built server does not run or report $version; stopping." >&2
        /tmp/"$name"/bin/armagetronad-dedicated --version || true
        exit 1
    fi
    if ldd /tmp/"$name"/bin/armagetronad-dedicated | grep -q "not found"; then
        ldd /tmp/"$name"/bin/armagetronad-dedicated
        exit 1
    fi

    mkdir -p /out
    tar -C /tmp --sort=name --owner=0 --group=0 --numeric-owner \
        -czf "/out/$name.tar.gz" "$name"
    (cd /out && sha256sum "$name.tar.gz" > SHA256SUMS)
    cat /out/SHA256SUMS
}

if [ "${1:-}" = "--in-container" ]; then
    in_container
    exit 0
fi

# --- on the host: run the above in a fresh container --------------------------------------
OUT=dist
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --out) OUT="$2"; shift 2 ;;
        --ref) REF="$2"; shift 2 ;;
        *) echo "usage: $0 [--out DIR] [--ref GIT_REF]" >&2; exit 2 ;;
    esac
done
cd "$(git rev-parse --show-toplevel)"
if [ -z "$REF" ]; then
    REF="$(git stash create)"
    REF="${REF:-HEAD}"
fi
mkdir -p "$OUT"
# Git Bash on Windows: hand docker container paths unchanged and the output dir in its own form
export MSYS_NO_PATHCONV=1
OUT_HOST="$OUT"
if command -v cygpath >/dev/null 2>&1; then OUT_HOST="$(cygpath -w "$OUT")"; fi

cid="$(docker create -e RELEASE_TAG="${RELEASE_TAG:-}" -e JOBS="${JOBS:-}" \
    "${BUILD_IMAGE:-ubuntu:22.04}" bash /src/web/release/build-tarball.sh --in-container)"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
git -c core.autocrlf=false archive --format=tar --prefix=src/ "$REF" | docker cp - "$cid:/"
docker start -a "$cid"
docker cp "$cid:/out/." "$OUT_HOST"
echo "== $OUT:"
ls -l "$OUT"
