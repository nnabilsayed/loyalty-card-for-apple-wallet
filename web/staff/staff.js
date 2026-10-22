import { BrowserQRCodeReader } from "@zxing/browser";

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

let card = null; // the card on screen, as the server last described it
let pendingKey = null; // idempotency key of the tap in flight, reused if the tap is retried
let scanControls = null;
let busy = false;

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

function newKey() {
  return crypto.randomUUID();
}

// ---- views -----------------------------------------------------------------

function showSignin() {
  stopScan();
  for (const id of ["bar", "find", "card"]) hide(id);
  show("signin");
  $("pin").value = "";
  $("pin").focus();
}

function showFind() {
  stopScan();
  card = null;
  hide("signin");
  hide("card");
  show("bar");
  show("find");
  $("code").value = "";
}

function showCard(next) {
  card = next;
  stopScan();
  hide("find");
  hide("confirm");
  show("card");
  $("card-phone").textContent = card.phoneMasked;
  $("card-count").textContent = card.freeDrinkEarned ? "Free drink!" : `${card.cups} of ${card.rewardGoal}`;
  $("card-earned").classList.toggle("hidden", !card.freeDrinkEarned);
  $("stamp").classList.toggle("hidden", card.freeDrinkEarned);
  $("redeem").classList.toggle("hidden", !card.freeDrinkEarned);
  $("undo").classList.toggle("hidden", !card.canUndo);
}

// ---- sign in / out -----------------------------------------------------------

async function start() {
  const { status, data } = await api("GET", "/api/staff/me").catch(() => ({ status: 0, data: {} }));
  if (status === 200) {
    $("who").textContent = `Signed in as ${data.name}`;
    showFind();
  } else {
    showSignin();
  }
}

$("signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearSay();
  const pin = $("pin").value.trim();
  if (!/^[0-9]{6}$/.test(pin)) {
    say("Enter your 6-digit PIN.", "error");
    return;
  }
  try {
    const { status, data } = await api("POST", "/api/staff/login", { pin });
    if (status === 200) {
      $("who").textContent = `Signed in as ${data.name}`;
      showFind();
    } else if (status === 429) {
      say("Too many tries. Wait a minute and try again.", "error");
    } else {
      say("That PIN is not right.", "error");
      $("pin").value = "";
    }
  } catch {
    say("Cannot reach the server. Check the Wi-Fi and try again.", "error");
  }
});

$("signout").addEventListener("click", async () => {
  await api("POST", "/api/staff/logout").catch(() => undefined);
  clearSay();
  showSignin();
});

// ---- finding a card ----------------------------------------------------------

async function lookup(code) {
  clearSay();
  const serial = code.trim();
  if (!serial) {
    say("Type or scan a card code.", "error");
    return;
  }
  try {
    const { status, data } = await api("GET", `/api/staff/cards/${encodeURIComponent(serial)}`);
    if (status === 200) return showCard(data);
    if (status === 401) return sessionEnded();
    say("Card not recognized. Check the code and try again.", "error");
  } catch {
    say("Cannot reach the server. Check the Wi-Fi and try again.", "error");
  }
}

function sessionEnded() {
  say("You were signed out. Please sign in again.", "error");
  showSignin();
}

$("manual-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void lookup($("code").value);
});

async function startScan() {
  clearSay();
  show("camera");
  hide("start-scan");
  try {
    const reader = new BrowserQRCodeReader();
    scanControls = await reader.decodeFromVideoDevice(undefined, $("video"), (result) => {
      if (result && !busy) {
        busy = true;
        const text = result.getText();
        stopScan();
        lookup(text).finally(() => (busy = false));
      }
    });
  } catch {
    stopScan();
    say("Cannot open the camera. Allow camera access, or type the card code instead.", "error");
  }
}

function stopScan() {
  if (scanControls) {
    scanControls.stop();
    scanControls = null;
  }
  hide("camera");
  show("start-scan");
}

$("start-scan").addEventListener("click", () => void startScan());
$("stop-scan").addEventListener("click", stopScan);
$("next").addEventListener("click", () => {
  clearSay();
  showFind();
});

// ---- stamping ----------------------------------------------------------------

async function doStamp(force) {
  if (!card) return;
  clearSay();
  $("stamp").disabled = true;
  // The same key is reused if this tap has to be retried, so a retry can never stamp twice.
  pendingKey ??= newKey();
  try {
    const { status, data } = await api("POST", `/api/staff/cards/${encodeURIComponent(card.serial)}/stamp`, {
      idempotencyKey: pendingKey,
      force,
    });
    if (status === 200) {
      pendingKey = null;
      showCard(data);
      say(data.freeDrinkEarned ? "Stamped. Free drink earned!" : `Stamped. ${data.cups} of ${data.rewardGoal}.`, "ok");
    } else if (status === 409 && data.reason === "cooldown") {
      pendingKey = null;
      $("confirm-text").textContent = data.message;
      show("confirm");
    } else if (status === 409 && data.reason === "redeem_first") {
      pendingKey = null;
      say(data.message, "error");
    } else if (status === 401) {
      sessionEnded();
    } else {
      pendingKey = null;
      say("Card not recognized. Scan it again.", "error");
    }
  } catch {
    // Keep pendingKey: tapping again retries the same stamp safely.
    say("Cannot reach the server. Tap again when the Wi-Fi is back. It will not stamp twice.", "error");
  } finally {
    $("stamp").disabled = false;
  }
}

async function doRedeem() {
  if (!card) return;
  clearSay();
  $("redeem").disabled = true;
  try {
    const { status, data } = await api("POST", `/api/staff/cards/${encodeURIComponent(card.serial)}/redeem`);
    if (status === 200) {
      showCard(data);
      say("Free drink redeemed. The card starts again at 0.", "ok");
    } else if (status === 409) {
      say(data.message, "error");
    } else if (status === 401) {
      sessionEnded();
    } else {
      say("Card not recognized. Scan it again.", "error");
    }
  } catch {
    say("Cannot reach the server. Check the Wi-Fi, then look the card up again before trying once more.", "error");
  } finally {
    $("redeem").disabled = false;
  }
}

async function doUndo() {
  if (!card) return;
  clearSay();
  $("undo").disabled = true;
  try {
    const { status, data } = await api("POST", `/api/staff/cards/${encodeURIComponent(card.serial)}/undo`);
    if (status === 200) {
      showCard(data);
      say(`Stamp undone. Back to ${data.cups} of ${data.rewardGoal}.`, "ok");
    } else if (status === 409) {
      say(data.message, "error");
      void lookup(card.serial);
    } else if (status === 401) {
      sessionEnded();
    } else {
      say("Card not recognized. Scan it again.", "error");
    }
  } catch {
    say("Cannot reach the server. Check the Wi-Fi, then look the card up again before trying once more.", "error");
  } finally {
    $("undo").disabled = false;
  }
}

$("stamp").addEventListener("click", () => void doStamp(false));
$("undo").addEventListener("click", () => void doUndo());
$("redeem").addEventListener("click", () => void doRedeem());
$("confirm-yes").addEventListener("click", () => void doStamp(true));
$("confirm-no").addEventListener("click", () => {
  hide("confirm");
  clearSay();
});

void start();
