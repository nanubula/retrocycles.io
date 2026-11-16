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

The quickest way, on Ubuntu 22.04, 24.04 or 26.04 or Debian 12 or newer (x86_64 or arm64) with
systemd:

```sh
sudo adduser --disabled-password arma          # the unix user that runs the server
curl -fsSLO https://raw.githubusercontent.com/nanubula/retrocycles.io/server/web/install/ap.sh
sudo AP_USER=arma bash ap.sh
```

`ap.sh` installs the latest release (a prebuilt, signed tarball; nothing is compiled) into
`/home/arma/armagetronad`, the updater `retrocycles-server` and a systemd service
`retrocycles-server`, writes a starter `~/servers/default/var/autoexec.cfg` and starts
the server. Its settings, logs and state live in `/home/arma/servers/default`. (Older installs
keep theirs in `~/.armagetronad-dedicated`; read that path for
`~/servers/default` in this guide.) Running `ap.sh` again updates.
`sudo AP_USER=arma bash ap.sh --from-source` builds the source instead (10-20 minutes; also what
it does on other architectures). Do not build from source on Ubuntu 26.04: its libxml2 (2.15)
has no HTTP client, so such a server cannot download maps or check global logins. The release
has its own libxml2 and works there.

One machine can run several servers: `sudo retrocycles-server add <name>` adds one with its own
settings and ports (section 7, "Several servers on one machine"). To start the servers with your
own scripts instead, install with `MANAGE=self` (section 7, "Managing the servers yourself").

The release tarballs (`retrocycles-server-<version>-linux-<arch>.tar.gz` on the GitHub
releases page) run from any directory: `bin/armagetronad-dedicated`, with libdatachannel in
`lib/`. They need these packages: `libzthread-2.3-2 libssl3 libcurl4 ca-certificates`
(on Ubuntu 24.04, Debian 13 and newer their names end in `t64`: `libzthread-2.3-2t64 libssl3t64
libcurl4t64`). libxml2 is built into the binary, so it needs no libxml2 package.
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

The Retrocycles server list shows our own rooms and **moderated community servers**. Every other
server is reachable by Direct Connect (section 4). A moderated server shows the **Moderated**
badge on the list.

### What a moderated server gets

- **Players find it.** It is on the server list, next to our rooms.
- **Players arrive signed in.** Browser players join with their Retrocycles account, with no
  password to type. The login token the page sends works only on your server, only once, and for
  60 seconds.
- **Moderation from us.** Chat is checked by our filter before other players see it. Our mutes and
  bans apply on your server. Players can use `/report`, and our moderators handle the reports.
- You keep your own rules, settings, admins, mutes and bans.

Games on a community server do not count for XP, levels or leaderboards on Retrocycles.io.

### What it needs

- A release build (section 1), or a build of this source with `--enable-platform` and the
  moderation code unchanged.
- The moderation settings on. They are on by default:
  `PLATFORM_CHAT_FILTER 1`, `PLATFORM_SANCTIONS 1`, `PLATFORM_REPORTS 1`.
- A current release (see "Versions" below).
- A named operator who accepts the
  [operator agreement](https://retrocycles.io/operators/) and answers us.

### How to apply

You send one application for all your servers, and you get one **operator key**. The key works
on all your servers. Each server has its own **server id**.

1. Read the [operator agreement](https://retrocycles.io/operators/) and apply with the form
   below it. You need a Retrocycles.io account. Give each server's address (`host:port`) and
   name (up to 10 servers), your name and a contact you check (email or Discord). The page shows
   the state of your application.
2. We look at the servers. When we approve you, we send you your operator key and the settings
   of each server. They look like this:

   ```
   PLATFORM_API_URL    https://api.retrocycles.io
   PLATFORM_SERVER_ID  <this server's id>
   PLATFORM_SERVER_KEY <your operator key>
   PLATFORM_LOGIN      1
   ```

   The lines are the same on all your servers, except `PLATFORM_SERVER_ID`.
3. Add the lines to the server's own `var/autoexec.cfg`: `~/servers/default/var/autoexec.cfg`
   for the first server, `~/servers/<name>/var/autoexec.cfg` for a server you added (section 7),
   `/data/var/autoexec.cfg` in Docker. Make the file readable only by the server's user:
   `chmod 600 autoexec.cfg`. Then restart the server (`sudo retrocycles-server restart <name>`,
   or `default` for the first one; or restart the container). Only a server with these lines
   goes on the list, so a test server without them stays off it.
4. At start the console says `Platform: reporting to https://api.retrocycles.io as server <id>`,
   followed by `login tokens accepted, chat checked, sanctions on, reports on`. The server then
   sends us a heartbeat every 10 seconds. When we see the heartbeats, we put the server on the
   list.

The operator key identifies your servers to us. Keep it secret: the server never writes it to the
console or its logs. If someone else could know it, tell us. We send you a new one, and the old
key stops working on all your servers.

### More servers

After we approve you, add more servers on the
[operator agreement page](https://retrocycles.io/operators/#servers). Give the server's address
and name. The page shows the new server's settings, with its own server id. Add your operator key
(the same `PLATFORM_SERVER_KEY` line as on your other servers) and restart the server. It goes on
the list when it sends heartbeats with the moderation settings on. You do not need a new
application. The page also shows the state of each of your servers, and you can remove a server
there.

### Versions

When we make a new release the minimum for moderated servers, you have **14 days** to update, or
**3 days** for a security release. We tell you about each one. A server on an older release leaves
the list until it updates. Auto-update (section 7) keeps you current without work:
`sudo retrocycles-server auto-update on`. It installs a release only while nobody plays.

### Leaving the list

A server leaves the list by itself while its heartbeats stop, while a moderation setting is off,
or while its release is too old. It comes back when the cause is gone. We may also take a server
off the list, for example for breaking the agreement. To leave, tell us and remove the four
`PLATFORM_*` lines.

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
the old version is put back and restarted. Your settings and state in `~/servers` are never
touched. Re-running `ap.sh` does the same.

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

The service runs the server with `--input ~/servers/default/var/input.txt`: a line
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

### Several servers on one machine

All servers of an `ap.sh` install use the same binary (`~/armagetronad/current`). Each server has
its own directory with its own settings, logs and ports. The first server is `default`: the
service `retrocycles-server`, files in `~/servers/default`, game port 4534. Each other server is
the service `retrocycles-server@<name>`, with files in `~/servers/<name>`.

| Command | |
|---|---|
| `retrocycles-server list` | every server: name, service, game port, state, players online, directory |
| `sudo retrocycles-server add <name>` | a new server; `--port <N>` sets its game port |
| `sudo retrocycles-server remove <name>` | stop the server and take it off the list; its files stay |
| `sudo retrocycles-server start` / `stop` / `restart <name>` | one server, or `all` |

A name is 1 to 32 characters: `a-z`, `0-9` and `-`, not `-` first. The name `default` is reserved.

`add` writes a starter `~/servers/<name>/var/autoexec.cfg` with `SERVER_PORT` and the
`WEBRTC_*` settings, starts the server and checks that it comes up. Then it tells you the three
ports to open. Without `--port` it takes the lowest free game port from 4534. A game port `N`
needs UDP `N`, TCP `N` + 1 and UDP `N` + 1000 (section 3). `add` makes sure that no other server
and no other program uses them, and it refuses a `--port` that clashes.

`remove <name>` keeps the directory and tells you where it is; `add <name>` later brings the
server back with its old settings. `remove <name> --purge` also deletes the directory, after a
question (`--yes` skips it). `stop` lasts until the next boot; to keep a server off, remove it.

Each server has its own `autoexec.cfg`. Only servers with the `PLATFORM_*` lines go on the
Retrocycles server list (section 6); a test server without them stays off it.

An update or rollback applies to all servers. It warns the players on each server that has
players, restarts every server that runs, and checks each one. A stopped server stays stopped and
runs the new version at its next start. If one server does not come up, all servers go back to
the old version, and the updater tells you which server failed. Auto-update and
`update --when-empty` wait until all servers are empty at the same time.

The updater of releases 1 and 2 can stop after an update before it installs the new updater.
The server then runs the new release, but these commands are missing. If
`retrocycles-server list` says that it does not know the command, run `ap.sh` again once.

### Managing the servers yourself

Some operators start their servers with their own scripts, for example the community scripts
that keep servers in `~/armagetronad/servers/<name>` and start them with `scripts/boot.sh`. For
them, install with `MANAGE=self`:

```sh
sudo AP_USER=arma MANAGE=self bash ap.sh
```

`ap.sh` then installs the release and the updater, but no server service, and it starts nothing.
Your scripts start `~/armagetronad/current/bin/armagetronad-dedicated`. Each server needs its
three ports (section 3). If `~/armagetronad/bin` does not exist, `ap.sh` makes it a link to
`current/bin`, so scripts that start `~/armagetronad/bin/armagetronad-dedicated` find the release
there. If `~/armagetronad/bin` is a real directory (an older build), `ap.sh` does not change it.
To use the release, set `tron="$HOME/armagetronad/current/bin/armagetronad-dedicated"` in
`scripts/srv.sh`.

`sudo retrocycles-server update` and `rollback` install the version and point `current` at it.
They do not restart your servers, unless you set these lines in `/etc/retrocycles-server.conf`:

```sh
# run as the server's user after an update or rollback; it must return (screen, tmux, nohup)
RESTART_CMD='cd ~/armagetronad/scripts && . boot.sh'
# the online_players.txt of your servers: needed for --when-empty and auto-update
ONLINE_FILES='/home/arma/armagetronad/servers/*/var/online_players.txt'
# the --input files of your servers, for the warning before the restart
INPUT_FILES='/home/arma/armagetronad/servers/*/var/input.txt'
```

Without `RESTART_CMD` the updater tells you to restart your servers. They run the old version
until then. With `RESTART_CMD`, the updater counts the processes that run the old binary and runs
the command. Then, within a minute, as many processes must run the new binary and none the old
one. If not, the updater points `current` back and runs the command again. With players online it
warns them first, but only if `INPUT_FILES` is set (your servers then need `--input <file>`).
Auto-update stays off without `ONLINE_FILES`: the updater cannot see who plays, so it could
restart your servers during a match. `list`, `add`, `remove`, `start`, `stop` and `restart` are
not available in this mode.

To let the updater run the servers later, run `ap.sh` again without `MANAGE=self`. Stop your own
servers first, or give them game ports that the new `default` server (4534) does not use. To go
the other way, disable the services first; `ap.sh` tells you which.

### Beside an older sty+ct+ap install

The community `ap.sh` also installs into `~/armagetronad`. Our `ap.sh` never changes the `bin`,
`servers` and `scripts` directories of that install, or its servers. There are three ways to run
both:

- **Separate unix users** (recommended): install ours for a new user (`adduser arma2`, then
  `AP_USER=arma2`). They share nothing.
- **The same user**: this works. `PREFIX=/home/arma/retrocycles` keeps our versions apart from
  the old install. Give each server its own game port; `add` skips the ports of the servers in
  `~/armagetronad/servers`.
- **`MANAGE=self`**: your old scripts start our binary. The servers keep their settings, and
  browser players can join them.

Old sty+ct+ap servers take desktop players only. They cannot be on the Retrocycles server list.

## Notes

- The signalling port is unauthenticated, like the game port. A connection costs almost nothing
  until it sends a valid offer (only then does the server set up WebRTC for it), silent ones are
  closed after 10 s, and the limits above cap how many can be in setup at once. If you do not want
  browser players at all, set `WEBRTC_ENABLE 0` or build with `--disable-webrtc`.
- Settings and internals: the `WEBRTC_*` settings in `src/network/nTransportRtc.cpp`. The platform
  side of Direct Connect: `platform-contract/README.md` section 7.
