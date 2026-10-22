const form = document.getElementById("join-form");
const phone = document.getElementById("phone");
const submit = document.getElementById("submit");
const message = document.getElementById("message");
const done = document.getElementById("done");
const walletLink = document.getElementById("wallet-link");

function showError(text) {
  message.textContent = text;
  message.className = "message error";
}

function clearError() {
  message.textContent = "";
  message.className = "message hidden";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  if (!phone.value.trim()) {
    showError("Please enter your phone number.");
    phone.focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = "Please wait...";
  try {
    const res = await fetch("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: phone.value }),
    });
    const body = await res.json().catch(() => ({}));

    if (res.status === 201) {
      form.classList.add("hidden");
      done.classList.remove("hidden");
      walletLink.href = body.passUrl;
      // On an iPhone this opens the "Add to Wallet" sheet straight away.
      window.location.href = body.passUrl;
      return;
    }
    if (res.status === 429) {
      showError("Too many tries. Please wait a minute and try again.");
    } else {
      showError(body.error || "Something went wrong. Please try again.");
    }
  } catch {
    showError("Could not reach the server. Check your connection and try again.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Get my card";
  }
});
