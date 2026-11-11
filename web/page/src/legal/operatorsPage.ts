// The Apply form and the operator's servers on the server operator agreement (/operators/,
// operators/index.html): the one document with a script. The agreement is static HTML and reads
// without it; the section "Apply" then says how to apply by email. With the script the section
// shows one of its states: signed out, a guest, the form (one application with 1-10 servers), a
// pending application, or, for an approved operator, their servers with a form to add one. The
// calls and the words for their answers: ./operators.ts.
import {
  addServer,
  heartbeatText,
  loadApplications,
  plainName,
  readApiUrl,
  removeServer,
  serverText,
  statusText,
  submitApplication,
  MAX_SERVERS,
  type ApplyInput,
  type Errors,
  type Operator,
  type OperatorApplication,
  type OperatorServer
} from "./operators";

type State = "loading" | "signedOut" | "guest" | "closed" | "error" | "stale" | "form" | "pending" | "operator";

const section = document.getElementById("apply");
if (section) void start(section);

// the messages of a form's fields: each [data-error] span names its field; the field is the
// input in the same .apply-field
function setErrors(form: HTMLFormElement, errors: Errors) {
  let first: HTMLElement | null = null;
  for (const el of form.querySelectorAll<HTMLElement>("[data-error]")) {
    const message = errors[el.dataset.error!] ?? "";
    el.textContent = message;
    const input = el.closest(".apply-field")?.querySelector<HTMLElement>("input, textarea") ?? null;
    if (input) input.toggleAttribute("aria-invalid", !!message);
    if (message && !first) first = input ?? el;
  }
  first?.focus();
}

// a field's message goes when the field changes
function clearOnInput(form: HTMLFormElement) {
  form.addEventListener("input", (event) => {
    const input = event.target as HTMLElement;
    const error = input.closest(".apply-field")?.querySelector<HTMLElement>("[data-error]");
    if (error) error.textContent = "";
    input.removeAttribute("aria-invalid");
  });
}

async function start(root: HTMLElement) {
  const pageVersion = root.dataset.version ?? "";
  const form = root.querySelector<HTMLFormElement>("form[data-apply]")!;
  const mine = root.querySelector<HTMLElement>('[data-apply="mine"]')!;
  const list = root.querySelector<HTMLUListElement>("[data-apply-list]")!;
  const note = root.querySelector<HTMLElement>("[data-apply-note]")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const rows = form.querySelector<HTMLOListElement>("[data-server-rows]")!;
  const rowTemplate = form.querySelector<HTMLTemplateElement>("template[data-server-row]")!;
  const addRow = form.querySelector<HTMLButtonElement>("[data-server-add]")!;
  const fetchFn = window.fetch.bind(window);
  let applications: OperatorApplication[] = [];

  const show = (state: State) => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-apply]")) {
      const name = el.dataset.apply;
      if (name === "mine") continue;
      el.hidden = name !== state;
    }
  };

  const showMine = () => {
    list.replaceChildren(...applications.map(item));
    mine.hidden = applications.length === 0;
  };

  // the server lines: each line's ids, labels and error names follow its place
  const numberRows = () => {
    const lines = [...rows.querySelectorAll<HTMLLIElement>(".apply-row")];
    lines.forEach((li, i) => {
      for (const field of ["address", "name"]) {
        const id = `op-server-${i}-${field}`;
        const input = li.querySelector<HTMLInputElement>(`input[name="${field}"]`)!;
        const label = li.querySelector<HTMLLabelElement>(`label[data-for="${field}"]`)!;
        const error = li.querySelector<HTMLElement>(`[data-error-of="${field}"]`)!;
        input.id = id;
        label.htmlFor = id;
        label.textContent = (field === "address" ? "Server address" : "Server name") + (lines.length > 1 ? ` ${i + 1}` : "");
        error.id = id + "-error";
        error.dataset.error = `servers[${i}].${field}`;
        input.setAttribute("aria-describedby", error.id);
      }
      li.querySelector<HTMLButtonElement>("[data-server-remove]")!.hidden = lines.length === 1;
    });
    addRow.hidden = lines.length >= MAX_SERVERS;
  };
  const newRow = () => {
    rows.append(rowTemplate.content.cloneNode(true));
    numberRows();
  };
  addRow.addEventListener("click", () => {
    newRow();
    rows.querySelector<HTMLInputElement>(".apply-row:last-child input")?.focus();
  });
  rows.addEventListener("click", (event) => {
    const remove = (event.target as HTMLElement).closest("[data-server-remove]");
    if (!remove) return;
    remove.closest(".apply-row")?.remove();
    numberRows();
  });
  newRow();

  show("loading");
  const apiUrl = await readApiUrl(fetchFn);
  const loaded = await loadApplications(fetchFn, apiUrl);
  if (loaded.kind !== "ready") {
    show(loaded.kind);
    return;
  }
  applications = loaded.applications;
  showMine();
  if (loaded.operator) {
    show("operator");
    startOperator(root, loaded.operator, apiUrl, fetchFn);
    return;
  }
  if (applications.some((a) => a.status === "pending" || a.status === "approved")) {
    show("pending");
    return;
  }
  // the page shows one version of the text; the form accepts only that one
  if (loaded.agreementVersion !== pageVersion) {
    show("stale");
    return;
  }
  show("form");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
    const input: ApplyInput = {
      servers: [...rows.querySelectorAll<HTMLLIElement>(".apply-row")].map((li) => ({
        address: li.querySelector<HTMLInputElement>('input[name="address"]')!.value,
        name: li.querySelector<HTMLInputElement>('input[name="name"]')!.value
      })),
      operatorName: value("operatorName"),
      contact: value("contact"),
      note: value("note"),
      accepted: (form.elements.namedItem("accepted") as HTMLInputElement).checked
    };
    note.textContent = "";
    button.disabled = true;
    const result = await submitApplication(fetchFn, apiUrl, input, pageVersion);
    button.disabled = false;
    switch (result.kind) {
      case "applied":
        setErrors(form, {});
        applications = [result.application, ...applications];
        showMine();
        show("pending");
        return;
      case "invalid":
        setErrors(form, result.errors);
        return;
      case "agreementVersion":
        show("stale");
        return;
      case "exists":
        show("pending");
        return;
      case "tooMany":
        setErrors(form, {});
        note.textContent = "You sent too many applications today. Try again tomorrow.";
        return;
      case "error":
        setErrors(form, {});
        note.textContent = "We could not send your application. Try again.";
        return;
      default:
        show(result.kind);
    }
  });
  clearOnInput(form);
}

// an approved operator: their servers, a form to add one, and a button to remove each
function startOperator(root: HTMLElement, operator: Operator, apiUrl: string | null, fetchFn: typeof fetch) {
  const panel = root.querySelector<HTMLElement>('[data-apply="operator"]')!;
  const list = panel.querySelector<HTMLUListElement>("[data-operator-list]")!;
  const count = panel.querySelector<HTMLElement>("[data-operator-count]")!;
  const status = panel.querySelector<HTMLElement>("[data-operator-status]")!;
  const form = panel.querySelector<HTMLFormElement>("form[data-operator-add]")!;
  const note = panel.querySelector<HTMLElement>("[data-operator-note]")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const added = panel.querySelector<HTMLElement>("[data-operator-added]")!;
  const settings = panel.querySelector<HTMLElement>("[data-operator-settings]")!;
  let servers = operator.servers;

  panel.querySelector<HTMLElement>("[data-operator-revoked]")!.hidden = !operator.revoked;
  form.hidden = operator.revoked;

  const showServers = () => {
    list.replaceChildren(...servers.map((s) => serverItem(s, operator.revoked, remove)));
    count.textContent = `You have ${servers.length} of ${operator.maxServers} servers.`;
  };

  const remove = async (server: OperatorServer) => {
    if (!window.confirm(`Remove ${plainName(server.name)}? It goes off the server list. Your operator key stops working for its server id.`)) return;
    status.textContent = "";
    const result = await removeServer(fetchFn, apiUrl, server.serverId);
    if (result.kind === "removed") {
      servers = servers.filter((s) => s.serverId !== server.serverId);
      showServers();
      status.textContent = `We removed ${plainName(server.name)}.`;
    } else if (result.kind === "revoked") {
      status.textContent = "Your operator key is revoked. Contact us.";
    } else if (result.kind === "signedOut") {
      status.textContent = "Sign in again to remove a server.";
    } else {
      status.textContent = "We could not remove the server. Try again.";
    }
  };

  showServers();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
    note.textContent = "";
    button.disabled = true;
    const result = await addServer(fetchFn, apiUrl, { address: value("address"), name: value("name") });
    button.disabled = false;
    switch (result.kind) {
      case "added":
        setErrors(form, {});
        form.reset();
        servers = [...servers, result.server];
        showServers();
        settings.textContent = result.settings;
        added.hidden = false;
        note.textContent = `We added ${plainName(result.server.name)}. Its server id is ${result.server.serverId}.`;
        return;
      case "invalid":
        setErrors(form, result.errors);
        return;
      case "limit":
        setErrors(form, {});
        note.textContent = `You have ${operator.maxServers} servers. Remove one first, or contact us.`;
        return;
      case "revoked":
        setErrors(form, {});
        note.textContent = "Your operator key is revoked. Contact us.";
        return;
      case "signedOut":
        setErrors(form, {});
        note.textContent = "Sign in again to add a server.";
        return;
      default:
        setErrors(form, {});
        note.textContent = "We could not add the server. Try again.";
    }
  });
  clearOnInput(form);
}

function serverItem(server: OperatorServer, revoked: boolean, remove: (s: OperatorServer) => void): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "apply-item" + (server.onBoard && !revoked ? " apply-approved" : "");
  const head = document.createElement("span");
  head.className = "apply-server";
  const name = document.createElement("b");
  name.textContent = plainName(server.name);
  const address = document.createElement("code");
  address.className = "apply-address";
  address.textContent = server.address;
  head.append(name, address);
  const id = document.createElement("span");
  id.className = "apply-when";
  id.textContent = "Server id: " + server.serverId;
  const state = document.createElement("span");
  state.className = "apply-status";
  state.textContent = serverText(server, revoked);
  const beat = document.createElement("span");
  beat.className = "apply-when";
  beat.textContent = heartbeatText(server);
  const details = document.createElement("details");
  details.className = "apply-details";
  const summary = document.createElement("summary");
  summary.textContent = "Settings for this server";
  const pre = document.createElement("pre");
  pre.className = "apply-settings";
  pre.textContent = server.settings;
  details.append(summary, pre);
  li.append(head, id, state, beat, details);
  if (!revoked) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "apply-more";
    button.textContent = "Remove this server";
    button.addEventListener("click", () => remove(server));
    li.append(button);
  }
  return li;
}

function item(application: OperatorApplication): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "apply-item apply-" + application.status;
  const servers = document.createElement("span");
  servers.className = "apply-servers-list";
  for (const s of application.servers) {
    const head = document.createElement("span");
    head.className = "apply-server";
    const name = document.createElement("b");
    name.textContent = plainName(s.name);
    const address = document.createElement("code");
    address.className = "apply-address";
    address.textContent = s.address;
    head.append(name, address);
    servers.append(head);
  }
  const when = document.createElement("span");
  when.className = "apply-when";
  const date = new Date(application.createdAt);
  when.textContent = isNaN(date.getTime()) ? "" : "Sent " + date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + ".";
  const status = document.createElement("span");
  status.className = "apply-status";
  status.textContent = statusText(application);
  li.append(servers, when, status);
  return li;
}
