# sty+ct+ap dedicated server with the WebRTC DataChannel transport (branch server).
# Build from the repository root:
#   docker build -f web/docker/server.Dockerfile -t aa-server-styctap .
# A release image is built from the release tag, which names the version:
#   docker build --build-arg RELEASE_TAG=v0.2.9-sty+ct+ap+io.1 -f web/docker/server.Dockerfile .
# Released images: ghcr.io/nanubula/retrocycles-server:<version> and :latest.
# Run (web/docs/HOSTING.md has the ports and the networking notes):
#   docker run -d --name aa -p 4534:4534/udp -p 4535:4535/tcp -p 50000-50100:50000-50100/udp \
#       -e WEBRTC_PUBLIC_IP=<host ip> -v aa-data:/data aa-server-styctap
ARG BASE=ubuntu:22.04

########################################
FROM ${BASE} AS builder
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf automake libtool pkg-config bison patch bzip2 make g++ python3 git ca-certificates \
    libxml2-dev libzthread-dev libboost-dev libprotobuf-dev protobuf-compiler \
    cmake ninja-build libssl-dev libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

# libdatachannel, DataChannel + WebSocket only
ARG LDC_VERSION=v0.24.5
# the commit that tag names (a moved tag stops the build); empty skips the check
ARG LDC_COMMIT=443f6934d9007eb7076ab7825ba330f355fcbead
RUN git clone --depth 1 --branch ${LDC_VERSION} --recursive \
        https://github.com/paullouisageneau/libdatachannel.git /tmp/libdatachannel \
    && { [ -z "${LDC_COMMIT}" ] || [ "$(git -C /tmp/libdatachannel rev-parse HEAD)" = "${LDC_COMMIT}" ]; } \
    && cmake -S /tmp/libdatachannel -B /tmp/libdatachannel/build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/libdatachannel \
        -DNO_MEDIA=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON \
    && cmake --build /tmp/libdatachannel/build \
    && cmake --install /tmp/libdatachannel/build \
    && rm -rf /tmp/libdatachannel

COPY . /src
WORKDIR /src
# empty: a dev build; v<major_version>.<N>: that release, which the build checks it got
ARG RELEASE_TAG=
# the configure flags are those of the release tarballs (web/release/build-tarball.sh)
RUN RELEASE_TAG="${RELEASE_TAG}" ./bootstrap.sh \
    && version="$(sed -n 's/^m4_define(AUTOMATIC_VERSION,\[\(.*\)\])$/\1/p' version.m4)" \
    && { [ -z "${RELEASE_TAG}" ] || [ "v${version}" = "${RELEASE_TAG}" ]; } \
    && mkdir -p /build && cd /build \
    && /src/configure --prefix=/opt/armagetronad \
        --disable-glout --enable-authentication --with-zthread \
        --disable-sysinstall --disable-useradd --disable-etc --disable-desktop --disable-uninstall \
        --enable-webrtc --enable-platform --with-libdatachannel=/opt/libdatachannel \
    && make -j"$(nproc)" && make install

########################################
FROM ${BASE} AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2 libzthread-2.3-2 libssl3 libcurl4 ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /opt/libdatachannel/lib /opt/libdatachannel/lib
COPY --from=builder /opt/armagetronad /opt/armagetronad
COPY web/docker/server-entrypoint.sh /usr/local/bin/server-entrypoint.sh
RUN chmod 755 /usr/local/bin/server-entrypoint.sh && mkdir -p /data && chown nobody:nogroup /data

# /data/var holds autoexec.cfg, logs, ladder and scores; mount it to keep them.
VOLUME ["/data"]
# game (UDP), WebRTC signalling (plain ws://, put TLS in front), ICE range (WEBRTC_PORT_MIN..MAX)
EXPOSE 4534/udp 4535/tcp 50000-50100/udp
ENTRYPOINT ["/usr/local/bin/server-entrypoint.sh"]
