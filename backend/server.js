// =====================================================
// server.js – SimClaire Backend (ESIM + WhatsApp + Stripe + Admin API)
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const twilio = require("twilio");

const app = express();

// -----------------------------------------------------
// MIDDLEWARE (CORS + URLENCODED)
// -----------------------------------------------------
app.use(cors());
// Twilio + WhatsApp webhooks use x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// -----------------------------------------------------
// QUOTAGUARD (STATIC) PROXY
// -----------------------------------------------------
let proxyAgent = null;
if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled");
} else {
  console.warn("⚠️ No QUOTAGUARD_URL provided");
}

// -----------------------------------------------------
// ESIM CREDENTIALS
// -----------------------------------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  console.warn("⚠️ Missing eSIM environment variables");
}

// -----------------------------------------------------
// APP BASE URL (FOR STRIPE REDIRECTS)
// -----------------------------------------------------
const APP_BASE_URL = process.env.APP_BASE_URL || "https://example.com";

// -----------------------------------------------------
// STRIPE
// -----------------------------------------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
} else {
  console.warn("⚠️ Stripe disabled (no STRIPE_SECRET_KEY)");
}

// -----------------------------------------------------
// TWILIO CLIENT (FOR OUTBOUND WHATSAPP MESSAGES)
// -----------------------------------------------------
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log("📲 Twilio client enabled");
} else {
  console.warn("⚠️ Twilio client disabled (no TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
}

// -----------------------------------------------------
// SIMPLE IN-MEMORY ORDER LOG
// -----------------------------------------------------
const orders = [];

function recordOrder(data) {
  orders.push({
    id:
      Date.now().toString() +
      "-" +
      Math.random().toString(36).substring(2, 8),
    createdAt: new Date().toISOString(),
    ...data,
  });
}

// -----------------------------------------------------
// ADMIN ACCESS VIA API KEY
// -----------------------------------------------------
function getRole(req) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (!key) return null;
  if (key === process.env.ADMIN_API_KEY) return "admin";
  if (key === process.env.SUPPORT_API_KEY) return "support";
  return null;
}

// -----------------------------------------------------
// ESIM TOKEN CACHE
// -----------------------------------------------------
let esimToken = null;
let esimTokenExpiresAt = 0;

async function getEsimToken() {
  const now = Date.now();
  if (esimToken && now < esimTokenExpiresAt) return esimToken;

  const url = `${ESIM_BASE_URL}/authenticate`;

  const res = await axios.post(
    url,
    { userName: ESIM_USERNAME, password: ESIM_PASSWORD },
    { httpsAgent: proxyAgent || undefined, proxy: false }
  );

  esimToken = res.data.token;
  const ttl = res.data.expirySeconds || 600;
  esimTokenExpiresAt = now + ttl * 1000;

  return esimToken;
}

// -----------------------------------------------------
// GENERIC ESIM REQUEST WRAPPER
// -----------------------------------------------------
async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}${path}`;

  try {
    const res = await axios({
      method,
      url,
      httpsAgent: proxyAgent || undefined,
      proxy: false,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...options,
    });

    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      esimToken = null;
      const newToken = await getEsimToken();
      const retry = await axios({
        method,
        url,
        httpsAgent: proxyAgent || undefined,
        proxy: false,
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json",
        },
        ...options,
      });

      return retry.data;
    }

    console.error("❌ ESIM API error:", err.response?.data || err.message);
    throw err;
  }
}

// -----------------------------------------------------
// TwiML Helper (SAFE TEXT ONLY — NO CDATA)
// -----------------------------------------------------
function escapeXml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(message) {
  const safe = escapeXml(message);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${safe}</Message>
</Response>`;
}


// -----------------------------------------------------
// SESSION SYSTEM
// -----------------------------------------------------
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

function clean(t) {
  return (t || "").trim();
}

// -----------------------------------------------------
// FORMAT PRODUCT LIST FOR WHATSAPP
// -----------------------------------------------------
function formatPlans(country, products) {
  if (!products.length) {
    return `⚠️ No plans available for *${country}* right now.`;
  }

  let msg = `📡 Top eSIM plans for *${country}*:\n\n`;

  products.slice(0, 5).forEach((p, i) => {
    msg += `*${i + 1}) ${p.productName}*\n`;
    msg += `   💾 ${p.productDataAllowance || p.dataAllowance}\n`;
    msg += `   📅 ${p.productValidity || p.validity} days\n`;
    msg += `   💵 £${p.productPrice}\n\n`;
  });

  msg += `Reply with 1–${Math.min(5, products.length)} to choose a plan.`;
  return msg;
}

// -----------------------------------------------------
// STRIPE WEBHOOK (RAW BODY) – Option A
// -----------------------------------------------------
// NOTE: this must come BEFORE express.json()
if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
  app.post(
    "/webhook/stripe",
    express.raw({ type: "application/json" }),
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
        console.error("❌ Stripe webhook signature error:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        try {
          const amount = (session.amount_total / 100).toFixed(2);
          const currency = (session.currency || "gbp").toUpperCase();
          const email =
            session.customer_details?.email ||
            session.customer_email ||
            "N/A";
          const meta = session.metadata || {};

          // Very simple currency symbol mapping
          let symbol = "£";
          if (currency === "USD") symbol = "$";
          if (currency === "EUR") symbol = "€";

          const country =
            meta.country ||
            meta.destinationName ||
            "your destination";
          const planName =
            meta.planName ||
            meta.productName ||
            "Holiday eSIM";
          const dataAmount =
            meta.data ||
            meta.dataAllowance ||
            "10GB High-Speed Data";

          const flagEmoji = meta.flagEmoji || "📶";

          const msg = `
🎉 Payment Successful!

Your eSIM order is confirmed.

──────────────────────

${flagEmoji} ${country} — ${planName}  
📶 ${dataAmount}  
${symbol} ${symbol}${amount} Paid

🧾 Receipt ID: ${session.id}  
📧 Email: ${email}  

──────────────────────

Your QR code & installation steps will follow shortly.  
Type menu to return to the home screen.
          `.trim();

          const whatsappTo =
            meta.whatsappTo || process.env.TEST_CUSTOMER_WHATSAPP_TO;

          if (twilioClient && process.env.TWILIO_WHATSAPP_FROM && whatsappTo) {
            await twilioClient.messages.create({
              from: process.env.TWILIO_WHATSAPP_FROM,
              to: whatsappTo, // e.g. "whatsapp:+1XXXXXX"
              body: msg,
            });
            console.log("✅ WhatsApp payment confirmation sent");
          } else {
            console.warn(
              "⚠️ Skipped WhatsApp send – missing Twilio config or recipient"
            );
          }
        } catch (err) {
          console.error("❌ Error handling checkout.session.completed:", err);
        }
      }

      res.json({ received: true });
    }
  );
} else {
  console.warn(
    "⚠️ Stripe webhook disabled (missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET)"
  );
}

// -----------------------------------------------------
// JSON BODY PARSER (AFTER STRIPE WEBHOOK)
// -----------------------------------------------------
app.use(express.json());

// =====================================================
// BASIC API ROUTES
// =====================================================
app.get("/api/status", (_, res) => res.json({ ok: true }));

app.get("/api/esim/destinations", async (req, res) => {
  try {
    const dest = await esimRequest("get", "/destinations");
    return res.json(dest);
  } catch {
    res.status(500).json({ error: "Failed to load destinations" });
  }
});

// =====================================================
// STRIPE CHECKOUT SESSION (FRONTEND TRIGGER)
// =====================================================
app.post("/api/payments/create-checkout-session", async (req, res) => {
  console.log("🔥 Stripe route hit");
  console.log("Body:", req.body);

  try {
    if (!stripe) {
      console.log("❌ STRIPE NOT INITIALIZED");
      return res.status(500).json({ error: "Stripe not initialized" });
    }

    const { email, quantity, price, currency, planName, metadata } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      success_url: `${APP_BASE_URL}/success`,
      cancel_url: `${APP_BASE_URL}/cancel`,
      line_items: [
        {
          quantity,
          price_data: {
            currency: currency || "gbp",
            unit_amount: Math.round(price * 100),
            product_data: { name: planName || "eSIM Plan" },
          },
        },
      ],
      // Pass through any extra info for WhatsApp message (country, data, WA number, etc.)
      metadata: metadata || {},
    });

    console.log("Stripe session created:", session.id);
    return res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.log("❌ Stripe ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

// =====================================================
// SUCCESS / CANCEL PAGES – Option B
// =====================================================
app.get("/success", (req, res) => {
  res.send(`
    <h1>Payment Successful ✔️</h1>
    <p>Thank you! Your eSIM payment was received.</p>
    <p>You can now return to WhatsApp to continue.</p>
  `);
});

app.get("/cancel", (req, res) => {
  res.send(`
    <h1>Payment Cancelled ❌</h1>
    <p>Your payment was not completed. You can close this window and try again from WhatsApp.</p>
  `);
});

// =====================================================
// ADMIN API (JSON ONLY, NO HTML)
// =====================================================
app.get("/api/admin/orders", (req, res) => {
  const role = getRole(req);
  if (!role) return res.status(401).json({ error: "Unauthorized" });

  return res.json({ role, count: orders.length, orders });
});

// =====================================================
// WHATSAPP WEBHOOK (INBOUND FROM TWILIO)
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From;
  const body = clean(req.body.Body || "").toLowerCase();
  const session = getSession(from);

  // --- RESET / MENU ---
  if (["menu", "main"].includes(body)) {
    resetSession(from);
    return res.send(
      twiml(`👋 Welcome to SimClaire eSIMs!

1) Browse eSIM plans
2) FAQ
3) Support`)
    );
  }

  if (session.step === "MENU") {
    if (["1"].includes(body)) {
      session.step = "COUNTRY";
      return res.send(
        twiml("🌍 Enter the country you're travelling to:")
      );
    }
    if (body === "2")
      return res.send(twiml("ℹ️ FAQ\nType menu to return."));
    if (body === "3")
      return res.send(twiml("📞 Support: support@simclaire.com"));

    return res.send(
      twiml(`👋 Welcome to SimClaire

1) Browse plans
2) FAQ
3) Support`)
    );
  }

  // --- COUNTRY SEARCH ---
  if (session.step === "COUNTRY") {
    const destRes = await esimRequest("get", "/destinations");

    const list = Array.isArray(destRes) ? destRes : destRes.data || [];

    const match = list.find((d) =>
      (d.destinationName || "").toLowerCase().includes(body)
    );

    if (!match) {
      return res.send(
        twiml("❌ Country not found. Please enter another destination.")
      );
    }

    session.country = match.destinationName;
    session.destinationId = match.destinationID;
    session.step = "PLAN";

    const prodRes = await esimRequest(
      "get",
      `/products?destinationid=${match.destinationID}`
    );
    const products = Array.isArray(prodRes) ? prodRes : prodRes.data || [];
    session.products = products;

    return res.send(twiml(formatPlans(session.country, products)));
  }

  // --- PLAN SELECTION ---
  if (session.step === "PLAN") {
    const choice = parseInt(body);
    if (isNaN(choice) || choice < 1 || choice > session.products.length)
      return res.send(twiml("❌ Invalid option. Enter a valid number."));

    session.selectedProduct = session.products[choice - 1];
    session.step = "QTY";
    return res.send(twiml("📦 How many eSIMs? (1–10)"));
  }

  // --- QUANTITY ---
  if (session.step === "QTY") {
    const qty = parseInt(body);
    if (isNaN(qty) || qty < 1 || qty > 10)
      return res.send(twiml("❌ Enter a number 1–10."));

    session.quantity = qty;
    session.step = "MOBILE";
    return res.send(
      twiml(
        "📱 Enter your mobile number with country code (e.g., +447900123456)"
      )
    );
  }

  // --- MOBILE ---
  if (session.step === "MOBILE") {
    if (!/^\+?\d{6,15}$/.test(req.body.Body.trim()))
      return res.send(twiml("❌ Invalid number. Try again."));

    session.mobile = req.body.Body.trim();
    session.step = "EMAIL";
    return res.send(twiml("📧 Enter your email address:"));
  }

  // --- EMAIL + PURCHASE (Direct eSIM purchase) ---
  if (session.step === "EMAIL") {
    const email = req.body.Body.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.send(twiml("❌ Invalid email. Try again."));

    session.email = email;

    const p = session.selectedProduct;

    const payload = {
      items: [
        {
          type: "1",
          sku: p.productSku,
          quantity: session.quantity,
          mobileno: session.mobile,
          emailid: session.email,
        },
      ],
    };

    try {
      const order = await esimRequest("post", "/purchaseesim", {
        data: payload,
      });

      recordOrder({
        source: "whatsapp",
        country: session.country,
        sku: p.productSku,
        quantity: session.quantity,
        email: session.email,
        providerResponse: order,
      });

      resetSession(from);

      return res.send(
        twiml(`🎉 Your eSIM order is complete!
The details have been sent to ${email}.`)
      );
    } catch (err) {
      console.error("Purchase error:", err);
      return res.send(
        twiml("⚠️ Error processing your order. Try again later.")
      );
    }
  }

  return res.send(twiml("😅 I got lost. Type menu to restart."));
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 Backend running on port ${PORT}`)
);