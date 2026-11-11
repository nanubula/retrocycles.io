// The Apply form and the operator's servers on the server operator agreement (/operators/,
// operators/index.html): the platform's calls and what the page says about their answers. Pure,
// and without imports: the tests load it under node with a mocked fetch
// (tests/operators.test.ts); operatorsPage.ts puts it on the page.
//
// The platform (same API and session as the play page, platform/client.ts):
//   GET    /v1/operators/applications/mine  -> { applications (newest first), agreementVersion,
//                                               operator (null until approved) }
//   POST   /v1/operators/applications       { operatorName, contact, agreementVersion,
//                                              servers: [{ address, name }], note? } -> 201
//   POST   /v1/operators/me/servers         { name, address } -> 201 { server, settings }
//   DELETE /v1/operators/me/servers/{id}    -> 204
// One application and one operator key for all of an operator's servers; each server has its
// own server id. 401: no session. 403 {code: "guest"}: a guest, not an account. 403 {code:
// "not_operator" | "revoked"}. 400 {code: "agreement_version", current}: the agreement changed.
// 409 {code: "application_exists" | "server_limit" | "signal_url_taken"}. 429 {code:
// "too_many_applications"}. 400 with `errors`: a field's message (the platform's own words),
// a server's field as "servers[1].name".

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ApplicationStatus = "pending" | "approved" | "declined";

export interface ApplicationServer {
  address: string;
  name: string;
}

export interface OperatorApplication {
  id: number;
  servers: ApplicationServer[];
  operatorName: string;
  contact: string;
  note: string | null;
  agreementVersion: string;
  createdAt: string;
  status: ApplicationStatus | string;
  decidedAt: string | null;
  staffNote: string | null;
}

// one of the operator's servers, with its state on the server list
export interface OperatorServer {
  serverId: string;
  name: string;
  address: string;
  addedAt: string;
  listed: boolean;
  delisted: boolean;
  onBoard: boolean;
  moderated: boolean;
  whyNot: string[];
  warning: string | null;
  heartbeatAgeSeconds: number | null;
  heartbeatFresh: boolean;
  settings: string;
}

export interface Operator {
  name: string;
  contact: string;
  agreementVersion: string;
  approvedAt: string;
  keyRotatedAt: string | null;
  revoked: boolean;
  maxServers: number;
  servers: OperatorServer[];
}

export const FIELDS = ["operatorName", "contact", "note"] as const;
export type Field = (typeof FIELDS)[number];

// a field's message, by its name: a FIELDS name, "accepted", "servers", or "servers[i].address"
// and "servers[i].name" for a server's line
export type Errors = Partial<Record<string, string>>;

export interface ApplyInput {
  servers: ApplicationServer[];
  operatorName: string;
  contact: string;
  note: string;
  accepted: boolean;
}

// the limits the platform checks too (its OperatorApplication)
export const MAX_LENGTH: Record<Field, number> = { operatorName: 100, contact: 200, note: 1000 };
export const MAX_ADDRESS = 300;
export const MAX_NAME = 128;
export const MAX_SERVERS = 10;
export const MIN_PORT = 1024;
export const MAX_PORT = 65534;

export type LoadResult =
  | { kind: "ready"; applications: OperatorApplication[]; agreementVersion: string; operator: Operator | null }
  | { kind: "signedOut" }
  | { kind: "guest" }
  | { kind: "closed" } // no platform here, or it does not take applications (404)
  | { kind: "error" };

export type ApplyResult =
  | { kind: "applied"; application: OperatorApplication }
  | { kind: "invalid"; errors: Errors }
  | { kind: "agreementVersion"; current: string }
  | { kind: "exists" }
  | { kind: "tooMany" }
  | { kind: "signedOut" }
  | { kind: "guest" }
  | { kind: "closed" }
  | { kind: "error" };

export type AddResult =
  | { kind: "added"; server: OperatorServer; settings: string }
  | { kind: "invalid"; errors: Partial<Record<"name" | "address", string>> }
  | { kind: "limit" }
  | { kind: "revoked" }
  | { kind: "notOperator" }
  | { kind: "signedOut" }
  | { kind: "closed" }
  | { kind: "error" };

export type RemoveResult = { kind: "removed" } | { kind: "revoked" } | { kind: "notOperator" } | { kind: "signedOut" } | { kind: "error" };

const TIMEOUT_MS = 8000;

// the platform's API address from platform.json beside the page (the play page's own file; this
// page is one level down), or null: no platform here
export async function readApiUrl(fetchFn: FetchLike, url = "../platform.json"): Promise<string | null> {
  try {
    const response = await fetchFn(url, { cache: "no-cache" });
    if (!response.ok) return null;
    const data = (await response.json()) as { apiUrl?: unknown } | null;
    const apiUrl = data && typeof data.apiUrl === "string" ? data.apiUrl : "";
    return /^https?:\/\//.test(apiUrl) ? apiUrl.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

async function request(fetchFn: FetchLike, apiUrl: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Response | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = {};
  // the platform's CSRF rule for a call that changes something with the session
  if (method !== "GET") headers["X-RC-CSRF"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await fetchFn(apiUrl + path, {
      method,
      credentials: "include",
      cache: "no-store",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function problemOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await response.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isApplication(a: unknown): a is OperatorApplication {
  const o = a as OperatorApplication | null;
  return !!o && typeof o === "object" && Array.isArray(o.servers) && typeof o.status === "string";
}

function isServer(s: unknown): s is OperatorServer {
  const o = s as OperatorServer | null;
  return !!o && typeof o === "object" && typeof o.serverId === "string" && typeof o.address === "string" && Array.isArray(o.whyNot);
}

function operatorOf(o: unknown): Operator | null {
  const op = o as Operator | null;
  if (!op || typeof op !== "object" || !Array.isArray(op.servers)) return null;
  return { ...op, servers: op.servers.filter(isServer) };
}

// the applicant's applications, the agreement version an application must name now, and the
// operator they are once approved
export async function loadApplications(fetchFn: FetchLike, apiUrl: string | null): Promise<LoadResult> {
  if (!apiUrl) return { kind: "closed" };
  const response = await request(fetchFn, apiUrl, "GET", "/v1/operators/applications/mine");
  if (!response) return { kind: "error" };
  if (response.status === 401) return { kind: "signedOut" };
  if (response.status === 404) return { kind: "closed" };
  if (response.status === 403) {
    const problem = await problemOf(response);
    return problem.code === "guest" ? { kind: "guest" } : { kind: "error" };
  }
  if (!response.ok) return { kind: "error" };
  const data = (await problemOf(response)) as { applications?: unknown; agreementVersion?: unknown; operator?: unknown };
  if (!Array.isArray(data.applications) || data.agreementVersion === undefined) return { kind: "error" };
  return {
    kind: "ready",
    applications: data.applications.filter(isApplication),
    agreementVersion: String(data.agreementVersion),
    operator: operatorOf(data.operator)
  };
}

// "host:port" with a port the platform takes (a name, an IPv4 address or [IPv6])
export function validAddress(text: string): boolean {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^\s:[\]]+):(\d{1,5})$/.exec(text.trim());
  if (!m) return false;
  const port = Number(m[2]);
  return port >= MIN_PORT && port <= MAX_PORT;
}

const ADDRESS_MESSAGE = `Write the address as host:port. The port is from ${MIN_PORT} to ${MAX_PORT}.`;

// one server's line: the same rules as the platform, in its words
function checkServer(server: ApplicationServer): Partial<Record<"name" | "address", string>> {
  const errors: Partial<Record<"name" | "address", string>> = {};
  const address = server.address.trim();
  if (address.length > MAX_ADDRESS) errors.address = `Use ${MAX_ADDRESS} characters or fewer.`;
  else if (!validAddress(address)) errors.address = ADDRESS_MESSAGE;
  const name = server.name.trim();
  if (!name) errors.name = "Write the name of the server.";
  else if (name.length > MAX_NAME) errors.name = `Use ${MAX_NAME} characters or fewer.`;
  return errors;
}

// what the page checks before it sends: the same rules as the platform, in its words
export function checkInput(input: ApplyInput): Errors {
  const errors: Errors = {};
  if (input.servers.length === 0) errors.servers = "Add at least one server.";
  if (input.servers.length > MAX_SERVERS) errors.servers = `Add ${MAX_SERVERS} servers or fewer. You can add more after we approve you.`;
  const seen = new Set<string>();
  input.servers.forEach((server, i) => {
    const line = checkServer(server);
    const address = server.address.trim().toLowerCase();
    if (!line.address && seen.has(address)) line.address = "This address is in the form twice.";
    seen.add(address);
    if (line.address) errors[`servers[${i}].address`] = line.address;
    if (line.name) errors[`servers[${i}].name`] = line.name;
  });
  if (!input.operatorName.trim()) errors.operatorName = "Write your name.";
  if (!input.contact.trim()) errors.contact = "Write an email address or a Discord name.";
  for (const field of FIELDS) {
    if (input[field].trim().length > MAX_LENGTH[field] && !errors[field]) errors[field] = `Use ${MAX_LENGTH[field]} characters or fewer.`;
  }
  if (!input.accepted) errors.accepted = "Accept the agreement to apply.";
  return errors;
}

// the platform's field messages, by the page's names ("ServerAddress" -> "serverAddress"),
// only those the page shows
function fieldErrors(problem: Record<string, unknown>, known: (field: string) => boolean): Errors {
  const errors: Errors = {};
  if (!problem.errors || typeof problem.errors !== "object") return errors;
  for (const [key, messages] of Object.entries(problem.errors as Record<string, unknown>)) {
    const field = key.charAt(0).toLowerCase() + key.slice(1);
    const first = Array.isArray(messages) ? messages.find((m): m is string => typeof m === "string") : undefined;
    if (known(field) && first) errors[field] = first;
  }
  return errors;
}

const isApplyField = (field: string) =>
  (FIELDS as readonly string[]).includes(field) || field === "servers" || /^servers\[\d+\]\.(address|name)$/.test(field);

export async function submitApplication(fetchFn: FetchLike, apiUrl: string | null, input: ApplyInput, agreementVersion: string): Promise<ApplyResult> {
  const invalid = checkInput(input);
  if (Object.keys(invalid).length > 0) return { kind: "invalid", errors: invalid };
  if (!apiUrl) return { kind: "closed" };
  const note = input.note.trim();
  const response = await request(fetchFn, apiUrl, "POST", "/v1/operators/applications", {
    operatorName: input.operatorName.trim(),
    contact: input.contact.trim(),
    agreementVersion,
    servers: input.servers.map((s) => ({ address: s.address.trim(), name: s.name.trim() })),
    ...(note ? { note } : {})
  });
  if (!response) return { kind: "error" };
  if (response.ok) {
    const application = await problemOf(response);
    return isApplication(application) ? { kind: "applied", application } : { kind: "error" };
  }
  if (response.status === 401) return { kind: "signedOut" };
  if (response.status === 404) return { kind: "closed" };
  const problem = await problemOf(response);
  if (response.status === 403) return problem.code === "guest" ? { kind: "guest" } : { kind: "error" };
  if (response.status === 429 || problem.code === "too_many_applications") return { kind: "tooMany" };
  if (problem.code === "application_exists") return { kind: "exists" };
  if (problem.code === "agreement_version") return { kind: "agreementVersion", current: String(problem.current ?? "") };
  if (response.status === 400) {
    const errors = fieldErrors(problem, isApplyField);
    if (Object.keys(errors).length > 0) return { kind: "invalid", errors };
  }
  return { kind: "error" };
}

// an approved operator adds a server: it uses the operator key and gets its own server id
export async function addServer(fetchFn: FetchLike, apiUrl: string | null, input: ApplicationServer): Promise<AddResult> {
  const invalid = checkServer(input);
  if (Object.keys(invalid).length > 0) return { kind: "invalid", errors: invalid };
  if (!apiUrl) return { kind: "closed" };
  const response = await request(fetchFn, apiUrl, "POST", "/v1/operators/me/servers", { name: input.name.trim(), address: input.address.trim() });
  if (!response) return { kind: "error" };
  if (response.ok) {
    const data = (await problemOf(response)) as { server?: unknown; settings?: unknown };
    return isServer(data.server) && typeof data.settings === "string" ? { kind: "added", server: data.server, settings: data.settings } : { kind: "error" };
  }
  if (response.status === 401) return { kind: "signedOut" };
  if (response.status === 404) return { kind: "closed" };
  const problem = await problemOf(response);
  if (problem.code === "revoked") return { kind: "revoked" };
  if (problem.code === "not_operator" || response.status === 403) return { kind: "notOperator" };
  if (problem.code === "server_limit") return { kind: "limit" };
  if (problem.code === "signal_url_taken") return { kind: "invalid", errors: { address: "A server on the list has this address already." } };
  if (response.status === 400) {
    const errors = fieldErrors(problem, (f) => f === "name" || f === "address");
    if (Object.keys(errors).length > 0) return { kind: "invalid", errors };
  }
  return { kind: "error" };
}

// the operator removes a server: it goes off the list, and the operator key no longer works for
// its server id (one already gone is removed too)
export async function removeServer(fetchFn: FetchLike, apiUrl: string | null, serverId: string): Promise<RemoveResult> {
  if (!apiUrl) return { kind: "error" };
  const response = await request(fetchFn, apiUrl, "DELETE", "/v1/operators/me/servers/" + encodeURIComponent(serverId));
  if (!response) return { kind: "error" };
  if (response.ok || response.status === 404) return { kind: "removed" };
  if (response.status === 401) return { kind: "signedOut" };
  const problem = await problemOf(response);
  if (problem.code === "revoked") return { kind: "revoked" };
  if (response.status === 403) return { kind: "notOperator" };
  return { kind: "error" };
}

// an application's status in plain words
export function statusText(application: OperatorApplication): string {
  if (application.status === "pending") return "We will look at it and contact you.";
  if (application.status === "approved") return "Approved. We sent your operator key and your server settings to your contact.";
  if (application.status === "declined") return application.staffNote ? "Declined. " + application.staffNote : "Declined.";
  return application.status;
}

// a server's state on the server list in plain words
export function serverText(server: OperatorServer, revoked: boolean): string {
  if (revoked) return "Not on the server list. Your operator key is revoked.";
  if (server.onBoard) return "On the server list." + (server.warning ? " " + server.warning : "");
  if (server.delisted) return "Not on the server list. We took it off. Contact us to put it back.";
  if (!server.listed) return "Not on the server list yet. We put it on the list after we check it.";
  // a server that sent heartbeats before has stopped; "It sends no heartbeats." would read as never
  const why = server.whyNot.map((w) => (w === "It sends no heartbeats." && server.heartbeatAgeSeconds != null ? "Its heartbeats stopped." : w));
  if (why.length > 0) return "Not on the server list now. " + why.join(" ");
  return "Not on the server list now.";
}

// the last heartbeat in plain words
export function heartbeatText(server: OperatorServer): string {
  if (server.heartbeatAgeSeconds == null) return "No heartbeat yet.";
  const s = Math.max(1, Math.round(server.heartbeatAgeSeconds));
  const age = s === 1 ? "1 second" : s < 120 ? `${s} seconds` : s < 7200 ? `${Math.round(s / 60)} minutes` : s < 172800 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 86400)} days`;
  return `Last heartbeat ${age} ago.`;
}

// a server name without the game's colour codes (0xRRGGBB, 0xRESETT), as the page shows it
export function plainName(name: string): string {
  return name.replace(/0x(?:[0-9a-fA-F]{6}|RESETT)/g, "").trim() || name;
}
