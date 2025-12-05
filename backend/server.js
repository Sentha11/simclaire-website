// =====================================================
// server.js – SimClaire Backend (ESIM + WhatsApp + Stripe + Simple Admin)
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

// -----------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -----------------------------------------------------
// QUOTAGUARD STATIC PROXY
// -----------------------------------------------------
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled!");
}

// -----------------------------------------------------
// ESIM ENV VARS
// -----------------------------------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

// -----------------------------------------------------
// STRIPE
// -----------------------------------------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
}

// -----------------------------------------------------
// SIMPLE ORDER LOG (in-memory)
// -----------------------------------------------------
const orders = [];
function recordOrder(partial) {
  orders.push({
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    ...partial,
  });
}

// -----------------------------------------------------
// SIMPLE ADMIN AUTH (API Keys)
// -----------------------------------------------------
function getRoleFromRequest(req) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (!key) return null;

  if (key === process.env.ADMIN_API_KEY) return "admin";
  if (key === process.env.SUPPORT_API_KEY) return "support";

  return null;
}

// -----------------------------------------------------
// TOKEN CACHE
// -----------------------------------------------------
let esimToken = null;
let esimTokenExpiresAt = 0;

async function getEsimToken() {
  const now = Date.now();
  if (esimToken && now < esimTokenExpiresAt) return esimToken;

  const url = `${ESIM_BASE_URL}/authenticate`;

  const res = await axios.post(
    url,
    {
      userName: ESIM_USERNAME,
      password: ESIM_PASSWORD,
    },
    { httpsAgent: proxyAgent, proxy: false }
  );

  esimToken = res.data.token;
  esimTokenExpiresAt = now + (res.data.expirySeconds || 600) * 1000;
  return esimToken;
}

// -----------------------------------------------------
// GENERIC ESIM REQUEST
// -----------------------------------------------------
async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}${path}`;

  try {
    const res = await axios({
      method,
      url,
      httpsAgent: proxyAgent,
      proxy: false,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...options,
    });

    return res.data;
  } catch (err) {
    console.error("❌ ESIM:", err.response?.data || err.message);
    throw err;
  }
}

// -----------------------------------------------------
// HELPERS
// -----------------------------------------------------
function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${message}</Message></Response>`;
}

const sessions = {};
function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = {
      step: "MENU",
      country: null,
      destinationId: null,
      products: [],
      selectedProduct: null,
      quantity: 1,
      mobile: null,
      email: null,
    };
  }
  return sessions[id];
}
function resetSession(id) {
  delete sessions[id];
}

// -----------------------------------------------------
// API ROUTES
// -----------------------------------------------------
app.get("/api/status", (req, res) => res.json({ ok: true }));

app.get("/api/admin/orders", (req, res) => {
  const role = getRoleFromRequest(req);
  if (!role) return res.status(401).json({ error: "Unauthorized" });

  res.json({ role, count: orders.length, orders });
});

// -----------------------------------------------------
// STRIPE CHECKOUT
// -----------------------------------------------------
app.post("/api/payments/create-checkout-session", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe disabled" });

  const { sku, planName, quantity, price, currency, email, country } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      success_url: process.env.STRIPE_SUCCESS_URL,
      cancel_url: process.env.STRIPE_CANCEL_URL,
      line_items: [
        {
          quantity,
          price_data: {
            currency,
            unit_amount: Math.round(price * 100),
            product_data: { name: `${country} ${planName}` },
          },
        },
      ],
      metadata: { sku, planName, quantity, price, country, email },
    });

    recordOrder({
      source: "website",
      channel: "stripe",
      sku,
      quantity,
      emailid: email,
      country,
      stripeSessionId: session.id,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: "Stripe session error" });
  }
});

// -----------------------------------------------------
// WHATSAPP WEBHOOK
// -----------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From || "unknown";
  const body = (req.body.Body || "").trim().toLowerCase();
  const session = getSession(from);

  if (body === "menu") {
    resetSession(from);
    return res.send(twiml(`Welcome! Reply 1 for plans.`));
  }

  if (session.step === "MENU") {
    session.step = "WAIT_COUNTRY";
    return res.send(twiml(`Great! Send your travel country.`));
  }

  if (session.step === "WAIT_COUNTRY") {
    const dest = await esimRequest("get", "/destinations");
    const match = dest.find((d) =>
      d.destinationName.toLowerCase().includes(body)
    );

    if (!match) {
      return res.send(
        twiml(`Country not found. Try again or type menu.`)
      );
    }

    session.country = match.destinationName;
    session.destinationId = match.destinationID;
    session.step = "WAIT_PLAN";

    const products = await esimRequest(
      "get",
      `/products?destinationid=${match.destinationID}`
    );

    session.products = products;

    let reply = `Plans for ${match.destinationName}:\n`;
    products.slice(0, 5).forEach((p, i) => {
      reply += `${i + 1}) ${p.productName} - £${p.productPrice}\n`;
    });

    return res.send(twiml(reply));
  }

  return res.send(twiml(`Type *menu* to restart.`));
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🔥 Backend running on " + PORT));