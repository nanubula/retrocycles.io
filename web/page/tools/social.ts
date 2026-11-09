// The share cards: what a link to the page shows when it is posted. A site's crawler reads
// the page's HTML without running it, so the tags are written at build time:
//
//   <!--rc:social-->   in index.html: the description, the canonical address (one for every
//                      query: ?c=, utm_, ?duel=, ?embed=1 are the same page), the structured
//                      data (JSON-LD: the site, the game and who runs it; a data block, which
//                      the Content-Security-Policy does not block), Open Graph (Discord, Slack,
//                      iMessage, ...) and the X
//                      card. The X card is a player card: X frames `<site>/?embed=1&c=x-card`
//                      in the post (480 x 480; src/links.ts, the deploy's frame-ancestors) and
//                      shows the square image until it is pressed, where it cannot frame.
//   play/index.html    emitted (and served by the dev server): the /play/ link, the same tags,
//                      on to /?play (Quick Play at once) by public/play/forward.js. Its canonical
//                      address is the home page: it only forwards there.
//   robots.txt,        emitted: for search engines (Google Search Console, Bing Webmaster
//   sitemap.xml,       Tools). sitemap.xml is an index of two: sitemap-pages.xml, the page and
//   sitemap-pages.xml  the documents (src/legal/config.ts DOCS), and /news/sitemap.xml, which
//                      the platform writes from the published posts. A page's lastmod is the
//                      date of the last commit to its source file (none when git cannot say).
//                      /play/ only forwards, client.html is the API test page and /2/ is the
//                      test build (a copy of the page, Caddy): all kept out of search.
//
// The site is `RC_SITE_URL`, else https://<LEGAL.siteHost> (src/legal/config.ts). The images
// are public/share/ (NOTICE.txt there).
import type { Plugin } from "vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DOCS, LEGAL } from "../src/legal/config.ts";

const PAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const MARK = "<!--rc:social-->";

const TITLE = "Retrocycles: light cycle battles in your browser";
const DESCRIPTION =
  "Play Retrocycles free in your browser: online light cycle battles in Quick Play, 1v1 challenges with friends and training against the AI. No download, no sign-up.";

// the community Discord (components/CommunityLink.tsx)
const DISCORD_INVITE = "https://discord.gg/HqH2KDhu8Z";

export function site(): string {
  const env = process.env.RC_SITE_URL;
  return (env && /^https?:\/\//.test(env) ? env : "https://" + LEGAL.siteHost).replace(/\/+$/, "");
}

export function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// the tags for a page at `path` ("/" or "/play/")
export function socialTags(path: string): string {
  const base = site();
  const meta = (key: "name" | "property", id: string, content: string) => `<meta ${key}="${id}" content="${attr(content)}">`;
  return [
    meta("name", "description", DESCRIPTION),
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", "Retrocycles"),
    meta("property", "og:title", TITLE),
    meta("property", "og:description", DESCRIPTION),
    meta("property", "og:url", base + path),
    meta("property", "og:image", base + "/share/card.jpg"),
    meta("property", "og:image:width", "1200"),
    meta("property", "og:image:height", "630"),
    meta("property", "og:image:alt", "Lightcycles racing in the Retrocycles arena"),
    meta("name", "twitter:card", "player"),
    meta("name", "twitter:title", TITLE),
    meta("name", "twitter:description", DESCRIPTION),
    meta("name", "twitter:image", base + "/share/square.jpg"),
    meta("name", "twitter:image:alt", "Lightcycles racing in the Retrocycles arena"),
    meta("name", "twitter:player", base + "/?embed=1&c=x-card"),
    meta("name", "twitter:player:width", "480"),
    meta("name", "twitter:player:height", "480")
  ].join("\n");
}

// /play/: the tags, then on to /?play (no inline script: the Content-Security-Policy)
export function playPage(): string {
  return [
    "<!doctype html>",
    "<!-- The /play/ link (tools/social.ts): the share card's tags for crawlers; a visitor goes on",
    "     to /?play, Quick Play at once (src/links.ts), by public/play/forward.js. -->",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="color-scheme" content="dark">',
    "<title>Retrocycles</title>",
    socialTags("/play/"),
    '<link rel="canonical" href="' + attr(site() + "/") + '">',
    '<link rel="stylesheet" href="../plain.css">',
    '<script src="./forward.js"></script>',
    "</head>",
    "<body></body>",
    "</html>",
    ""
  ].join("\n");
}

// The structured data of the home page (schema.org, JSON-LD): the site (its name in search
// results), the game and the company that runs the site. Facts only: no ratings, no counts.
export function structuredData(): string {
  const base = site();
  const operatorId = base + "/#operator";
  const graph = [
    {
      "@type": "WebSite",
      "@id": base + "/#website",
      name: "Retrocycles",
      alternateName: LEGAL.siteHost,
      url: base + "/",
      inLanguage: "en",
      publisher: { "@id": operatorId }
    },
    {
      "@type": "Organization",
      "@id": operatorId,
      name: LEGAL.operator ?? LEGAL.siteHost,
      url: base + "/",
      logo: base + "/icons/apple-touch-icon.png",
      email: LEGAL.contactEmail ?? undefined,
      sameAs: [LEGAL.sourceRepoUrl, DISCORD_INVITE].filter(Boolean)
    },
    {
      "@type": ["VideoGame", "WebApplication"],
      "@id": base + "/#game",
      name: "Retrocycles",
      url: base + "/",
      description: DESCRIPTION,
      image: base + "/share/card.jpg",
      genre: ["Action", "Arcade"],
      gamePlatform: "Web browser",
      applicationCategory: "GameApplication",
      operatingSystem: "Any",
      browserRequirements: "Requires JavaScript, WebGL and WebAssembly.",
      playMode: ["MultiPlayer", "SinglePlayer"],
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      // what tells it apart: an independent browser build, not the upstream project's own
      // release (about/index.html "What this is")
      disambiguatingDescription:
        "An independent browser build of Armagetron Advanced, run by " +
        (LEGAL.operator ?? LEGAL.siteHost) +
        ". Not the Retrocycles desktop release on Steam.",
      // Armagetron Advanced's licence (about/index.html "Licences")
      license: "https://spdx.org/licenses/GPL-2.0-or-later.html",
      isBasedOn: { "@type": "VideoGame", name: "Armagetron Advanced", url: "https://www.armagetronad.org/" },
      publisher: { "@id": operatorId }
    }
  ];
  // "<" escaped, so the block cannot end early
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

// the home page's head: its tags, its canonical address, its structured data
export function homeTags(): string {
  return [socialTags("/"), `<link rel="canonical" href="${attr(site() + "/")}">`, structuredData()].join("\n");
}

export function socialCards(): Plugin {
  return {
    name: "retrocycles-social-cards",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => (html.includes(MARK) ? html.replace(MARK, homeTags()) : html)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || "").split("?")[0];
        if (path !== "/play/" && path !== "/play/index.html") return next();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(playPage());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "play/index.html", source: playPage() });
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots() });
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemapIndex() });
      this.emitFile({ type: "asset", fileName: "sitemap-pages.xml", source: sitemap() });
    }
  };
}

// The test build (/2/, where a page release goes before production) is not disallowed here: a
// crawler that may not fetch it never sees its noindex (the platform's Caddyfile sends
// X-Robots-Tag: noindex for /2/*), and a disallowed address can still be listed from links.
export function robots(): string {
  return ["User-agent: *", "Disallow: /client.html", "", "Sitemap: " + site() + "/sitemap.xml", ""].join("\n");
}

// the platform's /news/sitemap.xml lists the news and its posts (Caddy sends /news/* there)
function sitemapIndex(): string {
  const maps = ["/sitemap-pages.xml", "/news/sitemap.xml"].map((path) => `  <sitemap><loc>${site()}${path}</loc></sitemap>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...maps, "</sitemapindex>", ""].join("\n");
}

// the date of the last commit to a source file (YYYY-MM-DD), or null when git cannot say (no
// repository, the file not committed yet)
function lastCommitDate(file: string): string | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { cwd: PAGE_ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return /^\d{4}-\d{2}-\d{2}T/.test(out) ? new Date(out).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

export function sitemap(lastmod: (file: string) => string | null = lastCommitDate): string {
  const pages = [{ path: "/", file: "index.html" }, ...DOCS.map((d) => ({ path: "/" + d.id + "/", file: d.id + "/index.html" }))];
  const urls = pages.map(({ path, file }) => {
    const date = lastmod(file);
    return `  <url><loc>${site()}${path}</loc>${date ? `<lastmod>${date}</lastmod>` : ""}</url>`;
  });
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, "</urlset>", ""].join("\n");
}
