// The account sync of a registered player's settings: one GET when the game is ready, then
// a debounced PUT when something this device syncs changed. Plain functions over injected parts
// (the platform calls, the game's config API, the page's storage, timers), so the tests drive it
// with mocks; useConfigSync.ts is the hook that wires the real ones. What travels is decided in
// sync.ts (allowlist, blob, hash, merge); here only allowlisted lines reach importConfig.
import { buildBlob, hashBlob, mergeBlobs, parseBlob, SYNCED_PAGE_KEYS, SYNC_STATE_KEY } from "./sync.ts";

export const PUT_AFTER_MS = 5000;
const KEEPALIVE_MAX_CHARS = 30000; // a keepalive body is capped at 64 KB (and the text may escape)
const REMEMBERED_USERS = 5;

export type Read = { status: "ok"; text: string; version: number } | { status: "forbidden" };
export type Write = { status: "ok"; version: number } | { status: "conflict"; version: number } | { status: "forbidden" };

export interface SyncDeps {
  userId: string;
  get(): Promise<Read>;
  put(text: string, version: number, keepalive: boolean): Promise<Write>;
  exportConfig(): string; // aa.exportConfig()
  importConfig(text: string): boolean; // aa.importConfig(text)
  readPage(key: string): string | null;
  writePage(key: string, value: string | null): void;
  applied?(): void; // something was applied: the Settings sheet reads the values again
  loadState(): string | null;
  saveState(text: string): void;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  log(line: string): void;
}

export interface ConfigSync {
  start(): Promise<void>;
  changed(): void; // something may have changed: a PUT in PUT_AFTER_MS unless the blob is the one synced
  flush(leaving?: boolean): Promise<void>; // the PUT now (pagehide: leaving)
  stop(): void;
}

interface Synced {
  v: number; // the account's version last synced
  h: string; // hashBlob of this device's blob then
}

// the state: each user's last synced version and hash, and `last`, the user whose settings this
// device holds (the engine and page settings are shared by whoever signs in)
interface State {
  users: Record<string, Synced>;
  last: string | null;
}

function readState(raw: string | null): State {
  const out: State = { users: {}, last: null };
  if (!raw) return out;
  try {
    const data = JSON.parse(raw) as { users?: Record<string, { v?: unknown; h?: unknown }>; last?: unknown };
    for (const [id, s] of Object.entries(data?.users ?? {})) {
      if (s && Number.isSafeInteger(s.v) && (s.v as number) >= 0 && typeof s.h === "string") out.users[id] = { v: s.v as number, h: s.h };
    }
    if (typeof data?.last === "string" && out.users[data.last]) out.last = data.last;
  } catch {
    // unreadable: as never synced
  }
  return out;
}

export function createConfigSync(deps: SyncDeps): ConfigSync {
  let stopped = false;
  let ready = false; // the first GET is done: there is a version to replace
  let timer = 0;
  let busy: Promise<void> | null = null;
  let again = false;
  let againLeaving = false; // a pagehide flush arrived while a save was pending

  // this instance's baseline, in memory: the version it applied or uploaded and the hash of its settings then. The stored
  // record is shared by every tab and account of the browser, so it is read once at start and only written after
  let base: Synced | null = null;
  const state = (): Synced | null => base;
  const remember = (s: Synced) => {
    base = s;
    const all = readState(deps.loadState());
    delete all.users[deps.userId];
    all.users[deps.userId] = s;
    all.last = deps.userId;
    const ids = Object.keys(all.users).filter((id) => id !== deps.userId);
    for (const id of ids.slice(0, Math.max(0, ids.length + 1 - REMEMBERED_USERS))) delete all.users[id];
    deps.saveState(JSON.stringify(all));
  };

  const pageValues = () => {
    const out: Record<string, string | null> = {};
    for (const k of SYNCED_PAGE_KEYS) out[k] = deps.readPage(k);
    return out;
  };
  const localBlob = () => buildBlob(deps.exportConfig(), pageValues());

  // only allowlisted lines pass parseBlob: nothing else reaches importConfig or the page
  // false when the game did not take the lines: nothing is then recorded as applied
  function apply(text: string): boolean {
    const parsed = parseBlob(text);
    if (parsed.engineLines.length) {
      let ok = false;
      try {
        ok = deps.importConfig(parsed.engineLines.join("\n") + "\n");
      } catch (e) {
        deps.log("settings sync: import threw: " + String(e));
      }
      if (!ok) {
        deps.log("settings sync: the game did not take the saved settings");
        return false;
      }
    }
    for (const [key, value] of Object.entries(parsed.page)) {
      if (deps.readPage(key) !== value) deps.writePage(key, value);
    }
    deps.applied?.();
    return true;
  }

  async function upload(text: string, version: number, leaving: boolean): Promise<Write | null> {
    try {
      return await deps.put(text, version, leaving && text.length <= KEEPALIVE_MAX_CHARS);
    } catch (e) {
      deps.log("settings sync: not saved: " + String(e));
      return null;
    }
  }

  // a version conflict: read the account's again, merge, apply the merge here, one retry
  async function resolve(): Promise<void> {
    if (stopped) return;
    let remote: Read;
    try {
      remote = await deps.get();
    } catch (e) {
      deps.log("settings sync: conflict, not read again: " + String(e));
      return;
    }
    if (stopped || remote.status !== "ok") return; // signed out or another account meanwhile: nothing is applied or sent
    // this device's settings as they are now, not as they were when the PUT left (edits made meanwhile stay)
    const merged = mergeBlobs(localBlob(), remote.text);
    if (!apply(merged)) {
      ready = false; // nothing is sent over the account's settings until a sign-in applies them
      return;
    }
    const h = hashBlob(merged);
    const res = await upload(merged, remote.version, false);
    if (stopped) return;
    if (res?.status === "ok") {
      remember({ v: res.version, h });
      return;
    }
    // kept as it is here (the merge is applied); the next change tries again from the account's version
    deps.log("settings sync: merged, but not saved yet");
    remember({ v: remote.version, h: state()?.h ?? "" });
  }

  async function save(leaving: boolean): Promise<void> {
    const synced = state();
    if (stopped || !ready || !synced) return;
    const blob = localBlob();
    const h = hashBlob(blob);
    if (h === synced.h) return;
    const res = await upload(blob, synced.v, leaving);
    if (stopped || !res || res.status === "forbidden") return;
    if (res.status === "ok") remember({ v: res.version, h });
    else if (!leaving) await resolve();
  }

  function run(leaving: boolean): Promise<void> {
    if (busy) {
      again = true;
      if (leaving) againLeaving = true;
      return busy;
    }
    busy = save(leaving).finally(() => {
      busy = null;
      if (again && !stopped) {
        again = false;
        const leave = againLeaving;
        againLeaving = false;
        void run(leave);
      }
    });
    return busy;
  }

  const api: ConfigSync = {
    async start() {
      let remote: Read;
      try {
        remote = await deps.get();
      } catch (e) {
        deps.log("settings sync: not read: " + String(e));
        return;
      }
      if (stopped || remote.status !== "ok") return;
      if (remote.version === 0) {
        // nothing saved on the account: this device's settings are uploaded (also a guest just registered)
        ready = true;
        const blob = localBlob();
        const h = hashBlob(blob);
        const res = await upload(blob, 0, false);
        if (stopped) return;
        if (res?.status === "ok") remember({ v: res.version, h });
        else if (res?.status === "conflict") {
          remember({ v: 0, h: "" });
          await resolve();
        } else remember({ v: 0, h: "" });
        return;
      }
      const stored = readState(deps.loadState());
      const synced = stored.users[deps.userId] ?? null;
      if (!synced || stored.last !== deps.userId || remote.version > synced.v) {
        // the account's settings win: it is newer than what this device synced, or another account's
        // settings (or none of this one's) are on this device
        if (!apply(remote.text)) return; // not recorded, not ready to send: the next sign-in tries again
        remember({ v: remote.version, h: hashBlob(localBlob()) });
        ready = true;
        return;
      }
      // the account has not moved on since this device synced: edits made here since (signed out, offline)
      // stay and are sent
      remember({ v: remote.version, h: synced.h });
      ready = true;
      if (hashBlob(localBlob()) !== synced.h) api.changed();
    },
    changed() {
      if (stopped || !ready) return;
      deps.clearTimer(timer);
      timer = deps.setTimer(() => {
        timer = 0;
        void run(false);
      }, PUT_AFTER_MS);
    },
    async flush(leaving = false) {
      deps.clearTimer(timer);
      timer = 0;
      await run(leaving);
    },
    stop() {
      stopped = true;
      deps.clearTimer(timer);
      timer = 0;
    }
  };
  return api;
}

export { SYNC_STATE_KEY };
