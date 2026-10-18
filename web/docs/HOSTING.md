# Hosting a server that browser players can join

For community operators. A server built from this branch takes desktop players over UDP as it
always has, and browser players (the Retrocycles page) over WebRTC. Browser support is **on by
default** wherever the build found libdatachannel; you mostly need to open two more ports.

How a browser player reaches you:

```
browser --wss--> Retrocycles signalling gateway --ws--> your server, TCP <game port + 1>   (signalling only)
browser <======= WebRTC data channel, UDP, directly ======> your server, UDP <game port + 1000>
desktop ------------------------- UDP -------------------> your server, UDP <game port>     (as always)
```

## 1. Install

The quickest way, on Ubuntu 22.04 / Debian 12 or newer (x86_64 or arm64) with systemd:

```sh
sudo adduser --disabled-password arma          # the unix user that runs the server
curl -fsSLO https://raw.githubusercontent.com/nanubula/retrocycles.io/server/web/install/ap.sh
sudo AP_USER=arma bash ap.sh
```

`ap.sh` installs the latest release (a prebuilt, signed tarball; nothing is compiled) into
`/home/arma/armagetronad`, the updater `retrocycles-server` and a systemd service
`retrocycles-server`, writes a starter `~/.armagetronad-dedicated/var/autoexec.cfg` and starts
the server. Its settings, logs and state live in `/home/arma/.armagetronad-dedicated`. Running
`ap.sh` again updates. `sudo AP_USER=arma bash ap.sh --from-source` builds the source instead
(10-20 minutes; also what it does on other architectures).

The release tarballs (`retrocycles-server-<version>-linux-<arch>.tar.gz` on the GitHub
releases page) run from any directory: `bin/armagetronad-dedicated`, with libdatachannel in
`lib/`. They need these packages: `libxml2 libzthread-2.3-2 libssl3 libcurl4 ca-certificates`
(on Ubuntu 24.04 and newer some end in `t64`: `libzthread-2.3-2t64 libssl3t64 libcurl4t64`).
Each release has `SHA256SUMS` and `SHA256SUMS.minisig`; check a download by hand with

```sh
minisign -Vm SHA256SUMS -P RWSIKpeOYWO+3TDSp+ycEWZ68jvOe8vgRGz2weCXIKYNQorr43zegka+
sha256sum -c --ignore-missing SHA256SUMS
```

The image `ghcr.io/nanubula/retrocycles-server` (section 7) is the same server for Docker.

### Building it yourself

You need libdatachannel (0.24 is what we test; DataChannel and WebSocket only, no media):

```sh
git clone --depth 1 --branch v0.24.5 --recursive https://github.com/paullouisageneau/libdatachannel.git
cmake -S libdatachannel -B libdatachannel/build -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/libdatachannel -DNO_MEDIA=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON
cmake --build libdatachannel/build -j"$(nproc)" && sudo cmake --install libdatachannel/build
```

(Debian/Ubuntu build packages: `cmake ninja-build libssl-dev` plus the game's usual
`autoconf automake libtool pkg-config bison g++ make libxml2-dev libzthread-dev`.)

Then the server, as usual; `configure` turns browser support on by itself when it finds the library:

```sh
./bootstrap.sh
mkdir -p build && cd build
../configure --enable-dedicated --disable-glout --with-libdatachannel=/opt/libdatachannel
make -j"$(nproc)" && sudo make install
```

`configure` prints `Browser clients (WebRTC): yes`. If it says `no`, it also printed a
`WARNING: Building WITHOUT browser support` saying why. `--enable-webrtc` makes a missing
library an error instead; `--disable-webrtc` builds without it and says nothing.

The release builds also pass `--enable-platform` (the Retrocycles moderation layer, needs
`libcurl4-openssl-dev`; it stays off until configured, section 6). A build from a release tag
`v0.2.9-sty+ct+ap+io.<N>` reports the version `0.2.9-sty+ct+ap+io.<N>`; any other build reports
a dev version.

Shortcuts on this branch: `web/install/ap.sh --from-source` does all of the above for one unix
user (its header lists the settings), and `web/docker/server.Dockerfile` builds an image with browser
support (`web/docker/server-entrypoint.sh` reads its settings). The image's entrypoint sets its own ports: signalling on
`0.0.0.0`, ICE on the range `WEBRTC_PORT_MIN`..`MAX` (50000-50100) instead of the single port
below, so publish that range or pass other values. The root `Dockerfile` is the upstream image
and builds **without** browser support (it has no libdatachannel).

## 2. Run

Nothing to configure. At start the console says what it listens on and what to open:

```
WebRTC: accepting browser clients, signalling on every interface:4535.
WebRTC: firewall: open TCP 4535 (signalling) and UDP 5534 (game traffic) for browser players, next to UDP 4534.
```

The defaults, all overridable in `settings_custom.cfg` or `autoexec.cfg`:

| Setting | Default | |
|---|---|---|
| `WEBRTC_ENABLE` | `1` | `0` turns browser players off |
| `WEBRTC_SIGNAL_PORT` | `0` = `SERVER_PORT` + 1 | TCP port of the signalling WebSocket (plain `ws://`) |
| `WEBRTC_SIGNAL_BIND` | empty = every interface | `127.0.0.1` when a local reverse proxy fronts it (section 5) |
| `WEBRTC_PORT_MIN` / `WEBRTC_PORT_MAX` | `0` / `0` = one UDP port, `SERVER_PORT` + 1000, shared by all browser players | a range gives each player its own port from it; a single port (`MIN` = `MAX`) is shared |
| `WEBRTC_PUBLIC_IP` | empty | your public IPv4 if the server sits behind 1:1 NAT or a port forward (the address the browser must send to) |
| `WEBRTC_TRUSTED_PROXIES` | `127.0.0.0/8 ::1` | proxies whose `X-Forwarded-For` is believed (section 5) |
| `WEBRTC_WEBSOCKET_ENABLE` | `0` | game packets over the WebSocket for browsers without WebRTC (section 5) |
| `WEBRTC_PENDING_PER_SOURCE` | `16` | connections still being set up (not yet logged in) one address (an IPv6 /48) may have; more are refused |
| `WEBRTC_PENDING_MAX` | `64` | the same for the whole server |
| `WEBRTC_SIGNAL_TIMEOUT` | `10` | seconds a signalling connection may stay silent before it is closed |
| `WEBRTC_HANDSHAKE_TIMEOUT` | `30` | seconds from connecting to playing before a connection is given up |
| `WEBRTC_LOGIN_TIMEOUT` | `60` | seconds a connected browser may stay without logging in to the game (or after leaving it) before it is closed |

The limits count only connections being set up, never players already in: every player who
comes through the Retrocycles gateway shares the gateway's address, and the per-address limit
leaves room for a burst of joins. Behind your own proxy (section 5) the per-address limit applies
to the player address the proxy forwards, not to the proxy. 0 turns a limit off.

## 3. Open the ports

For a server on the default game port 4534:

| Port | Protocol | What |
|---|---|---|
| 4534 | UDP | the game (desktop players; unchanged) |
| 4535 | TCP | browser signalling (`SERVER_PORT` + 1) |
| 5534 | UDP | browser game traffic, ICE (`SERVER_PORT` + 1000) |

The ICE port is +1000, not +2, so that servers on consecutive game ports (4534, 4535, 4536, ...)
never take each other's ports: the server on 4535 uses TCP 4536 and UDP 5535, and so on.

ufw:

```sh
sudo ufw allow 4534/udp
sudo ufw allow 4535/tcp
sudo ufw allow 5534/udp
```

firewalld:

```sh
sudo firewall-cmd --permanent --add-port=4534/udp --add-port=4535/tcp --add-port=5534/udp
sudo firewall-cmd --reload
```

Several servers on 4534 to 4537: `sudo ufw allow 4534:4537/udp`, `sudo ufw allow 4535:4538/tcp`,
`sudo ufw allow 5534:5537/udp`. Cloud providers often have a second firewall (security groups,
"firewall groups"): open the same ports there. At home, forward all three to the machine and set
`WEBRTC_PUBLIC_IP` to your public address.

If these ports stay closed, nothing breaks: desktop players play as before and browser players
just cannot join.

## 4. How browser players find you: Direct Connect

On retrocycles.io a player picks **Direct Connect** on the Servers screen and types your address,
`host:port` with the game port players already know (`203.0.113.7:4534`, or a name). The page:

1. connects to the Retrocycles signalling gateway over `wss://` (our certificate), which opens
   plain `ws://<host>:4535/` to your server and passes the signalling messages, nothing else;
2. then talks to your server directly over WebRTC on UDP 5534. Game packets never pass through
   Retrocycles, so the ping is your server's.

You need no domain and no certificate for this. Your server sees each player's real address (the
direct ICE address), not the gateway's, so bans, `MAX_CLIENTS_SAME_IP_*` and logs work per player.
Players on networks that only allow relayed (TURN) connections cannot reach community servers, and
players on IPv6 are counted by their /64 as an address in 240.0.0.0/4.

Players are shown a one-time warning before they join a server Retrocycles does not run or check:
you can see their IP address, and Retrocycles does not moderate your chat.

## 5. Optional: your own `wss://` with Caddy

With a domain you can give players a `wss://` URL straight to you. It is needed for the
**WebSocket fallback** (game packets over the signalling socket, for browsers that cannot use
WebRTC); the Retrocycles gateway never carries game packets. Caddy gets a certificate by itself:

```
play.example.org {
	handle /signal* {
		# the player's address, for the server (it trusts loopback: WEBRTC_TRUSTED_PROXIES)
		uri query X-Forwarded-For {client_ip}
		reverse_proxy 127.0.0.1:4535
	}
}
```

Open TCP 80 and 443 for Caddy. Then, in the server's settings:

```
WEBRTC_WEBSOCKET_ENABLE 1   # only if you want the WebSocket fallback
```

Players join with `wss://play.example.org/signal`. If **only** Caddy should reach the signalling
port, also set `WEBRTC_SIGNAL_BIND 127.0.0.1` and close TCP 4535; Direct Connect by `host:port`
then no longer works, only your `wss://` URL. Keeping the default bind serves both: Caddy's
connections come from loopback (trusted, the forwarded address counts), the gateway's from outside
(the direct ICE address counts).

## 6. Getting on the server list

The Retrocycles server list shows official rooms and **trusted community servers** only; every
other server is reachable by Direct Connect. There is no sign-up: we may invite servers that see
regular players. A listed server has:

- moderation on: a build with `--enable-platform` (the releases have it) and the defaults
  `PLATFORM_CHAT_FILTER 1`, `PLATFORM_SANCTIONS 1`, `PLATFORM_REPORTS 1`, which its heartbeats
  report, with a server key from Retrocycles;
- a current version (section 7 keeps it current);
- a named operator who signed the operator agreement.

## 7. Updating

Releases are numbered `0.2.9-sty+ct+ap+io.<N>`; the server says its version at start and in the
server browser. A server installed with `ap.sh` has the updater `retrocycles-server`:

| Command | |
|---|---|
| `retrocycles-server status` | installed version, the latest release, auto-update on/off, the service, players online |
| `retrocycles-server check` | whether a newer release exists |
| `sudo retrocycles-server update` | install the latest release (`--yes` skips the question, `--version <V>` picks one) |
| `sudo retrocycles-server rollback` | back to the version that ran before the last update |
| `sudo retrocycles-server auto-update on` / `off` | update by itself, see below |

An update downloads the tarball for your machine from the GitHub releases of
`nanubula/retrocycles.io`, checks its signature (`SHA256SUMS.minisig`, the key above) and sum,
and unpacks it next to the old one (`~/armagetronad/versions/<version>`; `current` points at the
one that runs). With players online it warns them in game 30 seconds before the restart. Then
it restarts the service and checks that the new version came up; if it does not within a minute,
the old version is put back and restarted. Your settings and state in `~/.armagetronad-dedicated`
are never touched. Re-running `ap.sh` does the same.

**Auto-update** (off by default): `sudo retrocycles-server auto-update on`. A daily systemd timer
(`retrocycles-server-update.timer`) then installs a newer release, but only while nobody is
playing: it waits for an empty server for the rest of the day and tries again the next day.
"Nobody" means no human in `var/online_players.txt`, which the server rewrites every game frame
(bots, ping 0, do not count). Releases are never installed unsigned.

**Update notice** (on by default): at every start and once a day the updater asks GitHub's
releases API (api.github.com, nothing else) for the latest release and writes
`a newer version ... is available` to the server log (`journalctl -u retrocycles-server`) when
there is one. `UPDATE_CHECK=off` in `/etc/retrocycles-server.conf` turns it off. That file also
holds `AUTO_UPDATE` and the user and paths `ap.sh` set up; it is kept when `ap.sh` runs again.

The service runs the server with `--input ~/.armagetronad-dedicated/var/input.txt`: a line
appended to that file is a console command (`echo "SAY hello" >> .../var/input.txt`), which is
how the updater warns players.

**Docker**: the image is `ghcr.io/nanubula/retrocycles-server`, tagged `latest` and with each
version (`+` written as `-`, image tags allow no `+`: `0.2.9-sty-ct-ap-io.3`), for x86_64 and
arm64. With Compose:

```yaml
services:
  retrocycles:
    image: ghcr.io/nanubula/retrocycles-server:latest
    restart: unless-stopped
    volumes: ["aa-data:/data"]
    ports: ["4534:4534/udp", "4535:4535/tcp", "50000-50100:50000-50100/udp"]
    environment:
      WEBRTC_PUBLIC_IP: 203.0.113.7   # the host's public IPv4
volumes:
  aa-data:
```

Update with `docker compose pull && docker compose up -d`. To have it done automatically,
Watchtower watches for new images and recreates the container:

```sh
docker run -d --name watchtower -v /var/run/docker.sock:/var/run/docker.sock \
    containrrr/watchtower --schedule "0 0 6 * * *" <container name>
```

Watchtower restarts without warning players, so schedule it for a quiet hour. The update notice
and auto-update above are for `ap.sh` installs only.

## Notes

- The signalling port is unauthenticated, like the game port. A connection costs almost nothing
  until it sends a valid offer (only then does the server set up WebRTC for it), silent ones are
  closed after 10 s, and the limits above cap how many can be in setup at once. If you do not want
  browser players at all, set `WEBRTC_ENABLE 0` or build with `--disable-webrtc`.
- Settings and internals: the `WEBRTC_*` settings in `src/network/nTransportRtc.cpp`. The platform
  side of Direct Connect: `platform-contract/README.md` section 7.
