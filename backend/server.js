// =====================================================
// server.js – SimClaire Backend (FINAL – STRIPE FIXED)
// =====================================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const bodyParser = require("body-parser");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const twilio = require("twilio");

const app = express();
app.set("trust proxy", true);

// =====================================================
// STRIPE INIT (⚠️ MUST COME BEFORE WEBHOOK)
// =====================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
} else {
  console.log("🟡 Stripe not configured");
}

// =====================================================
// STRIPE WEBHOOK (⚠️ MUST BE FIRST ROUTE)
// =====================================================
app.post(
  "/webhook/stripe",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      console.log("🚀 Stripe webhook reached checkout.session.completed");

      const session = event.data.object;
      const metadata = session.metadata || {};

      console.log("✅ Stripe payment completed:", session.id);
      console.log("🧾 Metadata:", metadata);

      // 👉 Your fulfillment logic stays here
    }

    res.json({ received: true });
  }
);

// =====================================================
// GLOBAL MIDDLEWARE (AFTER WEBHOOK)
// =====================================================
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// =====================================================
// STATIC WEBSITE
// =====================================================
app.use(express.static(path.join(__dirname, "frontend-static")));

// =====================================================
// eSIM CONFIG
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  throw new Error("❌ Missing eSIM configuration");
}

const isUAT = ESIM_BASE_URL.includes("uat");
console.log("🌍 eSIM Environment:", isUAT ? "UAT" : "PROD");

// =====================================================
// QUOTAGUARD PROXY
// =====================================================
let proxyAgent = null;
if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using QuotaGuard HTTP proxy");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 Using QuotaGuard SOCKS proxy");
}

// =====================================================
// eSIM AUTH + REQUEST
// =====================================================
let esimToken = null;
let esimExpiresAt = 0;

async function getEsimToken() {
  if (esimToken && Date.now() < esimExpiresAt) return esimToken;

  const res = await axios.post(
    `${ESIM_BASE_URL}/api/esim/authenticate`,
    { userName: ESIM_USERNAME, password: ESIM_PASSWORD },
    { httpsAgent: proxyAgent, proxy: false }
  );

  const token = res.data?.token || res.data?.data?.token;
  if (!token) throw new Error("eSIM auth failed");

  esimToken = token;
  esimExpiresAt = Date.now() + 10 * 60 * 1000;

  console.log("🔐 eSIM token acquired");
  return token;
}

async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const res = await axios({
    method,
    url: `${ESIM_BASE_URL}${path}`,
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent: proxyAgent,
    proxy: false,
    ...options,
  });
  return res.data;
}

// =====================================================
// STRIPE CHECKOUT SESSION
// =====================================================
app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
    const {
      email,
      quantity,
      price,
      currency,
      planName,
      productSku,
      productType,
      data,
      validity,
      country,
      mobile,
      destinationId,
    } = req.body;

    if (!mobile) {
      return res.status(400).json({ error: "Mobile number required" });
    }

    const unitAmount = Math.round(Number(price) * 100);

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      success_url: `${process.env.APP_BASE_URL}/success`,
      cancel_url: `${process.env.APP_BASE_URL}/cancel`,
      line_items: [
        {
          quantity: quantity || 1,
          price_data: {
            currency: currency || "gbp",
            unit_amount: unitAmount,
            product_data: { name: planName },
          },
        },
      ],
      metadata: {
        planName,
        productSku,
        productType,
        data,
        validity,
        quantity: String(quantity || 1),
        email,
        mobileno: mobile,
        country,
        destinationId,
      },
    });

    console.log("✅ Stripe checkout created:", checkout.id);
    res.json({ url: checkout.url });
  } catch (err) {
    console.error("❌ Checkout error:", err.message);
    res.status(500).json({ error: "Checkout failed" });
  }
});

// =====================================================
// HEALTH
// =====================================================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    stripe: Boolean(stripe),
    esim: Boolean(ESIM_BASE_URL),
  });
});

// =====================================================
// FALLBACK
// =====================================================
app.get("*", (req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/webhook")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(__dirname, "frontend-static", "index.html"));
});

// =====================================================
// START
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 SimClaire backend running on ${PORT}`);
});