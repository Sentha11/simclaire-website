async function searchPlans(country) {
  if (country.length < 3) return;

  document.getElementById("loading").innerText = "Loading plans...";
  document.getElementById("plansList").innerHTML = "";

  const res = await fetch(
    `/api/web/esim/products?country=${encodeURIComponent(country)}`
  );

  const plans = await res.json();
  document.getElementById("loading").innerText = "";

  plans.forEach(p => {
    const div = document.createElement("div");
    div.className = "plan";

    div.innerHTML = `
      <strong>${p.name}</strong>
      <p>${p.data} · ${p.validity} days</p>
      <h3>£${p.price}</h3>
      <button onclick='buy("${p.sku}", "${p.name}", ${p.price}, "${p.destinationId}")'>
        Buy eSIM
      </button>
    `;

    document.getElementById("plansList").appendChild(div);
  });
}

async function buy(sku, name, price, destinationId) {
  const res = await fetch("/api/payments/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "care@simclaire.com",
      quantity: 1,
      price,
      planName: name,
      productSku: sku,
      destinationId,
      mobile: "web"
    })
  });

  const data = await res.json();
  window.location.href = data.url;
}