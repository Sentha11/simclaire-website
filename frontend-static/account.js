const BACKEND_URL = "https://simclaire-website-backend.onrender.com";

async function loadAccount() {
  const email = document.getElementById("emailInput").value.trim();
  const results = document.getElementById("account-results");

  if (!email) return;

  results.classList.remove("hidden");
  results.innerHTML = "Loading purchases…";

  try {
    const res = await fetch(
      /api/account/purchases?email=${encodeURIComponent(email)}
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
            <button disabled>Resend Instructions</button>
          </div>
        </div>
      `)
      .join("");

  } catch (err) {
    results.innerHTML = "<p>Error loading account data.</p>";
  }
}