// The settings sync's allowlist and blob (src/settings/sync.ts): what travels between devices,
// both ways, and what an edited blob can never get into importConfig.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBlob, FORMAT_LINE, hashBlob, mergeBlobs, NEVER_ENGINE, parseBlob, SYNC_STATE_KEY, SYNCED_PAGE_KEYS } from "../src/settings/sync.ts";

// what exportConfig gives: user.cfg minus PASSWORD lines, then gBrowserSettingsText's lines
const EXPORT = [
  "PLAYER_1 Kid",
  "USER_1 kid@forums",
  "AUTO_LOGIN_1 1",
  "PASSWORD_STORAGE 1",
  "PASSWORD_1 0 abcdef",
  "COLOR_R_1 15",
  "COLOR_G_1 3",
  "COLOR_B_1 0",
  "COLOR_R_2 7",
  "KEYBOARD\t97\tPLAYER_BIND\tCYCLE_TURN_LEFT\t1",
  "KEYBOARD\t108\tPLAYER_BIND\tCYCLE_TURN_RIGHT\t1",
  "KEYBOARD\t9\tPLAYER_BIND\tSCORE\t0",
  "KEYBOARD\t50\tPLAYER_BIND\tCYCLE_BRAKE\t2",
  "SHOW_HUD 1",
  "SHOW_TIME 1",
  "INSTANT_CHAT_STRING_1_1 gg",
  "START_CAM_1 3",
  "START_FOV_1 90",
  "ALLOW_CAM_1_0 1",
  "SOUND_QUALITY 2",
  "PING_CHARITY 100",
  "TEXT_OUT 1",
  "SHOW_FPS 1",
  "CAMERA_CUSTOM_BACK 6",
  "SCENE_CAMERA_X 10",
  "SCENE_REPLAY 1",
  "BROWSER_MSAA 4",
  "BROWSER_BLOOM 1",
  "BROWSER_QUALITY 2",
  "TRAIL_GLASS 1",
  "SCREEN_SIZE_X 1280",
  "CUSTOM_SCREEN_WIDTH 1280",
  "FULLSCREEN 0"
].join("\n");

const PAGE = {
  "rc.hudStyle": "classic",
  "rc.showFps": "1",
  "rc.rubberGlow": "off",
  "rc.lang": "de",
  "rc.touchLayout": "{\"a\":1}",
  "rc.cookies": "yes",
  "rc.sharedComputer": "1",
  "rc.serverFilters": "{}",
  "rc.privateRooms": "[]",
  [SYNC_STATE_KEY]: "{\"version\":3}"
};

const FORBIDDEN = /^(PASSWORD|USER_|AUTO_LOGIN|PLAYER_1|SCENE_|BROWSER_|CAMERA_|TRAIL_GLASS|START_CAM|START_FOV|ALLOW_CAM|SCREEN_|CUSTOM_SCREEN|FULLSCREEN|SOUND_|PING_|TEXT_OUT|SHOW_FPS|COLOR_._2)/;

test("the blob keeps the allowlisted lines, in a stable order", () => {
  assert.equal(
    buildBlob(EXPORT, PAGE),
    [
      FORMAT_LINE,
      "COLOR_B_1 0",
      "COLOR_G_1 3",
      "COLOR_R_1 15",
      "INSTANT_CHAT_STRING_1_1 gg",
      "KEYBOARD 108 PLAYER_BIND CYCLE_TURN_RIGHT 1",
      "KEYBOARD 9 PLAYER_BIND SCORE 0",
      "KEYBOARD 97 PLAYER_BIND CYCLE_TURN_LEFT 1",
      "SHOW_HUD 1",
      "SHOW_TIME 1",
      '# rc rc.hudStyle="classic"',
      '# rc rc.lang="de"',
      '# rc rc.rubberGlow="off"',
      '# rc rc.showFps="1"',
      ""
    ].join("\n")
  );
});

test("logins, the name, device, camera and graphics lines never go out", () => {
  const blob = buildBlob(EXPORT, PAGE);
  for (const line of blob.split("\n").slice(1)) if (!line.startsWith("#")) assert.doesNotMatch(line, FORBIDDEN, line);
  assert.doesNotMatch(blob, /PASSWORD|USER_|AUTO_LOGIN|PLAYER_1 |touchLayout|cookies|sharedComputer|serverFilters|privateRooms|configSync/);
});

test("nor come in from an edited blob", () => {
  const blob = [FORMAT_LINE, ...EXPORT.split("\n"), "# rc rc.touchLayout=\"x\"", "# rc rc.cookies=\"yes\"", `# rc ${SYNC_STATE_KEY}="{}"`].join("\n");
  const p = parseBlob(blob);
  for (const line of p.engineLines) assert.doesNotMatch(line, FORBIDDEN, line);
  assert.deepEqual(Object.keys(p.page), []);
  assert.ok(p.engineLines.includes("COLOR_R_1 15"));
});

test("console commands, chains and includes are dropped", () => {
  const blob = [
    FORMAT_LINE,
    "QUIT",
    "COLOR_RED_1 1; QUIT",
    "COLOR_R_1 1; QUIT",
    "COLOR_G_1 4 QUIT",
    "INCLUDE x",
    "SINCLUDE x",
    "EXEC x",
    "CONNECT example.org",
    "SAY hi",
    "INSTANT_CHAT_STRING_1_2 hi; QUIT",
    "INSTANT_CHAT_STRING_1_26 too many",
    "KEYBOARD 97 PLAYER_BIND CYCLE_TURN_LEFT 1; QUIT",
    "KEYBOARD 97 PLAYER_BIND CYCLE_TURN_LEFT 1 QUIT",
    "KEYBOARD -1",
    "KEYBOARD 98 PLAYER_BIND CYCLE_BRAKE 2",
    "SHOW_HUD on",
    "SHOW_HUD\u00001",
    "COLOR_B_1 9",
    "# rc rc.hudStyle=\"<script>\"",
    "# rc rc.lang=nope",
    "# rc rc.showFps=1",
    "# rc rc.rubberGlow=\"on\""
  ].join("\n");
  assert.deepEqual(parseBlob(blob), { engineLines: ["COLOR_B_1 9"], page: {} });
});

test("a text without the format line is not a blob", () => {
  assert.deepEqual(parseBlob("COLOR_R_1 15\nSHOW_HUD 1\n"), { engineLines: [], page: {} });
  assert.deepEqual(parseBlob("# retrocycles-config 2\nCOLOR_R_1 15\n"), { engineLines: [], page: {} });
});

test("the never list holds against everything the allowlist lets through", () => {
  const p = parseBlob(buildBlob(EXPORT, PAGE));
  for (const line of p.engineLines) assert.doesNotMatch(line.split(" ")[0], NEVER_ENGINE);
  assert.ok(!SYNCED_PAGE_KEYS.includes(SYNC_STATE_KEY));
  assert.ok(!SYNCED_PAGE_KEYS.includes("rc.touchLayout"));
});

test("the round trip is stable", () => {
  const blob = buildBlob(EXPORT, PAGE);
  const p = parseBlob(blob);
  assert.deepEqual(p.page, { "rc.hudStyle": "classic", "rc.lang": "de", "rc.rubberGlow": "off", "rc.showFps": "1" });
  assert.equal(buildBlob(p.engineLines.join("\n"), p.page), blob);
  assert.equal(hashBlob(blob), hashBlob(buildBlob(p.engineLines.join("\n"), p.page)));
});

test("a page key not set goes as null and comes back as null", () => {
  const blob = buildBlob("COLOR_R_1 1", {});
  assert.match(blob, /# rc rc\.hudStyle=null/);
  assert.deepEqual(parseBlob(blob).page, { "rc.hudStyle": null, "rc.lang": null, "rc.rubberGlow": null, "rc.showFps": null });
});

test("the hash is stable under reordering and ignores dropped lines", () => {
  const lines = EXPORT.split("\n");
  const a = buildBlob(lines.join("\n"), PAGE);
  const b = buildBlob([...lines].reverse().join("\n"), PAGE); // no name twice in EXPORT
  assert.equal(hashBlob(a), hashBlob(b));
  const shuffled = [a.split("\n")[0], ...a.split("\n").slice(1).reverse(), "QUIT"].join("\n");
  assert.equal(hashBlob(shuffled), hashBlob(a));
  assert.match(hashBlob(a), /^[0-9a-f]{8}$/);
  assert.notEqual(hashBlob(a), hashBlob(buildBlob(EXPORT.replace("COLOR_G_1 3", "COLOR_G_1 4"), PAGE)));
});

test("later lines win, as when the game loads the file", () => {
  assert.deepEqual(parseBlob([FORMAT_LINE, "COLOR_R_1 1", "COLOR_R_1 2", "KEYBOARD 97 PLAYER_BIND A 1", "KEYBOARD 97 PLAYER_BIND B 1"].join("\n")).engineLines, ["COLOR_R_1 2", "KEYBOARD 97 PLAYER_BIND B 1"]);
});

test("merge: the account wins where both have a setting, this device's own are kept", () => {
  const local = buildBlob(["COLOR_R_1 1", "SHOW_TIME 1", "KEYBOARD 97 PLAYER_BIND CYCLE_TURN_LEFT 1", "KEYBOARD 120 PLAYER_BIND CHAT 1"].join("\n"), { "rc.hudStyle": "classic", "rc.lang": "fr" });
  const remote = [FORMAT_LINE, "COLOR_R_1 9", "KEYBOARD 97 PLAYER_BIND GLANCE_LEFT 1", "COLOR_B_1 2", '# rc rc.lang="de"', "QUIT"].join("\n");
  const merged = mergeBlobs(local, remote);
  assert.deepEqual(parseBlob(merged), {
    engineLines: ["COLOR_B_1 2", "COLOR_R_1 9", "KEYBOARD 120 PLAYER_BIND CHAT 1", "KEYBOARD 97 PLAYER_BIND GLANCE_LEFT 1", "SHOW_TIME 1"],
    page: { "rc.hudStyle": "classic", "rc.lang": "de", "rc.rubberGlow": null, "rc.showFps": null }
  });
  assert.equal(mergeBlobs(merged, remote), merged);
  assert.equal(parseBlob(mergeBlobs(local, "not a blob")).engineLines.length, 4);
});

test("the rubber warning glow travels, off and back on", () => {
  const off = parseBlob(buildBlob("", { "rc.rubberGlow": "off" }));
  assert.equal(off.page["rc.rubberGlow"], "off");
  assert.equal(buildBlob(off.engineLines.join("\n"), off.page), buildBlob("", { "rc.rubberGlow": "off" }));
  assert.equal(parseBlob(buildBlob("", {})).page["rc.rubberGlow"], null);
  assert.equal(parseBlob(buildBlob("", { "rc.rubberGlow": "on" })).page["rc.rubberGlow"], null);
});
