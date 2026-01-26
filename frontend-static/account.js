const BACKEND_URL = "https://simclaire-website-backend.onrender.com";

const emailInput = document.getElementById("emailInput");
const resultsDiv = document.getElementById("accountResults");
const actionsDiv = document.getElementById("accountActions");
const statusText = document.getElementById("accountStatus");

// ===============================
// LOAD ACCOUNT PURCHASES
// ===============================
async function loadAccount() {
  const email = emailInput.value.trim();

  if (!email) return;

  resultsDiv.classList.remove("hidden");
  resultsDiv.innerHTML = "🔍 Looking up purchases…";
  actionsDiv.classList.add("hidden");
  statusText.textContent = "";

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/account/purchases?email=${encodeURIComponent(email)}`
    );

    const data = await res.json();

    if (!res.ok || !data.purchases || data.purchases.length === 0) {
      resultsDiv.innerHTML =
        "<p>❌ No purchases found for this email.</p>";
      return;
    }

    // Sort newest first
    const purchases = data.purchases
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10);

    resultsDiv.innerHTML = purchases.map(p => `
      <div class="glass-card account-card">

        <div class="account-header">
          <h3>${p.product_sku || "eSIM Plan"}</h3>
          <span class="status-badge ${getStatusClass(p.esim_status)}">
            ${getStatusLabel(p.esim_status)}
          </span>
        </div>

        <p>🌍 ${p.country || "—"}</p>
        <p>📅 ${new Date(p.created_at).toLocaleString()}</p>

       ${
  p.activation_code
    ? `
      <div class="activation-box">
        <code id="code-${p.id}">${p.activation_code}</code>
        <button class="copy-btn" onclick="copyCode('code-${p.id}')">
          📋 Copy
        </button>
      </div>
    `
    : `
      <p class="muted">Activation code not issued yet</p>
    `
}

        <div class="account-actions">
          <button onclick="resendEmail('${p.id}')">📩 Email</button>
          <button onclick="resendWhatsApp('${p.id}')">💬 WhatsApp</button>
        </div>

      </div>
    `).join("");

    // ✅ Purchases exist → enable resend
    actionsDiv.classList.remove("hidden");

  } catch (err) {
    console.error(err);
    resultsDiv.innerHTML =
      "<p>⚠️ Error loading account data.</p>";
  }
}

// ===============================
// SEND eSIM INSTRUCTIONS
// ===============================
async function sendInstructions() {
  const email = emailInput.value.trim();
  if (!email) return;

  statusText.textContent = "📡 Sending instructions…";

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/account/send-instructions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      }
    );

    const data = await res.json();

    if (!res.ok) {
      statusText.textContent =
        data.error || "❌ Failed to send instructions";
      return;
    }

    statusText.textContent =
      "✅ Instructions sent! Please check your email.";

  } catch (err) {
    console.error(err);
    statusText.textContent =
      "❌ Error sending instructions";
  }
}

function copyCode(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;

  navigator.clipboard.writeText(el.textContent)
    .then(() => {
      alert("Activation code copied!");
    })
    .catch(() => {
      alert("Failed to copy code");
    });
}

async function resendEmail(orderId) {
  await fetch(`${BACKEND_URL}/api/account/resend-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId })
  });

  alert("eSIM instructions sent via email");
}

async function resendWhatsApp(orderId) {
  await fetch(`${BACKEND_URL}/api/account/resend-whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId })
  });

  alert("eSIM instructions sent via WhatsApp");
}

function getStatusLabel(status) {
  if (!status) return "Delivered";

  switch (status.toLowerCase()) {
    case "active":
      return "Active";
    case "expired":
      return "Expired";
    default:
      return "Delivered";
  }
}

function getStatusClass(status) {
  if (!status) return "status-delivered";

  switch (status.toLowerCase()) {
    case "active":
      return "status-active";
    case "expired":
      return "status-expired";
    default:
      return "status-delivered";
  }
}