const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

function say(text, kind = "info") {
  const el = $("status");
  el.textContent = text;
  el.className = `message ${kind}`;
}

function clearSay() {
  $("status").className = "message hidden";
  $("status").textContent = "";
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function sessionEnded() {
  say("You were signed out. Please sign in again.", "error");
  showSignin();
}

// ---- views -----------------------------------------------------------------

function showSignin() {
  hide("bar");
  hide("dashboard");
  show("signin");
  $("password").value = "";
  $("username").focus();
}

async function showDashboard(name) {
  hide("signin");
  show("bar");
  show("dashboard");
  $("who").textContent = `Signed in as ${name}`;
  await Promise.all([loadSettings(), loadBaristas(), loadAnnouncements(), loadRecords()]);
}

async function start() {
  try {
    const { status, data } = await api("GET", "/api/admin/me");
    if (status === 200) return showDashboard(data.name);
  } catch {
    // fall through to the sign-in form
  }
  showSignin();
}

$("signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearSay();
  const username = $("username").value.trim();
  const password = $("password").value;
  if (!username || !password) {
    say("Enter your username and password.", "error");
    return;
  }
  try {
    const { status } = await api("POST", "/api/admin/login", { username, password });
    if (status === 200) {
      const me = await api("GET", "/api/admin/me");
      return showDashboard(me.data.name);
    }
    say(status === 429 ? "Too many tries. Wait a minute and try again." : "Wrong username or password.", "error");
  } catch {
    say("Cannot reach the server. Check the connection and try again.", "error");
  }
});

$("signout").addEventListener("click", async () => {
  await api("POST", "/api/admin/logout").catch(() => undefined);
  clearSay();
  showSignin();
});

// ---- reward goal -----------------------------------------------------------

async function loadSettings() {
  const { status, data } = await api("GET", "/api/admin/settings");
  if (status === 401) return sessionEnded();
  $("goal").value = data.rewardGoal;
}

$("goal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearSay();
  const raw = $("goal").value.trim();
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
    say("The goal must be a whole number of 1 or more.", "error");
    return;
  }
  try {
    const { status, data } = await api("PUT", "/api/admin/settings", { rewardGoal: Number(raw) });
    if (status === 200) {
      $("goal").value = data.rewardGoal;
      say(`Saved. A free drink now takes ${data.rewardGoal} ${data.rewardGoal === 1 ? "cup" : "cups"}.`, "ok");
      await loadRecords();
    } else if (status === 401) {
      sessionEnded();
    } else {
      say(data.error || "Could not save the goal.", "error");
    }
  } catch {
    say("Cannot reach the server. The goal was not saved.", "error");
  }
});

// ---- baristas --------------------------------------------------------------

function button(label, className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener("click", onClick);
  return b;
}

/** A small form under a barista's row. `onSubmit` gets the typed value. */
function inlineForm(row, { label, type, inputmode, maxlength, value, submitLabel, onSubmit }) {
  row.querySelector(".inline-form")?.remove();
  const form = document.createElement("form");
  form.className = "inline-form";
  form.noValidate = true;
  const input = document.createElement("input");
  input.type = type;
  if (inputmode) input.inputMode = inputmode;
  if (maxlength) input.maxLength = maxlength;
  input.value = value ?? "";
  input.setAttribute("aria-label", label);
  input.autocomplete = "off";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = submitLabel;
  const cancel = button("Cancel", "secondary", () => form.remove());
  form.append(input, save, cancel);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void onSubmit(input.value.trim());
  });
  row.appendChild(form);
  input.focus();
}

function confirmForm(row, { text, submitLabel, onConfirm }) {
  row.querySelector(".inline-form")?.remove();
  const form = document.createElement("div");
  form.className = "inline-form";
  const message = document.createElement("span");
  message.textContent = text;
  form.append(message, button(submitLabel, "danger", () => void onConfirm()), button("Cancel", "secondary", () => form.remove()));
  row.appendChild(form);
}

async function saveBarista(id, changes, doneMessage) {
  clearSay();
  try {
    const { status, data } = await api("PATCH", `/api/admin/baristas/${id}`, changes);
    if (status === 200) {
      say(doneMessage, "ok");
      await Promise.all([loadBaristas(), loadRecords()]);
    } else if (status === 401) {
      sessionEnded();
    } else if (status === 409) {
      say("That PIN is already used by another barista. Choose a different one.", "error");
    } else if (status === 422) {
      say("A PIN is exactly six digits, and a name cannot be empty.", "error");
    } else {
      say(data.error || "Could not save the change.", "error");
    }
  } catch {
    say("Cannot reach the server. Nothing was changed.", "error");
  }
}

async function loadBaristas() {
  const { status, data } = await api("GET", "/api/admin/baristas");
  if (status === 401) return sessionEnded();
  const list = $("barista-list");
  list.textContent = "";
  for (const b of data) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "barista-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = b.name;
    const actions = document.createElement("div");
    actions.className = "barista-actions";
    actions.append(
      button("Change PIN", "secondary small", () =>
        inlineForm(li, {
          label: `New PIN for ${b.name}`,
          type: "password",
          inputmode: "numeric",
          maxlength: 6,
          submitLabel: "Save PIN",
          onSubmit: (pin) => saveBarista(b.id, { pin }, `New PIN saved for ${b.name}.`),
        }),
      ),
      button("Rename", "secondary small", () =>
        inlineForm(li, {
          label: `New name for ${b.name}`,
          type: "text",
          maxlength: 60,
          value: b.name,
          submitLabel: "Save name",
          onSubmit: (newName) => saveBarista(b.id, { name: newName }, `Renamed to ${newName}.`),
        }),
      ),
      button("Remove", "danger small", () =>
        confirmForm(li, {
          text: `Remove ${b.name}? They are signed out at once. Their earlier records stay.`,
          submitLabel: "Yes, remove",
          onConfirm: async () => {
            clearSay();
            const res = await api("DELETE", `/api/admin/baristas/${b.id}`).catch(() => ({ status: 0 }));
            if (res.status === 204) {
              say(`${b.name} was removed.`, "ok");
              await Promise.all([loadBaristas(), loadRecords()]);
            } else if (res.status === 401) {
              sessionEnded();
            } else {
              say("Could not remove the barista.", "error");
            }
          },
        }),
      ),
    );
    row.append(name, actions);
    li.appendChild(row);
    list.appendChild(li);
  }
  $("barista-empty").classList.toggle("hidden", data.length > 0);
}

$("barista-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearSay();
  const name = $("b-name").value.trim();
  const pin = $("b-pin").value.trim();
  if (!name) {
    say("Enter the barista's name.", "error");
    return;
  }
  if (!/^[0-9]{6}$/.test(pin)) {
    say("The PIN must be exactly 6 digits.", "error");
    return;
  }
  try {
    const { status } = await api("POST", "/api/admin/baristas", { name, pin });
    if (status === 201) {
      $("b-name").value = "";
      $("b-pin").value = "";
      say(`${name} was added. They can sign in to the staff app with their PIN.`, "ok");
      await Promise.all([loadBaristas(), loadRecords()]);
    } else if (status === 409) {
      say("That PIN is already used by another barista. Choose a different one.", "error");
    } else if (status === 401) {
      sessionEnded();
    } else {
      say("Could not add the barista.", "error");
    }
  } catch {
    say("Cannot reach the server. Nothing was saved.", "error");
  }
});

// ---- announcements ---------------------------------------------------------

async function loadAnnouncements() {
  const { status, data } = await api("GET", "/api/admin/announcements?limit=10");
  if (status === 401) return sessionEnded();
  const list = $("news-history");
  list.textContent = "";
  for (const a of data) {
    const li = document.createElement("li");
    li.textContent = a.text;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${new Date(a.sentAt).toLocaleString()} by ${a.sentBy}, ${a.cardsTargeted} ${a.cardsTargeted === 1 ? "card" : "cards"}`;
    li.appendChild(meta);
    list.appendChild(li);
  }
  $("news-empty").classList.toggle("hidden", data.length > 0);
}

$("news-text").addEventListener("input", () => {
  $("news-count").textContent = String(Array.from($("news-text").value).length);
});

$("news-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearSay();
  const text = $("news-text").value.trim();
  const length = Array.from(text).length;
  if (length < 1 || length > 200) {
    say("Write a message of 1 to 200 characters.", "error");
    return;
  }
  try {
    const { status, data } = await api("POST", "/api/admin/announcements", { text });
    if (status === 202) {
      $("news-text").value = "";
      $("news-count").textContent = "0";
      say(`Sent to ${data.cardsTargeted} ${data.cardsTargeted === 1 ? "card" : "cards"}. Phones update within a few minutes.`, "ok");
      await Promise.all([loadAnnouncements(), loadRecords()]);
    } else if (status === 401) {
      sessionEnded();
    } else {
      say(data.error || "Could not send the announcement.", "error");
    }
  } catch {
    say("Cannot reach the server. Nothing was sent.", "error");
  }
});

// ---- customers -------------------------------------------------------------

let foundCustomer = null;

function resetCustomer() {
  foundCustomer = null;
  hide("customer-result");
  hide("reissue-confirm");
  hide("reissue-done");
  show("reissue");
}

$("customer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearSay();
  resetCustomer();
  const phone = $("c-phone").value.trim();
  if (!phone) {
    say("Enter the customer's phone number.", "error");
    return;
  }
  try {
    const { status, data } = await api("GET", `/api/admin/customers?phone=${encodeURIComponent(phone)}`);
    if (status === 200) {
      foundCustomer = data;
      $("customer-phone").textContent = data.phone;
      $("customer-summary").textContent = data.freeDrinkEarned
        ? "Has a free drink waiting."
        : `${data.cups} of ${data.rewardGoal} cups. Customer since ${new Date(data.createdAt).toLocaleDateString()}.`;
      show("customer-result");
    } else if (status === 404) {
      say("No customer has that number.", "error");
    } else if (status === 422) {
      say("That does not look like a valid phone number.", "error");
    } else if (status === 401) {
      sessionEnded();
    } else {
      say("Could not look the customer up.", "error");
    }
  } catch {
    say("Cannot reach the server.", "error");
  }
});

$("reissue").addEventListener("click", () => {
  hide("reissue");
  show("reissue-confirm");
});

$("reissue-no").addEventListener("click", () => {
  hide("reissue-confirm");
  show("reissue");
});

$("reissue-yes").addEventListener("click", async () => {
  if (!foundCustomer) return;
  clearSay();
  try {
    const { status, data } = await api("POST", `/api/admin/customers/${foundCustomer.customerId}/reissue`);
    if (status === 201) {
      const url = new URL(data.passUrl, window.location.origin).href;
      $("reissue-link").href = url;
      $("reissue-link").textContent = url;
      hide("reissue-confirm");
      show("reissue-done");
      await loadRecords();
    } else if (status === 401) {
      sessionEnded();
    } else {
      say("Could not issue a replacement card.", "error");
    }
  } catch {
    say("Cannot reach the server. Nothing was changed.", "error");
  }
});

// ---- records ---------------------------------------------------------------

const TYPE_LABELS = {
  stamp: "Stamp",
  stamp_forced: "Confirmed repeat stamp",
  redeem: "Free drink redeemed",
  undo: "Undo",
  goal_change: "Goal changed",
  announcement: "Announcement",
  card_issued: "Card issued",
  card_reissued: "Replacement card",
  barista_added: "Barista added",
  barista_removed: "Barista removed",
  barista_pin_changed: "PIN changed",
  barista_renamed: "Barista renamed",
};

function describe(row) {
  const { before, after } = row;
  switch (row.type) {
    case "stamp":
    case "stamp_forced":
    case "undo":
    case "redeem":
      return before && after ? `${before.cups} → ${after.cups} cups` : "";
    case "goal_change":
      return `Goal ${before?.rewardGoal} → ${after?.rewardGoal}`;
    case "announcement":
      return after?.text ? `"${after.text}" (${after.cardsTargeted} cards)` : "";
    case "barista_renamed":
      return `${before?.name} → ${after?.name}`;
    case "barista_added":
    case "barista_removed":
    case "barista_pin_changed":
      return after?.name || before?.name || "";
    default:
      return "";
  }
}

function startOfDay(value) {
  return value ? new Date(`${value}T00:00:00`).toISOString() : "";
}

function endOfDay(value) {
  return value ? new Date(`${value}T23:59:59.999`).toISOString() : "";
}

async function loadRecords() {
  const params = new URLSearchParams();
  const set = (key, value) => value && params.set(key, value);
  set("type", $("f-type").value);
  set("actor", $("f-actor").value.trim());
  set("from", startOfDay($("f-from").value));
  set("to", endOfDay($("f-to").value));
  params.set("limit", "200");

  const { status, data } = await api("GET", `/api/admin/ledger?${params}`);
  if (status === 401) return sessionEnded();
  if (status !== 200) {
    say("Could not load the records.", "error");
    return;
  }

  const body = $("records").querySelector("tbody");
  body.textContent = "";
  for (const row of data) {
    const tr = document.createElement("tr");
    const cells = [
      new Date(row.at).toLocaleString(),
      TYPE_LABELS[row.type] || row.type,
      row.actorName,
      row.cardRef || "",
      describe(row),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      if (i === 4) td.className = "details";
      td.textContent = text;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  $("records-empty").classList.toggle("hidden", data.length > 0);
}

$("filter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  clearSay();
  void loadRecords();
});

void start();
