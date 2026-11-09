// MODERN's rubber warning glow (src/settings/hudStyle.ts): on for a new visitor, `rc.rubberGlow`
// "off" only while it is turned off, and the choice kept for the page load when storage is blocked.
import { test } from "node:test";
import assert from "node:assert/strict";

const saved = new Map<string, string>();
let blocked = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => {
    if (blocked) throw new Error("blocked");
    return saved.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    if (blocked) throw new Error("blocked");
    saved.set(k, v);
  },
  removeItem: (k: string) => {
    if (blocked) throw new Error("blocked");
    saved.delete(k);
  }
};

const { rubberGlow, setRubberGlow } = await import("../src/settings/hudStyle.ts");

test("a new visitor gets the glow, and nothing is stored for it", () => {
  assert.equal(rubberGlow(), true);
  assert.equal(saved.has("rc.rubberGlow"), false);
});

test("turning it off stores \"off\"; turning it on again removes the key", () => {
  setRubberGlow(false);
  assert.equal(rubberGlow(), false);
  assert.equal(saved.get("rc.rubberGlow"), "off");
  setRubberGlow(true);
  assert.equal(rubberGlow(), true);
  assert.equal(saved.has("rc.rubberGlow"), false);
});

test("a stored \"off\" is read back on the next load", async () => {
  saved.set("rc.rubberGlow", "off");
  const again = await import("../src/settings/hudStyle.ts?reload");
  assert.equal(again.rubberGlow(), false);
  saved.delete("rc.rubberGlow");
});

test("blocked storage keeps the choice for this page load", () => {
  blocked = true;
  setRubberGlow(false);
  assert.equal(rubberGlow(), false);
  setRubberGlow(true);
  assert.equal(rubberGlow(), true);
  blocked = false;
});
