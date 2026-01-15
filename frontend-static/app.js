const BACKEND_URL = "https://simclaire-website-backend.onrender.com";
let currentPlans = [];

/* =========================
   SEARCH + LOAD PLANS
========================= */
async function searchPlans() {
  const country = document.getElementById("countryInput")?.value.trim();
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
    currentPlans = plans;

    // ✅ Hide homepage FAQ when browsing plans
    document.getElementById("homepage-faq")?.classList.add("hidden");

    renderPlans(plans);
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
   RENDER PLANS
========================= */
function renderPlans(plans) {
  const resultsDiv = document.getElementById("results");
  resultsDiv.innerHTML = "";

  if (!plans || !plans.length) {
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
}

/* =========================
   SORT PLANS
========================= */
function sortPlans() {
  const sortValue = document.getElementById("priceSort")?.value;
  let sorted = [...currentPlans];

  if (sortValue === "low-high") {
    sorted.sort((a, b) => Number(a.price) - Number(b.price));
  }

  if (sortValue === "high-low") {
    sorted.sort((a, b) => Number(b.price) - Number(a.price));
  }

  renderPlans(sorted);
}

/* =========================
   AUTOCOMPLETE COUNTRIES
========================= */
const countries = [
  "United Kingdom", "United States", "Italy", "France",
  "Spain", "Germany", "India", "Canada", "Australia",
  "Japan", "South Korea", "Thailand"
];

const input = document.getElementById("countryInput");
const suggestions = document.getElementById("suggestions");

if (input && suggestions) {
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
}

/* =========================
   HERO BACKGROUND CROSSFADE
========================= */
const backgrounds = document.querySelectorAll(".bg-layer");
let currentBg = 0;

if (backgrounds.length) {
  setInterval(() => {
    backgrounds[currentBg].classList.remove("active");
    currentBg = (currentBg + 1) % backgrounds.length;
    backgrounds[currentBg].classList.add("active");
  }, 10000);
}

/* =========================
   STAR + HERO PARALLAX
========================= */
const starsSmall = document.querySelector(".stars-small");
const starsLarge = document.querySelector(".stars-large");

function parallaxMove(e) {
  const x = (e.clientX / window.innerWidth - 0.5) * 20;
  const y = (e.clientY / window.innerHeight - 0.5) * 20;

  starsSmall && (starsSmall.style.transform = `translate(${x}px, ${y}px)`);
  starsLarge && (starsLarge.style.transform = `translate(${x * 1.8}px, ${y * 1.8}px)`);
}

if (window.innerWidth >= 768) {
  document.addEventListener("mousemove", parallaxMove);
}

function goHome() {
  // Clear results
  const resultsDiv = document.getElementById("results");
  resultsDiv.innerHTML = "";

  // Clear input
  const input = document.getElementById("countryInput");
  if (input) input.value = "";

  // Reset sort
  const sort = document.getElementById("priceSort");
  if (sort) sort.value = "";

  // Show FAQ again
  document.getElementById("homepage-faq")?.classList.remove("hidden");

  // Scroll back to hero
  document.querySelector(".hero")?.scrollIntoView({
    behavior: "smooth"
  });
}