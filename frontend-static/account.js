const BACKEND_URL = "https://simclaire-website-backend.onrender.com";

async function loadAccount() {
  const email = document.getElementById("accountEmail").value.trim();
  const status = document.getElementById("accountStatus");
  const results = document.getElementById("accountResults");

  if (!email) {
    status.innerText = "Please enter your email.";
    return;
  }

  status.innerText = "Loading your account...";
  results.innerHTML = "";

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/account/orders?email=${encodeURIComponent(email)}`
    );

    const data = await res.json();

    if (!data.length) {
      status.innerText = "No purchases found for this email.";
      return;
    }

    status.innerText = "";

    data.forEach(order => {
      const div = document.createElement("div");
      div.className = "account-order";

      div.innerHTML = `
        <h3>${order.planName}</h3>
        <p>📍 Country: ${order.country}</p>
        <p>📦 Status: <strong>${order.status}</strong></p>
        <p>📧 Email: ${order.email}</p>
      `;

      results.appendChild(div);
    });

  } catch (err) {
    console.error(err);
    status.innerText = "Error loading account.";
  }
}