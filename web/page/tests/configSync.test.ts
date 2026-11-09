// The account sync (src/settings/configSync.ts) with a mocked platform, game and storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfigSync, PUT_AFTER_MS } from "../src/settings/configSync.ts";
import type { Read, SyncDeps, Write } from "../src/settings/configSync.ts";
import { buildBlob, SYNC_STATE_KEY } from "../src/settings/sync.ts";

const DEVICE_EXPORT = [
  "PLAYER_1 Kid",
  "USER_1 kid@forums",
  "AUTO_LOGIN_1 1",
  "PASSWORD_STORAGE 1",
  "COLOR_R_1 15",
  "COLOR_B_1 0",
  "KEYBOARD\t97\tPLAYER_BIND\tCYCLE_TURN_LEFT\t1",
  "SHOW_HUD 1",
  "START_CAM_1 3",
  "BROWSER_MSAA 4"
].join("\n");

function rig(opts: { puts?: Write[]; gets?: Read[]; state?: string | null } = {}) {
  const calls = { get: 0, put: [] as Array<{ text: string; version: number; keepalive: boolean }>, imported: [] as string[], written: [] as Array<[string, string | null]> };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  let state: string | null = opts.state ?? null;
  let exportText = DEVICE_EXPORT;
  let importOk = true;
  let hold = false; // the next PUT waits until release()
  let release: (() => void) | null = null;
  const page: Record<string, string | null> = { "rc.hudStyle": "classic", "rc.touchLayout": "x" };
  const gets: Read[] = [...(opts.gets ?? [{ status: "ok", text: "", version: 0 }])];
  const puts = [...(opts.puts ?? [])];
  const deps: SyncDeps = {
    userId: "u1",
    async get() {
      calls.get++;
      return gets.length > 1 ? gets.shift()! : gets[0];
    },
    async put(text, version, keepalive) {
      calls.put.push({ text, version, keepalive });
      if (hold) {
        hold = false;
        await new Promise<void>((res) => (release = res));
      }
      return puts.shift() ?? { status: "ok", version: version + 1 };
    },
    exportConfig: () => exportText,
    importConfig(text) {
      calls.imported.push(text);
      return importOk;
    },
    readPage: (k) => page[k] ?? null,
    writePage(k, v) {
      calls.written.push([k, v]);
      page[k] = v;
    },
    loadState: () => state,
    saveState: (t) => {
      state = t;
    },
    setTimer(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    log: () => {}
  };
  return {
    deps,
    calls,
    timers,
    state: () => state,
    setExport(t: string) {
      exportText = t;
    },
    setImportOk(ok: boolean) {
      importOk = ok;
    },
    holdNextPut() {
      hold = true;
    },
    release() {
      release?.();
    },
    fire() {
      const [id, t] = [...timers.entries()][0];
      timers.delete(id);
      t.fn();
    }
  };
}

const remoteText = buildBlob("COLOR_R_1 3\nCOLOR_B_1 9\nKEYBOARD 98 PLAYER_BIND CYCLE_TURN_RIGHT 1", { "rc.lang": "de" });
const tick = () => new Promise((r) => setTimeout(r, 5));

test("a newer remote is applied: allowlisted lines only, and its version recorded", async () => {
  const evil = remoteText + 'PASSWORD_1 0 abc\nUSER_1 x\nQUIT\nSCENE_CAMERA_X 5\nBROWSER_MSAA 8\n# rc rc.touchLayout="y"\n';
  const r = rig({ gets: [{ status: "ok", text: evil, version: 4 }] });
  await createConfigSync(r.deps).start();
  assert.equal(r.calls.get, 1);
  assert.equal(r.calls.put.length, 0);
  assert.equal(r.calls.imported.length, 1);
  assert.match(r.calls.imported[0], /COLOR_R_1 3/);
  assert.match(r.calls.imported[0], /KEYBOARD 98 PLAYER_BIND CYCLE_TURN_RIGHT 1/);
  assert.doesNotMatch(r.calls.imported[0], /PASSWORD|USER_|QUIT|SCENE_|BROWSER_/);
  assert.ok(r.calls.written.some(([k, v]) => k === "rc.lang" && v === "de"));
  assert.ok(!r.calls.written.some(([k]) => k === "rc.touchLayout"));
  assert.equal(JSON.parse(r.state()!).users.u1.v, 4);
});

test("a remote at the version already synced is not applied, and unsynced local edits are kept and sent", async () => {
  const first = rig(); // uploaded: version 1
  await createConfigSync(first.deps).start();
  const same = rig({ gets: [{ status: "ok", text: remoteText, version: 1 }], state: first.state() });
  await createConfigSync(same.deps).start();
  assert.equal(same.calls.imported.length, 0);
  assert.equal(same.timers.size, 0);
  const edited = rig({ gets: [{ status: "ok", text: remoteText, version: 1 }], state: first.state() });
  edited.setExport(DEVICE_EXPORT.replace("COLOR_R_1 15", "COLOR_R_1 2")); // changed while signed out
  const s = createConfigSync(edited.deps);
  await s.start();
  assert.equal(edited.calls.imported.length, 0); // the local edits are not overwritten
  assert.equal(edited.timers.size, 1);
  edited.fire();
  await tick();
  assert.equal(edited.calls.put.length, 1);
  assert.equal(edited.calls.put[0].version, 1);
});

test("a tab keeps its own baseline: another tab's stored version is not adopted", async () => {
  const r = rig();
  const s = createConfigSync(r.deps);
  await s.start(); // uploaded: version 1
  r.deps.saveState(JSON.stringify({ users: { u1: { v: 5, h: "00000000" } }, last: "u1" })); // another tab saved
  r.setExport(DEVICE_EXPORT.replace("COLOR_R_1 15", "COLOR_R_1 2"));
  s.changed();
  r.fire();
  await tick();
  assert.equal(r.calls.put[1].version, 1); // its own, so the platform answers 409 and the merge runs
});

test("version 0 uploads this device's settings with If-Match 0", async () => {
  const r = rig();
  await createConfigSync(r.deps).start();
  assert.equal(r.calls.put.length, 1);
  assert.equal(r.calls.put[0].version, 0);
  assert.match(r.calls.put[0].text, /COLOR_R_1 15/);
  assert.match(r.calls.put[0].text, /rc\.hudStyle="classic"/);
  assert.equal(JSON.parse(r.state()!).users.u1.v, 1);
  assert.equal(r.calls.imported.length, 0);
});

test("a PUT never carries PASSWORD, USER_, AUTO_LOGIN or device lines", async () => {
  const r = rig();
  await createConfigSync(r.deps).start();
  const body = r.calls.put[0].text;
  assert.doesNotMatch(body, /PASSWORD|USER_|AUTO_LOGIN|PLAYER_1|START_CAM|BROWSER_|touchLayout/);
});

test("a forbidden answer (a guest) stops quietly", async () => {
  const r = rig({ gets: [{ status: "forbidden" }] });
  const s = createConfigSync(r.deps);
  await s.start();
  s.changed();
  assert.equal(r.timers.size, 0);
  assert.equal(r.calls.put.length, 0);
});

test("an unchanged blob makes no PUT", async () => {
  const r = rig();
  const s = createConfigSync(r.deps);
  await s.start();
  assert.equal(r.calls.put.length, 1);
  r.setExport(DEVICE_EXPORT + "\nSTART_CAM_1 5\nPASSWORD_1 0 zzz"); // only things that do not sync changed
  s.changed();
  r.fire();
  await tick();
  assert.equal(r.calls.put.length, 1);
});

test("changes are sent once, 5 s after the last one", async () => {
  const r = rig();
  const s = createConfigSync(r.deps);
  await s.start();
  r.setExport(DEVICE_EXPORT.replace("COLOR_R_1 15", "COLOR_R_1 2"));
  s.changed();
  s.changed();
  s.changed();
  assert.equal(r.timers.size, 1);
  assert.equal([...r.timers.values()][0].ms, PUT_AFTER_MS);
  assert.equal(r.calls.put.length, 1);
  r.fire();
  await tick();
  assert.equal(r.calls.put.length, 2);
  assert.equal(r.calls.put[1].version, 1);
  assert.match(r.calls.put[1].text, /COLOR_R_1 2/);
  assert.equal(r.calls.get, 1);
});

test("pagehide flushes now with keepalive", async () => {
  const r = rig();
  const s = createConfigSync(r.deps);
  await s.start();
  r.setExport(DEVICE_EXPORT.replace("SHOW_HUD 1", "SHOW_HUD 0"));
  s.changed();
  await s.flush(true);
  assert.equal(r.timers.size, 0);
  assert.equal(r.calls.put.length, 2);
  assert.equal(r.calls.put[1].keepalive, true);
});

test("a 409 reads again, merges, applies the merge and retries once", async () => {
  const remote2 = buildBlob("COLOR_R_1 3\nSHOW_PING 1", {});
  const r = rig({
    gets: [
      { status: "ok", text: "", version: 0 },
      { status: "ok", text: remote2, version: 7 }
    ],
    puts: [
      { status: "ok", version: 1 },
      { status: "conflict", version: 7 }
    ]
  });
  const s = createConfigSync(r.deps);
  await s.start();
  r.setExport(DEVICE_EXPORT.replace("COLOR_B_1 0", "COLOR_B_1 6"));
  s.changed();
  r.fire();
  await tick();
  assert.equal(r.calls.get, 2);
  assert.equal(r.calls.put.length, 3);
  const retry = r.calls.put[2];
  assert.equal(retry.version, 7);
  assert.match(retry.text, /COLOR_B_1 6/); // this device's own change kept
  assert.match(retry.text, /SHOW_PING 1/); // the other device's kept
  assert.match(retry.text, /COLOR_R_1 3/); // the account's where both have one
  assert.match(r.calls.imported.at(-1)!, /SHOW_PING 1/);
  assert.equal(JSON.parse(r.state()!).users.u1.v, 8);
});

test("a failed retry keeps the local settings and tries no more", async () => {
  const r = rig({
    gets: [
      { status: "ok", text: "", version: 0 },
      { status: "ok", text: remoteText, version: 7 }
    ],
    puts: [
      { status: "ok", version: 1 },
      { status: "conflict", version: 7 },
      { status: "conflict", version: 8 }
    ]
  });
  const s = createConfigSync(r.deps);
  await s.start();
  r.setExport(DEVICE_EXPORT.replace("COLOR_B_1 0", "COLOR_B_1 6"));
  s.changed();
  r.fire();
  await tick();
  assert.equal(r.calls.put.length, 3);
  assert.equal(r.calls.get, 2);
  assert.equal(r.timers.size, 0);
});

test("the state key is the documented one", () => {
  assert.equal(SYNC_STATE_KEY, "rc.configSync");
});

test("a conflict merge keeps edits made while the PUT and the read were pending", async () => {
  const remote2 = buildBlob("SHOW_PING 1", {});
  const r = rig({
    gets: [
      { status: "ok", text: "", version: 0 },
      { status: "ok", text: remote2, version: 7 }
    ],
    puts: [
      { status: "ok", version: 1 },
      { status: "conflict", version: 7 }
    ]
  });
  const s = createConfigSync(r.deps);
  await s.start();
  r.setExport(DEVICE_EXPORT.replace("COLOR_B_1 0", "COLOR_B_1 6"));
  s.changed();
  r.fire();
  r.setExport(DEVICE_EXPORT.replace("COLOR_B_1 0", "COLOR_B_1 11")); // edited after the PUT left
  await tick();
  assert.match(r.calls.put[2].text, /COLOR_B_1 11/);
  assert.doesNotMatch(r.calls.put[2].text, /COLOR_B_1 6/);
});

test("a sync stopped during conflict recovery applies nothing and sends nothing", async () => {
  const r = rig({
    gets: [
      { status: "ok", text: "", version: 0 },
      { status: "ok", text: remoteText, version: 7 }
    ],
    puts: [
      { status: "ok", version: 1 },
      { status: "conflict", version: 7 }
    ]
  });
  const s = createConfigSync(r.deps);
  await s.start();
  r.setExport(DEVICE_EXPORT.replace("COLOR_B_1 0", "COLOR_B_1 6"));
  s.changed();
  r.fire();
  s.stop(); // signed out while the PUT is in flight
  await tick();
  assert.equal(r.calls.put.length, 2);
  assert.equal(r.calls.imported.length, 0);
});

test("signing back into an account after another restores its settings, whatever the version", async () => {
  const a = rig({ gets: [{ status: "ok", text: remoteText, version: 4 }] });
  await createConfigSync(a.deps).start(); // account u1 synced at 4
  const b = rig({ gets: [{ status: "ok", text: buildBlob("COLOR_R_1 1", {}), version: 2 }], state: a.state() });
  b.deps.userId = "u2";
  await createConfigSync(b.deps).start(); // another account signs in here
  const back = rig({ gets: [{ status: "ok", text: remoteText, version: 4 }], state: b.state() });
  const s = createConfigSync(back.deps);
  await s.start();
  assert.equal(back.calls.imported.length, 1);
  assert.match(back.calls.imported[0], /COLOR_R_1 3/);
  assert.equal(back.calls.put.length, 0);
  assert.equal(back.timers.size, 0);
});

test("an import the game refuses records nothing, sends nothing, and the next start tries again", async () => {
  const r = rig({ gets: [{ status: "ok", text: remoteText, version: 4 }] });
  r.setImportOk(false);
  const s = createConfigSync(r.deps);
  await s.start();
  assert.equal(r.state(), null);
  s.changed();
  assert.equal(r.timers.size, 0);
  assert.equal(r.calls.put.length, 0);
  r.setImportOk(true);
  await createConfigSync(r.deps).start();
  assert.equal(r.calls.imported.length, 2);
  assert.equal(JSON.parse(r.state()!).users.u1.v, 4);
});

test("a pagehide flush during a pending save is sent with keepalive", async () => {
  const r = rig();
  const s = createConfigSync(r.deps);
  await s.start();
  r.setExport(DEVICE_EXPORT.replace("COLOR_R_1 15", "COLOR_R_1 2"));
  r.holdNextPut();
  s.changed();
  r.fire(); // the save is now waiting on its PUT
  await tick();
  r.setExport(DEVICE_EXPORT.replace("COLOR_R_1 15", "COLOR_R_1 4")); // changed meanwhile
  const leaving = s.flush(true);
  r.release();
  await leaving;
  await tick();
  assert.equal(r.calls.put.length, 3);
  assert.equal(r.calls.put[1].keepalive, false);
  assert.equal(r.calls.put[2].keepalive, true);
  assert.match(r.calls.put[2].text, /COLOR_R_1 4/);
});
