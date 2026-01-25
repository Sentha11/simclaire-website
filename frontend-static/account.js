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

    resultsDiv.innerHTML = purchases
      .map(p => `
        <div class="glass-card account-card">
          <h3>${p.product_sku || "eSIM Plan"}</h3>
          <p>🌍 ${p.country || "—"}</p>
          <p>💷 ${p.amount} ${p.currency}</p>
          <p>📅 ${new Date(p.created_at).toLocaleString()}</p>
          <p>📶 Status: ${p.payment_status}</p>
        </div>
      `)
      .join("");

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