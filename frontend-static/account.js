const BACKEND_URL = "https://simclaire-website-backend.onrender.com";

async function loadAccount() {
  const email = document.getElementById("emailInput").value.trim();
  const results = document.getElementById("account-results");

  if (!email) return;

  results.classList.remove("hidden");
  results.innerHTML = "Loading purchases…";

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/account/purchases?email=${encodeURIComponent(email)}`
    );
    const data = await res.json();

    if (!data.purchases || data.purchases.length === 0) {
      results.innerHTML = "<p>No purchases found for this email.</p>";
      return;
    }

    const purchases = data.purchases
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10);

    results.innerHTML = purchases
      .map(p => `
        <div class="glass-card account-card">
          <h3>${p.planName}</h3>
          <p>🌍 ${p.country}</p>
          <p>💷 ${p.price} ${p.currency}</p>
          <p>📅 ${new Date(p.date).toLocaleString()}</p>

          <div class="account-actions">
            <button disabled>View Instructions</button>
            <button onclick="resendInstructions('${p.id}')"> Resend Instructions</button>
          </div>
        </div>
      `)
      .join("");

  } catch (err) {
    results.innerHTML = "<p>Error loading account data.</p>";
  }
}

async function resendInstructions(sessionId) {
  await fetch("/api/account/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId })
  });

  alert("Instructions resent (test mode).");
}

const emailInput = document.getElementById("emailInput");
const confirmEmailInput = document.getElementById("confirmEmailInput");
const sendBtn = document.getElementById("sendInstructionsBtn");
const statusText = document.getElementById("accountStatus");

function checkEmailMatch() {
  if (
    emailInput.value &&
    confirmEmailInput.value &&
    emailInput.value === confirmEmailInput.value
  ) {
    sendBtn.style.display = "block";
    statusText.textContent = "✅ Email confirmed";
  } else {
    sendBtn.style.display = "none";
    statusText.textContent = "";
  }
}

emailInput?.addEventListener("input", checkEmailMatch);
confirmEmailInput?.addEventListener("input", checkEmailMatch);

sendBtn?.addEventListener("click", async () => {
  const email = emailInput.value.trim();

  statusText.textContent = "📡 Sending instructions...";

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
      statusText.textContent = data.error || "Failed to send instructions";
      return;
    }

    statusText.textContent =
      "✅ Instructions sent! Check your email.";

  } catch (err) {
    console.error(err);
    statusText.textContent = "❌ Error sending instructions";
  }
});