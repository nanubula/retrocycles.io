// The Apply form and the operator's servers on the server operator agreement
// (src/legal/operators.ts) against a mocked platform, and the page itself: built, unlisted (no
// navigation, no sitemap, noindex).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addServer,
  checkInput,
  heartbeatText,
  loadApplications,
  plainName,
  readApiUrl,
  removeServer,
  serverText,
  statusText,
  submitApplication,
  validAddress,
  type ApplyInput,
  type FetchLike,
  type Operator,
  type OperatorApplication,
  type OperatorServer
} from "../src/legal/operators.ts";
import { renderDoc } from "../tools/legal-pages.ts";
import { sitemap } from "../tools/social.ts";
import { BUILT_DOCS, DOCS, LEGAL } from "../src/legal/config.ts";

const API = "https://api.example.test";
const FACTS = { commit: "0123456789abcdef0123456789abcdef01234567", buildDate: "2000-01-01", stars: null };

const APP: OperatorApplication = {
  id: 7,
  servers: [
    { address: "play.example.org:4534", name: "Example Sumo" },
    { address: "play.example.org:4536", name: "Example Fort" }
  ],
  operatorName: "Sam",
  contact: "sam@example.org",
  note: null,
  agreementVersion: "1",
  createdAt: "2026-11-09T10:00:00+00:00",
  status: "pending",
  decidedAt: null,
  staffNote: null
};

const SERVER: OperatorServer = {
  serverId: "example-sumo",
  name: "Example Sumo",
  address: "play.example.org:4534",
  addedAt: "2026-11-10T10:00:00+00:00",
  listed: true,
  delisted: false,
  onBoard: true,
  moderated: true,
  whyNot: [],
  warning: null,
  heartbeatAgeSeconds: 4.2,
  heartbeatFresh: true,
  settings: "PLATFORM_SERVER_ID example-sumo\nPLATFORM_LOGIN 1\n"
};

const OPERATOR: Operator = {
  name: "Sam",
  contact: "sam@example.org",
  agreementVersion: "1",
  approvedAt: "2026-11-10T10:00:00+00:00",
  keyRotatedAt: null,
  revoked: false,
  maxServers: 20,
  servers: [SERVER]
};

const INPUT: ApplyInput = {
  servers: [
    { address: " play.example.org:4534 ", name: "Example Sumo" },
    { address: "play.example.org:4536", name: " Example Fort " }
  ],
  operatorName: "Sam",
  contact: "sam@example.org",
  note: "",
  accepted: true
};

interface Call {
  url: string;
  init?: RequestInit;
}

// a fetch that answers every call with one status and body, and keeps the calls
function mock(status: number, body?: unknown): { fetchFn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetchFn, calls };
}

const failing: FetchLike = async () => {
  throw new TypeError("network");
};

test("platform.json gives the API address; none, or a bad one, is no platform", async () => {
  assert.equal(await readApiUrl(mock(200, { apiUrl: API + "/" }).fetchFn), API);
  assert.equal(await readApiUrl(mock(404).fetchFn), null);
  assert.equal(await readApiUrl(mock(200, { apiUrl: "javascript:1" }).fetchFn), null);
  assert.equal(await readApiUrl(failing), null);
});

test("load: the applications, the agreement version and the operator, with the session", async () => {
  const { fetchFn, calls } = mock(200, { applications: [APP], agreementVersion: "1", operator: null });
  const result = await loadApplications(fetchFn, API);
  assert.deepEqual(result, { kind: "ready", applications: [APP], agreementVersion: "1", operator: null });
  assert.equal(calls[0].url, API + "/v1/operators/applications/mine");
  assert.equal(calls[0].init?.credentials, "include");
  const approved = await loadApplications(mock(200, { applications: [{ ...APP, status: "approved" }], agreementVersion: "1", operator: OPERATOR }).fetchFn, API);
  assert.equal(approved.kind, "ready");
  assert.deepEqual(approved.kind === "ready" && approved.operator, OPERATOR);
});

test("load: signed out, a guest, no platform, an error", async () => {
  assert.deepEqual(await loadApplications(mock(401).fetchFn, API), { kind: "signedOut" });
  assert.deepEqual(await loadApplications(mock(403, { code: "guest" }).fetchFn, API), { kind: "guest" });
  assert.deepEqual(await loadApplications(mock(404).fetchFn, API), { kind: "closed" });
  assert.deepEqual(await loadApplications(mock(200).fetchFn, null), { kind: "closed" });
  assert.deepEqual(await loadApplications(mock(500).fetchFn, API), { kind: "error" });
  assert.deepEqual(await loadApplications(failing, API), { kind: "error" });
});

test("addresses: host:port with a port from 1024 to 65534", () => {
  assert.ok(validAddress("play.example.org:4534"));
  assert.ok(validAddress("203.0.113.7:1024"));
  assert.ok(validAddress("[2001:db8::1]:65534"));
  assert.ok(!validAddress("play.example.org"));
  assert.ok(!validAddress("play.example.org:1023"));
  assert.ok(!validAddress("play.example.org:65535"));
  assert.ok(!validAddress("2001:db8::1:4534"));
  assert.ok(!validAddress("wss://play.example.org:4534"));
});

test("the page checks the fields, each server line and the agreement before it sends", async () => {
  const errors = checkInput({
    servers: [
      { address: "x", name: " " },
      { address: "play.example.org:4534", name: "A" },
      { address: "PLAY.example.org:4534", name: "B" }
    ],
    operatorName: "",
    contact: "",
    note: "n".repeat(1001),
    accepted: false
  });
  assert.deepEqual(Object.keys(errors).sort(), [
    "accepted",
    "contact",
    "note",
    "operatorName",
    "servers[0].address",
    "servers[0].name",
    "servers[2].address"
  ]);
  assert.equal(errors["servers[2].address"], "This address is in the form twice.");
  assert.ok(checkInput({ ...INPUT, servers: [] }).servers);
  const eleven = Array.from({ length: 11 }, (_, i) => ({ address: `play.example.org:${4534 + 2 * i}`, name: "S" + i }));
  assert.ok(checkInput({ ...INPUT, servers: eleven }).servers);
  const { fetchFn, calls } = mock(201, APP);
  const result = await submitApplication(fetchFn, API, { ...INPUT, accepted: false }, "1");
  assert.equal(result.kind, "invalid");
  assert.equal(calls.length, 0, "nothing sent");
});

test("apply: the body names the agreement version and the servers, with the CSRF header; 201 is the application", async () => {
  const { fetchFn, calls } = mock(201, APP);
  const result = await submitApplication(fetchFn, API, INPUT, "1");
  assert.deepEqual(result, { kind: "applied", application: APP });
  assert.equal(calls[0].url, API + "/v1/operators/applications");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>)["X-RC-CSRF"], "1");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    operatorName: "Sam",
    contact: "sam@example.org",
    agreementVersion: "1",
    servers: [
      { address: "play.example.org:4534", name: "Example Sumo" },
      { address: "play.example.org:4536", name: "Example Fort" }
    ]
  });
  const withNote = mock(201, APP);
  await submitApplication(withNote.fetchFn, API, { ...INPUT, note: " Weekly cup " }, "1");
  assert.equal(JSON.parse(String(withNote.calls[0].init?.body)).note, "Weekly cup");
});

test("apply: each refusal of the platform", async () => {
  assert.deepEqual(await submitApplication(mock(401).fetchFn, API, INPUT, "1"), { kind: "signedOut" });
  assert.deepEqual(await submitApplication(mock(403, { code: "guest" }).fetchFn, API, INPUT, "1"), { kind: "guest" });
  assert.deepEqual(await submitApplication(mock(400, { code: "agreement_version", current: "2" }).fetchFn, API, INPUT, "1"), {
    kind: "agreementVersion",
    current: "2"
  });
  assert.deepEqual(await submitApplication(mock(409, { code: "application_exists" }).fetchFn, API, INPUT, "1"), { kind: "exists" });
  assert.deepEqual(await submitApplication(mock(429, { code: "too_many_applications" }).fetchFn, API, INPUT, "1"), { kind: "tooMany" });
  assert.deepEqual(await submitApplication(mock(404).fetchFn, API, INPUT, "1"), { kind: "closed" });
  assert.deepEqual(await submitApplication(mock(500).fetchFn, API, INPUT, "1"), { kind: "error" });
  assert.deepEqual(await submitApplication(failing, API, INPUT, "1"), { kind: "error" });
});

test("apply: a validation problem shows the platform's message on its field, a server's on its line", async () => {
  const problem = {
    title: "One or more validation errors occurred.",
    status: 400,
    errors: {
      "servers[1].name": ["Choose another server name. This one is not allowed."],
      Contact: ["Too long."],
      other: ["x"]
    }
  };
  assert.deepEqual(await submitApplication(mock(400, problem).fetchFn, API, INPUT, "1"), {
    kind: "invalid",
    errors: { "servers[1].name": "Choose another server name. This one is not allowed.", contact: "Too long." }
  });
});

test("add a server: name and address, with the CSRF header; 201 is the server and its settings", async () => {
  const { fetchFn, calls } = mock(201, { server: SERVER, settings: SERVER.settings });
  assert.deepEqual(await addServer(fetchFn, API, { address: " play.example.org:4534 ", name: " Example Sumo " }), {
    kind: "added",
    server: SERVER,
    settings: SERVER.settings
  });
  assert.equal(calls[0].url, API + "/v1/operators/me/servers");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>)["X-RC-CSRF"], "1");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { name: "Example Sumo", address: "play.example.org:4534" });

  const nothing = mock(201, {});
  assert.equal((await addServer(nothing.fetchFn, API, { address: "x", name: "" })).kind, "invalid");
  assert.equal(nothing.calls.length, 0, "nothing sent");
});

test("add a server: each refusal of the platform", async () => {
  const input = { address: "play.example.org:4538", name: "Example Race" };
  assert.deepEqual(await addServer(mock(409, { code: "server_limit" }).fetchFn, API, input), { kind: "limit" });
  assert.deepEqual(await addServer(mock(403, { code: "revoked" }).fetchFn, API, input), { kind: "revoked" });
  assert.deepEqual(await addServer(mock(403, { code: "not_operator" }).fetchFn, API, input), { kind: "notOperator" });
  assert.deepEqual(await addServer(mock(401).fetchFn, API, input), { kind: "signedOut" });
  assert.deepEqual(await addServer(mock(409, { code: "signal_url_taken" }).fetchFn, API, input), {
    kind: "invalid",
    errors: { address: "A server on the list has this address already." }
  });
  assert.deepEqual(await addServer(mock(400, { errors: { Name: ["Choose another server name. This one is not allowed."] } }).fetchFn, API, input), {
    kind: "invalid",
    errors: { name: "Choose another server name. This one is not allowed." }
  });
  assert.deepEqual(await addServer(failing, API, input), { kind: "error" });
});

test("remove a server: DELETE with the CSRF header; a server already gone is removed too", async () => {
  const { fetchFn, calls } = mock(204);
  assert.deepEqual(await removeServer(fetchFn, API, "example sumo"), { kind: "removed" });
  assert.equal(calls[0].url, API + "/v1/operators/me/servers/example%20sumo");
  assert.equal(calls[0].init?.method, "DELETE");
  assert.equal((calls[0].init?.headers as Record<string, string>)["X-RC-CSRF"], "1");
  assert.deepEqual(await removeServer(mock(404).fetchFn, API, "x"), { kind: "removed" });
  assert.deepEqual(await removeServer(mock(403, { code: "revoked" }).fetchFn, API, "x"), { kind: "revoked" });
  assert.deepEqual(await removeServer(mock(403, { code: "not_operator" }).fetchFn, API, "x"), { kind: "notOperator" });
  assert.deepEqual(await removeServer(failing, API, "x"), { kind: "error" });
});

test("the status in plain words", () => {
  assert.equal(statusText(APP), "We will look at it and contact you.");
  assert.equal(statusText({ ...APP, status: "approved" }), "Approved. We sent your operator key and your server settings to your contact.");
  assert.equal(statusText({ ...APP, status: "declined", staffNote: "The server does not answer." }), "Declined. The server does not answer.");
});

test("a server's state and heartbeat in plain words", () => {
  assert.equal(serverText(SERVER, false), "On the server list.");
  assert.equal(serverText(SERVER, true), "Not on the server list. Your operator key is revoked.");
  assert.equal(serverText({ ...SERVER, onBoard: false, listed: false }, false), "Not on the server list yet. We put it on the list after we check it.");
  assert.equal(serverText({ ...SERVER, onBoard: false, listed: false, delisted: true }, false), "Not on the server list. We took it off. Contact us to put it back.");
  assert.equal(
    serverText({ ...SERVER, onBoard: false, moderated: false, whyNot: ["It sends no heartbeats."], heartbeatAgeSeconds: null }, false),
    "Not on the server list now. It sends no heartbeats."
  );
  assert.equal(
    serverText({ ...SERVER, onBoard: false, moderated: false, whyNot: ["It sends no heartbeats."], heartbeatAgeSeconds: 53 }, false),
    "Not on the server list now. Its heartbeats stopped."
  );
  assert.equal(heartbeatText(SERVER), "Last heartbeat 4 seconds ago.");
  assert.equal(heartbeatText({ ...SERVER, heartbeatAgeSeconds: 600 }), "Last heartbeat 10 minutes ago.");
  assert.equal(heartbeatText({ ...SERVER, heartbeatAgeSeconds: 1.2 }), "Last heartbeat 1 second ago.");
  assert.equal(heartbeatText({ ...SERVER, heartbeatAgeSeconds: 0.2 }), "Last heartbeat 1 second ago.");
  assert.equal(heartbeatText({ ...SERVER, heartbeatAgeSeconds: null }), "No heartbeat yet.");
});

test("server names show without the game's colour codes", () => {
  assert.equal(plainName("0x75ff00Snake 0xRESETTSurvival"), "Snake Survival");
  assert.equal(plainName("Plain"), "Plain");
  assert.equal(plainName("0xff0000"), "0xff0000");
});

test("the operators page is built but unlisted: not in the navigation or the sitemap, noindex", () => {
  assert.ok(BUILT_DOCS.some((d) => d.id === "operators"), "built");
  assert.ok(!DOCS.some((d) => d.id === "operators"), "not listed");
  assert.ok(!sitemap(() => null).includes("/operators/"), "not in the sitemap");
  const html = renderDoc(readFileSync(new URL("../operators/index.html", import.meta.url), "utf8"), FACTS);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.ok(html.includes(`version <span data-version-text>${LEGAL.operatorAgreementVersion}</span>`));
  assert.ok(html.includes("one operator key for all your servers"), "one key per operator");
  assert.ok(html.includes("<template data-server-row>"), "a line for each server");
  assert.ok(!html.includes('href="../operators/"'), "its own foot does not list it");
  for (const doc of DOCS) {
    const other = renderDoc(readFileSync(new URL(`../${doc.id}/index.html`, import.meta.url), "utf8"), FACTS);
    assert.ok(!other.includes("operators/"), doc.id + " does not link it");
  }
});
