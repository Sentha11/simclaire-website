console.log("app.js loaded");
const BACKEND_URL = "https://simclaire-website-backend.onrender.com";
let currentPlans = [];

const sortWrapper = document.getElementById("sortWrapper");

/* =========================
   SEARCH + LOAD PLANS
========================= */
async function searchPlans() {
  console.log("Browse Plans Clicked");
  const country = document.getElementById("countryInput")?.value.trim();
  console.log("🌍 Country input value:", country);
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
    if (plans.length > 0) {
      sortWrapper?.classList.remove("hidden");
    } else {
      sortWrapper?.classList.add("hidden");
    }
    currentPlans = plans;

    // ✅ Hide homepage FAQ when browsing plans
    document.getElementById("homepage-faq")?.classList.add("hidden");

    renderPlans(plans);
    hideHomepageFAQ();
    resultsDiv.scrollIntoView({ behavior: "smooth" });

  } catch (err) {
    console.error(err);
    resultsDiv.innerHTML = "Error loading plans.";
  }
}

/* =========================
   CHECKOUT
========================= */
async function checkout(
  sku, name, price, country, destinationId, productType
) {
  console.log("🧪 WEBSITE CHECKOUT PAYLOAD", {
    sku,
    productType,
    destinationId,
    country,
    price
  });
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
        productType,
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
   RENDER PLANS (SAFE)
========================= */
function renderPlans(plans) {
  const resultsDiv = document.getElementById("results");
  sortWrapper?.classList.add("hidden");
  resultsDiv.innerHTML = "";

  if (!plans || !plans.length) {
    sortWrapper?.classList.add("hidden");
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
      <button class="buy-btn">Buy Now</button>
    `;

    // ✅ SAFE EVENT BINDING (NO INLINE JS)
    div.querySelector(".buy-btn").addEventListener("click", () => {
      console.log("🛒 Buy clicked", {
        sku: p.sku,
        productType: p.productType,
        destinationId: p.destinationId
      });

      checkout(
        p.sku,
        p.name,
        p.price,
        p.country,
        p.destinationId,
        p.productType
      );
    });

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
  console.log("✅ Autocomplete wired", { input, suggestions });
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
  window.location.href = "/";
}

document.addEventListener("DOMContentLoaded", () => {
  const homeBtn = document.querySelector('.top-btn[href="#"]');

  if (!homeBtn) return;

  const isHome =
    window.location.pathname === "/" ||
    window.location.pathname.includes("index.html");

  if (isHome) {
    homeBtn.style.display = "none";
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const homeBtn = document.querySelector('.top-btn[href="#"]');

  if (!homeBtn) return;

  const isHome =
    window.location.pathname === "/" ||
    window.location.pathname.includes("index.html");

  if (isHome) {
    homeBtn.style.display = "none";
  }
});

function hideHomepageFAQ() {
  document.getElementById("homepage-faq")?.classList.add("hidden");
}

function showHomepageFAQ() {
  document.getElementById("homepage-faq")?.classList.remove("hidden");
}

function autoHideHomeLink() {
  const homeLink = document.querySelector('.top-btn[data-home]');
  if (!homeLink) return;

  const isHome =
    location.pathname === "/" ||
    location.pathname.endsWith("index.html");

  if (isHome) {
    homeLink.style.display = "none";
  }
}

document.addEventListener("DOMContentLoaded", autoHideHomeLink);

document.querySelectorAll(".top-btn").forEach(btn => {
  if (btn.getAttribute("href") === window.location.pathname) {
    btn.classList.add("active");
  }
});
