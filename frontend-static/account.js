const BACKEND_URL = "https://simclaire-website-backend.onrender.com";

async function loadAccount() {
  const email = document.getElementById('emailInput').value.trim();
  const results = document.getElementById('accountResults');

  if (!email) {
    results.innerHTML = '<p>Please enter an email.</p>';
    return;
  }

  results.innerHTML = 'Loading…';

  try {
    const res = await fetch(`${BACKEND_URL}/api/account/purchases?email=${encodeURIComponent(email)}`);
    const data = await res.json();

    if (!data.length) {
      results.innerHTML = '<p>No purchases found for this email.</p>';
      return;
    }

    results.innerHTML = data.map(p => `
      <div class="account-order">
        <h3>${p.productName}</h3>
        <p>Data: ${p.data}</p>
        <p>Validity: ${p.validity}</p>
        <p>Status: ${p.status}</p>
        <button>View eSIM Instructions</button>
      </div>
    `).join('');

  } catch (err) {
    results.innerHTML = '<p>Error loading account.</p>';
  }
}