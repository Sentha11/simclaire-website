const BACKEND_URL = "https://simclaire-website-backend.onrender.com";

/* =========================
   SEARCH + LOAD PLANS
========================= */
async function searchPlans() {
  const country = document.getElementById("countryInput").value.trim();
  const resultsDiv = document.getElementById("results");

  if (!country) {
    resultsDiv.innerHTML = "<p>Please enter a country.</p>";
    return;
  }

  resultsDiv.innerHTML = "Loading plans...";

  try {
    const res = await fetch(
      `${BACKEND_URL}/api/web/esim/products?country=${encodeURIComponent(country)}`
    );

    const plans = await res.json();
    resultsDiv.innerHTML = "";

    if (!plans.length) {
      resultsDiv.innerHTML = "No plans found.";
      return;
    }

    plans.forEach(p => {
      const div = document.createElement("div");
      div.className = "plan";

      div.innerHTML = `
        <h3>${p.name}</h3>
        <p>📶 Data: ${p.data}</p>
        <p>📅 Validity: ${p.validity} days</p>
        <p>💷 Price: £${p.price}</p>
        <button onclick="checkout(
          '${p.sku}',
          '${p.name}',
          '${p.price}',
          '${p.country}',
          '${p.destinationId}'
        )">Buy Now</button>
      `;

      resultsDiv.appendChild(div);
    });

    resultsDiv.scrollIntoView({ behavior: "smooth" });

  } catch (err) {
    console.error(err);
    resultsDiv.innerHTML = "Error loading plans.";
  }
}

/* =========================
   CHECKOUT
========================= */
async function checkout(sku, name, price, country, destinationId) {
  const email = prompt("Enter your email for receipt:");
  const mobile = prompt("Enter your mobile number:");

  if (!email || !mobile) return;

  const res = await fetch(
    `${BACKEND_URL}/api/payments/create-checkout-session`,
    {
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
    }
  );

  const data = await res.json();
  window.location.href = data.url;
}

/* =========================
   HERO PARALLAX
========================= */
document.addEventListener("mousemove", (e) => {
  const x = (e.clientX / window.innerWidth - 0.5) * 12;
  const y = (e.clientY / window.innerHeight - 0.5) * 12;
  document.documentElement.style.setProperty(
    "--parallax",
    `translate(${x}px, ${y}px)`
  );
});

const countries = [
  "United Kingdom", "United States", "Italy", "France",
  "Spain", "Germany", "India", "Canada", "Australia",
  "Japan", "South Korea", "Thailand"
];

const input = document.getElementById("countryInput");
const suggestions = document.getElementById("suggestions");

input.addEventListener("input", () => {
  const val = input.value.toLowerCase();
  suggestions.innerHTML = "";

  if (!val) {
    suggestions.style.display = "none";
    return;
  }

  countries
    .filter(c => c.toLowerCase().includes(val))
    .slice(0, 6)
    .forEach(country => {
      const div = document.createElement("div");
      div.className = "suggestion-item";
      div.textContent = country;
      div.onclick = () => {
        input.value = country;
        suggestions.style.display = "none";
      };
      suggestions.appendChild(div);
    });

  suggestions.style.display = "block";
});