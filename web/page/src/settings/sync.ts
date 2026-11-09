// What travels between a player's devices with their account: the allowlist and the blob's text.
// Pure, no imports: no aa, no network, no storage (the sync itself lives with App and the hooks).
// The blob is plain text, so the platform only ever sees text:
//
//   # retrocycles-config 1
//   COLOR_B_1 15
//   KEYBOARD 97 PLAYER_BIND CYCLE_TURN_LEFT 1
//   SHOW_HUD 1
//   # rc rc.hudStyle="classic"
//   # rc rc.lang=null
//
// The engine lines are user.cfg lines (as exportConfig gives them); the page keys are comments, a
// JSON string or null (null: the key is not set on that device, the page's default). Both ways,
// in and out, only what is on the lists below passes: an edited blob cannot get a console command,
// a login or a device setting into importConfig.

export const FORMAT_LINE = "# retrocycles-config 1";
const PAGE_PREFIX = "# rc ";

// the browser's own localStorage key for the sync's state (never in the blob itself)
export const SYNC_STATE_KEY = "rc.configSync";

// ---- the allowlist ---------------------------------------------------------------------------

// player 1's colour, the HUD tab's switches (schema.ts "hud", "grid") and team preferences. Not
// here, on purpose: the camera (START_CAM_1, START_FOV_1, ALLOW_CAM_*, CAMERA_*, AUTO_INCAM_1),
// graphics and display, sound, the connection, TEXT_OUT and SHOW_FPS (the page sets both itself)
const ENGINE_NAMES: ReadonlySet<string> = new Set([
  "COLOR_R_1", "COLOR_G_1", "COLOR_B_1",
  "SHOW_HUD", "SHOW_SPEED", "SHOW_RUBBER", "SHOW_BRAKE", "SHOW_PING", "SHOW_SCORE", "SHOW_ALIVE",
  "SHOW_FASTEST", "SHOW_TIME", "SHOW_TIME_24", "LAG_O_METER", "AXES_INDICATOR",
  "NAME_TEAM_AFTER_PLAYER_1", "FAV_NUM_PER_TEAM_PLAYER_1",
  "FILTER_COLOR_STRINGS"
]);
// the instant chats (schema.ts INSTANT_CHATS: 25), free text
const INSTANT_CHAT = /^INSTANT_CHAT_STRING_1_([1-9]|1\d|2[0-5])$/;
// a key of the keyboard (player 1's or a global action); touch layouts are page keys and stay
const KEY_LINE = /^KEYBOARD\s+(\d{1,10})\s+PLAYER_BIND\s+([A-Z][A-Z0-9_]{0,47})\s+([01])$/;
const NUMBER = /^-?\d{1,10}(\.\d{1,10})?$/;

// never synced whatever the list above says; kept for the tests to hold the list against
export const NEVER_ENGINE = /^(PASSWORD|USER_|AUTO_LOGIN_|PLAYER_\d|ADMIN|LOCAL_USER|GLOBAL_ID|SCENE_|BROWSER_|CAMERA_|TRAIL_GLASS$|START_CAM|START_FOV|ALLOW_CAM|SCREEN_|FULLSCREEN|CUSTOM_SCREEN|COLORDEPTH|ZDEPTH|INCLUDE|SINCLUDE|RINCLUDE|QUIT|EXIT)/;

// the page's localStorage keys that are the player's, each with the values it may take. Not
// here: rc.touchLayout (per device), rc.cookies, rc.sharedComputer, the server lists, filters
// and bookmarks, private rooms, the look and arena tests, the compact HUD, once-only flags,
// anything about signing in, and SYNC_STATE_KEY
const PAGE_KEYS: Readonly<Record<string, RegExp>> = {
  "rc.hudStyle": /^classic$/,
  "rc.showFps": /^1$/,
  // MODERN's rubber warning glow (hudStyle.ts): "off" while it is off, else not set
  "rc.rubberGlow": /^off$/,
  "rc.lang": /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
};

export const SYNCED_PAGE_KEYS: readonly string[] = Object.keys(PAGE_KEYS).sort();

const MAX_TEXT = 256 * 1024;
const MAX_LINE = 1024;

// ---- lines -----------------------------------------------------------------------------------

interface Setting {
  key: string; // the setting's identity for a merge: the name, or KEYBOARD <keysym>
  line: string; // the normalised user.cfg line
}

// an engine line on the allowlist, normalised (one blank between the words), or null
function engineSetting(raw: string): Setting | null {
  const line = raw.trim();
  if (!line || line.length > MAX_LINE || /[\u0000-\u0008\u000b-\u001f\u007f;]/.test(line)) return null;
  const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
  if (!m) return null;
  const name = m[1].toUpperCase();
  const value = (m[2] ?? "").trim();
  if (NEVER_ENGINE.test(name)) return null;
  if (name === "KEYBOARD") {
    const k = KEY_LINE.exec(("KEYBOARD " + value).replace(/\s+/g, " ").toUpperCase());
    if (!k) return null;
    const keysym = String(Number(k[1]));
    return { key: "KEYBOARD " + keysym, line: `KEYBOARD ${keysym} PLAYER_BIND ${k[2]} ${k[3]}` };
  }
  if (INSTANT_CHAT.test(name)) return { key: name, line: value ? `${name} ${value}` : name };
  if (ENGINE_NAMES.has(name) && NUMBER.test(value)) return { key: name, line: `${name} ${value}` };
  return null;
}

function pageValue(key: string, value: unknown): string | null | undefined {
  const rule = PAGE_KEYS[key];
  if (!rule || key === SYNC_STATE_KEY) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_LINE || !rule.test(value)) return undefined;
  return value;
}

// ---- the blob --------------------------------------------------------------------------------

export interface ParsedBlob {
  engineLines: string[]; // for importConfig, sorted
  page: Record<string, string | null>; // a synced key and its value (null: remove it)
}

interface Settings {
  engine: Map<string, string>; // key -> line
  page: Map<string, string | null>;
}

function render(s: Settings): string {
  const engine = [...s.engine.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]);
  const page = [...s.page.keys()].sort().map((k) => PAGE_PREFIX + k + "=" + JSON.stringify(s.page.get(k)));
  return [FORMAT_LINE, ...engine, ...page].join("\n") + "\n";
}

function engineOf(text: string, into: Map<string, string>) {
  // later lines win, as when the game loads the file
  for (const raw of text.slice(0, MAX_TEXT).split(/\r?\n/)) {
    const s = engineSetting(raw);
    if (s) into.set(s.key, s.line);
  }
}

// the blob of this device: exportConfig's text (user.cfg and the browser's device lines, which
// are left out here) and the page's localStorage values (getItem's, null when not set)
export function buildBlob(exportText: string, pageValues: Readonly<Record<string, string | null | undefined>>): string {
  const s: Settings = { engine: new Map(), page: new Map() };
  engineOf(exportText, s.engine);
  for (const key of SYNCED_PAGE_KEYS) {
    const v = pageValue(key, pageValues[key] ?? null);
    s.page.set(key, v === undefined ? null : v);
  }
  return render(s);
}

function read(text: string): Settings {
  const s: Settings = { engine: new Map(), page: new Map() };
  if (typeof text !== "string") return s;
  const lines = text.slice(0, MAX_TEXT).split(/\r?\n/);
  if (lines[0]?.trim() !== FORMAT_LINE) return s; // not a blob, or a format this page does not know
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line.startsWith(PAGE_PREFIX)) {
      const m = /^(rc\.[A-Za-z0-9_.]+)=(.*)$/.exec(line.slice(PAGE_PREFIX.length));
      if (!m) continue;
      let value: unknown;
      try {
        value = JSON.parse(m[2]);
      } catch {
        continue;
      }
      const v = pageValue(m[1], value);
      if (v !== undefined) s.page.set(m[1], v);
      continue;
    }
    const e = engineSetting(line);
    if (e) s.engine.set(e.key, e.line);
  }
  return s;
}

// what a blob from the account may set here: allowlisted lines only, anything else dropped
export function parseBlob(text: string): ParsedBlob {
  const s = read(text);
  const engineLines = [...s.engine.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]);
  const page: Record<string, string | null> = {};
  for (const k of [...s.page.keys()].sort()) page[k] = s.page.get(k) ?? null;
  return { engineLines, page };
}

// a cheap stable hash (FNV-1a, 32 bits, hex) of a blob's settings: the order of its lines and
// anything parseBlob drops do not change it
export function hashBlob(text: string): string {
  const canonical = render(read(text));
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// the retry after a version conflict: every setting of both, the account's (remote) where both
// have one, this device's where only it has one
export function mergeBlobs(local: string, remote: string): string {
  const l = read(local);
  const r = read(remote);
  for (const [k, v] of r.engine) l.engine.set(k, v);
  for (const [k, v] of r.page) l.page.set(k, v);
  return render(l);
}
