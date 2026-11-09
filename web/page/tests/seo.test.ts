// What search engines read without running the page (tools/social.ts, tools/legal-pages.ts,
// index.html): one canonical address per page, valid structured data, robots and the sitemap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homeTags, playPage, robots, sitemap, structuredData } from "../tools/social.ts";
import { renderDoc } from "../tools/legal-pages.ts";
import { DOCS } from "../src/legal/config.ts";

const SITE = "https://retrocycles.io";
const FACTS = { commit: "0123456789abcdef0123456789abcdef01234567", buildDate: "2026-10-25", stars: null };

test("the home page has one canonical address, the site's root", () => {
  const tags = homeTags();
  const canonicals = tags.match(/<link rel="canonical" href="([^"]+)">/g) ?? [];
  assert.deepEqual(canonicals, [`<link rel="canonical" href="${SITE}/">`]);
  assert.match(tags, /<meta name="description" content="[^"]{80,170}">/);
  assert.match(tags, new RegExp(`<meta property="og:url" content="${SITE}/">`));
});

test("the structured data is one JSON-LD block of facts: the site, the game, the operator", () => {
  const block = /^<script type="application\/ld\+json">(.*)<\/script>$/.exec(structuredData());
  assert.ok(block, "a JSON-LD script block");
  assert.ok(!block[1].includes("<"), "nothing that could end the block");
  const data = JSON.parse(block[1]);
  assert.equal(data["@context"], "https://schema.org");
  const byId = Object.fromEntries(data["@graph"].map((n: { "@id": string }) => [n["@id"], n]));
  const site = byId[SITE + "/#website"];
  const game = byId[SITE + "/#game"];
  const operator = byId[SITE + "/#operator"];
  assert.equal(site["@type"], "WebSite");
  assert.equal(site.name, "Retrocycles");
  assert.deepEqual(game["@type"], ["VideoGame", "WebApplication"]);
  assert.equal(game.isAccessibleForFree, true);
  assert.equal(game.offers.price, "0");
  assert.equal(game.isBasedOn.name, "Armagetron Advanced");
  assert.equal(operator["@type"], "Organization");
  assert.equal(game.publisher["@id"], operator["@id"]);
  // no invented numbers
  const json = JSON.stringify(data);
  for (const key of ["aggregateRating", "review", "ratingValue", "interactionStatistic", "downloads"]) {
    assert.ok(!json.includes(key), key);
  }
});

test("the /play/ link points search at the home page", () => {
  assert.match(playPage(), new RegExp(`<link rel="canonical" href="${SITE}/">`));
});

test("robots keeps the API test page out, lets crawlers see the test build's noindex, and names the sitemap", () => {
  const text = robots();
  assert.doesNotMatch(text, /^Disallow: \/2\/?$/m);
  assert.match(text, /^Disallow: \/client\.html$/m);
  assert.match(text, new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, "m"));
  assert.doesNotMatch(text, /^Disallow: \/$/m);
});

test("the sitemap lists the home page and every document, with lastmod only when it is known", () => {
  const xml = sitemap((file) => (file === "how-to-play/index.html" ? "2026-10-25" : null));
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [SITE + "/", ...DOCS.map((d) => `${SITE}/${d.id}/`)]);
  assert.ok(locs.includes(SITE + "/how-to-play/"));
  assert.ok(locs.includes(SITE + "/play-with-friends/"));
  assert.ok(locs.every((loc) => !loc.includes("?")), "no query addresses");
  assert.match(xml, new RegExp(`<loc>${SITE}/how-to-play/</loc><lastmod>2026-10-25</lastmod>`));
  assert.equal((xml.match(/<lastmod>/g) ?? []).length, 1);
});

test("every document gets its canonical address and share tags from its own title", () => {
  for (const doc of DOCS) {
    const html = renderDoc(readFileSync(new URL(`../${doc.id}/index.html`, import.meta.url), "utf8"), FACTS);
    const title = /<title>([^<]*)<\/title>/.exec(html)![1];
    assert.match(html, new RegExp(`<link rel="canonical" href="${SITE}/${doc.id}/">`), doc.id);
    assert.ok(html.includes(`<meta property="og:title" content="${title}">`), doc.id);
    assert.match(html, /<meta property="og:description" content="[^"]+">/, doc.id);
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, doc.id + ": one h1");
  }
});

test("the home page's HTML says what the game is before any script runs", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const root = /<div id="root">([\s\S]*?)<\/div><\/div>/.exec(html);
  assert.ok(root, "#root holds the page in words");
  assert.equal((root[1].match(/<h1>/g) ?? []).length, 1);
  assert.match(root[1], /light cycle game/);
  for (const href of ["./how-to-play/", "./play-with-friends/", "./about/", "./news"]) {
    assert.ok(root[1].includes(`href="${href}"`), href);
  }
  assert.match(html, /<title>Retrocycles - [^<]+<\/title>/);
});

test("the home screen says what the game is in words a reader sees", async () => {
  const { home } = await import("../src/i18n/en/home.ts");
  assert.match((home as Record<string, string>)["home.say"], /free multiplayer light cycle game in your browser/);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /className="home-say"[^>]*>\{t\("home\.say"\)\}/);
});

test("the page in words shows at once with no script, and stays hidden once the app starts", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<noscript><link rel="stylesheet" href="\.\/shell-noscript\.css"><\/noscript>/);
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /classList\.add\("is-app"\)/);
});

test("the account links' pages are kept out of search", () => {
  for (const page of ["account/reset-password/index.html", "account/verify-email/index.html", "auth-complete.html"]) {
    const html = readFileSync(new URL("../public/" + page, import.meta.url), "utf8");
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, page);
  }
});

test("every image in the home page's HTML has a non-empty alt", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const imgs = html.match(/<img\b[^>]*>/g) ?? [];
  assert.ok(imgs.length > 0);
  for (const img of imgs) assert.match(img, /\balt="[^"]+"/, img);
});
