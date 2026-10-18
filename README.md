# Retrocycles.io: Armagetron Advanced in the browser

This is a fork of [Armagetron Advanced](https://gitlab.com/armagetronad/armagetronad) that lets
people play in a web browser. It is the source of the game client, the web page and the
servers at [retrocycles.io](https://retrocycles.io).

## Branches

- **`main`**: the browser client and its page, on top of upstream `legacy_0.2.9`.
  - a WebAssembly build of the client (`web/wasm`) with an OpenGL ES 2 / WebGL renderer;
  - the web page that hosts it (`web/page`);
  - a WebRTC and WebSocket transport so servers can accept browser players;
  - an optional platform layer for accounts and chat moderation (`--enable-platform`, off by
    default).

  See `web/deploy/README.md` for building the client and page and hosting them.
- **`server`**: the dedicated server we run, on top of upstream `hack-0.2.8-sty+ct+ap`
  (version `0.2.9-sty+ct+ap+io`). It has the same transport and platform layer, plus
  server-side changes such as respawn deathmatch and `SERVER_MODE`. Build this branch to host
  a server that browser players can join: on that branch, `web/install/ap.sh` installs it the same way the
  community ap.sh installs sty+ct+ap, and `web/docker/server.Dockerfile` builds an image.

The transport, the platform layer and engine fixes are shared. A change to them is made on
one branch and ported to the other.

## License

GPL version 2 or later, like upstream; see `COPYING.txt`.

If you fork this, please give your version its own name and look, so it is not mistaken
for retrocycles.io.

---

The rest of this branch's notes are upstream's, in `README`.
