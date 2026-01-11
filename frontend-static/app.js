const BACKEND_URL = "https://simclaire-website-backend.onrender.com";

async function searchPlans() {
  const country = document.getElementById("countryInput").value.trim();
  const resultsDiv = document.getElementById("results");

  resultsDiv.innerHTML = "Loading plans...";

  if (!country) {
    resultsDiv.innerHTML = "Please enter a country.";
    return;
  }

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/web/esim/products?country=${encodeURIComponent(country)}`
    );

    const plans = await res.json();

    if (!plans.length) {
      resultsDiv.innerHTML = "No plans found.";
      return;
    }

    resultsDiv.innerHTML = "";

    plans.forEach(p => {
      const div = document.createElement("div");
      div.className = "plan";

      div.innerHTML = `
        <h3>${p.name}</h3>
        <p>📶 Data: ${p.data}</p>
        <p>📅 Validity: ${p.validity} days</p>
        <p>💷 Price: £${p.price}</p>
        <button onclick="checkout('${p.sku}', '${p.name}', '${p.price}', '${p.country}', '${p.destinationId}')">
          Buy Now
        </button>
      `;

      resultsDiv.appendChild(div);
    });

  } catch (err) {
    console.error(err);
    resultsDiv.innerHTML = "Error loading plans.";
  }
}

async function checkout(sku, name, price, country, destinationId) {
  const email = prompt("Enter your email for receipt:");
  const mobile = prompt("Enter your mobile number:");

  if (!email || !mobile) return;

  const res = await fetch(`${BACKEND_URL}/api/payments/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      quantity: 1,
      price,
      currency: "gbp",
      planName: name,
      productSku: sku,
      country,
      destinationId,
      mobile
    })
  });

  const data = await res.json();
  window.location.href = data.url;
}