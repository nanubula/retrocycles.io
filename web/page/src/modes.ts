// The play modes and what the page knows about each:
// its title and the attract-scene state it indexes (API.md "The attract scene":
// mode k plays the scene to state k).
import { t, type PlainKey } from "./i18n";

export type Mode = "quick" | "fort" | "ranked" | "browser" | "boards" | "local" | "custom";

// the Quick Play modes: each a line of the menu that finds a room the same way. id: the
// platform's name for the mode (POST /v1/quickplay `mode`, GET /v1/live `modes`; the default
// mode's is not sent); board: the leaderboard its rooms count on
export const QUICK_MODES: Partial<Record<Mode, { id: string; board: string; ask: boolean }>> = {
  quick: { id: "qp-ffa", board: "deathmatch", ask: false },
  fort: { id: "qp-fort", board: "fortress", ask: true }
};

export function isQuick(mode: Mode | null | undefined): boolean {
  return !!mode && mode in QUICK_MODES;
}

// what POST /v1/quickplay names for a mode: null for the default
export function quickModeId(mode: Mode): string | null {
  const q = QUICK_MODES[mode];
  return q && q.ask ? q.id : null;
}

export interface ModeInfo {
  mode: Mode;
  titleKey: PlainKey;
  readonly title: string; // in the current language (read at render)
  scene: 1 | 2 | 3 | 4;
  live: boolean; // can be played today
}


function info(mode: Mode, titleKey: PlainKey, scene: ModeInfo["scene"], live: boolean): ModeInfo {
  return {
    mode,
    titleKey,
    get title() {
      return t(titleKey);
    },
    scene,
    live
  };
}

// the order: Quick Play, Challenge a Friend, Leaderboards, Server Browser, Training;
// Fortress directly under Quick Play
const ALL: ModeInfo[] = [
  info("quick", "home.mode.quick", 1, true),
  // Fortress: Quick Play into a fortress room, where the platform runs that mode
  // (GET /v1/live lists it; setFortress below)
  info("fort", "home.mode.fort", 2, true),
  // Challenge a Friend: a private 1v1 sumo room, where the platform offers them
  // (features.privateRooms; setPrivateRooms below)
  info("custom", "home.mode.private", 4, true),
  info("ranked", "home.mode.ranked", 2, false),
  // the Leaderboards page: about the people playing
  info("boards", "home.mode.leaderboards", 3, true),
  info("browser", "home.mode.browser", 3, true),
  info("local", "home.mode.local", 4, true)
];

// the platform's last word on private rooms, kept by the browser: the line is there from the first
// paint (players found it arriving after the others awkward) unless the platform said no
// last time; its answer then adds or removes it
const PRIVATE_KEY = "rc.privateRooms";

function privateRoomsRemembered(): boolean {
  try {
    return localStorage.getItem(PRIVATE_KEY) !== "0";
  } catch {
    return true;
  }
}

// the Fortress line, as Challenge a Friend: there from the first paint (a line arriving after the
// others jumps the menu) unless the platform said no last time; GET /v1/live then
// adds or removes it
const FORT_KEY = "rc.fortress";

function fortressRemembered(): boolean {
  try {
    return localStorage.getItem(FORT_KEY) !== "0";
  } catch {
    return true;
  }
}

export const MODES: ModeInfo[] = ALL.filter((m) => m.live && (m.mode !== "custom" || privateRoomsRemembered()) && (m.mode !== "fort" || fortressRemembered()));

// a line in or out of the list, at its place in ALL's order: the index it was added at or removed
// from (the lines after it move by one), or -1 when nothing changed
function setLine(mode: Mode, on: boolean): number {
  const i = MODES.findIndex((m) => m.mode === mode);
  if (on && i < 0) {
    const order = ALL.findIndex((m) => m.mode === mode);
    const at = MODES.filter((m) => ALL.indexOf(m) < order).length;
    MODES.splice(at, 0, ALL[order]);
    return at;
  }
  if (!on && i >= 0) {
    MODES.splice(i, 1);
    return i;
  }
  return -1;
}

function remember(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* the line is just not remembered */
  }
}

// the Challenge a Friend line follows the platform's answer (features.privateRooms), after the
// Quick Play lines. The index it was added at or removed from, or -1 when nothing changed.
export function setPrivateRooms(on: boolean): number {
  remember(PRIVATE_KEY, on);
  return setLine("custom", on);
}

// the Fortress line follows GET /v1/live: there while its `modes` lists qp-fort
export function setFortress(on: boolean, keep = true): number {
  if (keep) remember(FORT_KEY, on);
  return setLine("fort", on);
}

// the Quick Play line a board's PLAY goes to: its own mode's when the menu has it
export function modeForBoard(board: string | null | undefined): Mode {
  for (const [mode, q] of Object.entries(QUICK_MODES) as [Mode, { board: string }][]) {
    if (q.board === board && modeIndex(mode) >= 0) return mode;
  }
  return "quick";
}

export function modeIndex(mode: Mode): number {
  return MODES.findIndex((m) => m.mode === mode);
}

export function modeInfo(mode: Mode): ModeInfo {
  return MODES[modeIndex(mode)];
}
