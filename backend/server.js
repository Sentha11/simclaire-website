// =====================================================
// server.js – SimClaire Backend (ESIM + WhatsApp + Stripe + Admin API)
// FINAL PATCHED VERSION — Twilio XML Fix + Stripe + eSIM + Proxy
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const twilio = require("twilio");

const app = express();

// =====================================================
// BASE URL + AXIOS DEFAULTS
// =====================================================
const APP_BASE_URL =
  process.env.APP_BASE_URL ||
  "https://simclaire-website-backend.onrender.com";

axios.defaults.baseURL = APP_BASE_URL;

// =====================================================
// MIDDLEWARE ORDER (SUPER IMPORTANT)
// =====================================================

app.use(cors());

// 1️⃣ WhatsApp requires urlencoded
app.use(express.urlencoded({ extended: false }));

// 2️⃣ Stripe webhook REQUIRES raw body — must be BEFORE express.json()
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
} else {
  console.warn("⚠️ Stripe disabled (missing STRIPE_SECRET_KEY)");
}

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
        return res.status(400).send("Webhook Error");
      }

      // Checkout completed event
      if (event.type === "checkout.session.completed") {
        try {
          const sessionObj = event.data.object;
          const meta = sessionObj.metadata || {};

          const amount = (sessionObj.amount_total / 100).toFixed(2);
          const currency = (sessionObj.currency || "GBP").toUpperCase();

          let symbol = "£";
          if (currency === "USD") symbol = "$";
          if (currency === "EUR") symbol = "€";

          const msg = `
🎉 Payment Successful!

${meta.flagEmoji || "📶"} ${meta.country} — ${meta.planName}
📶 ${meta.data}
${symbol}${amount} Paid

🧾 Receipt: ${sessionObj.id}
📧 ${sessionObj.customer_details?.email}

Your eSIM will arrive shortly.
          `.trim();

          if (twilio && meta.whatsappTo && process.env.TWILIO_WHATSAPP_FROM) {
            await twilio(
              process.env.TWILIO_ACCOUNT_SID,
              process.env.TWILIO_AUTH_TOKEN
            ).messages.create({
              from: process.env.TWILIO_WHATSAPP_FROM,
              to: meta.whatsappTo,
              body: msg,
            });

            console.log("✅ WhatsApp payment confirmation sent");
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
    "⚠️ Stripe webhook disabled (missing STRIPE_WEBHOOK_SECRET)"
  );
}

// -----------------------------------------------------
// TWILIO CLIENT INIT (LOGS STATUS CLEARLY)
// -----------------------------------------------------
let twilioClient = null;

if (
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_WHATSAPP_FROM
) {
  try {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log("📨 Twilio client enabled");
  } catch (err) {
    console.error("❌ Failed to initialize Twilio client:", err.message);
  }
} else {
  console.warn("⚠️ Twilio disabled — missing one or more variables:");
  console.warn(" TWILIO_ACCOUNT_SID:", !!process.env.TWILIO_ACCOUNT_SID);
  console.warn(" TWILIO_AUTH_TOKEN:", !!process.env.TWILIO_AUTH_TOKEN);
  console.warn(" TWILIO_WHATSAPP_FROM:", !!process.env.TWILIO_WHATSAPP_FROM);
}

// 3️⃣ JSON parser for ALL normal API routes
app.use(express.json());

// =====================================================
// QUOTAGUARD STATIC IP PROXY
// =====================================================
let proxyAgent = null;
if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled");
}

// =====================================================
// ESIM API AUTH + WRAPPER
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

let esimToken = null;
let esimExpiresAt = 0;

async function getEsimToken() {
  if (esimToken && Date.now() < esimExpiresAt) return esimToken;

  const res = await axios.post(
    `${ESIM_BASE_URL}/authenticate`,
    { userName: ESIM_USERNAME, password: ESIM_PASSWORD },
    { httpsAgent: proxyAgent, proxy: false }
  );

  esimToken = res.data.token;
  esimExpiresAt = Date.now() + (res.data.expirySeconds || 600) * 1000;

  return esimToken;
}

async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();

  try {
    const result = await axios({
      method,
      url: `${ESIM_BASE_URL}${path}`,
      httpsAgent: proxyAgent,
      proxy: false,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...options,
    });

    return result.data;
  } catch (err) {
    console.error("❌ ESIM request error:", err.response?.data || err);
    throw err;
  }
}

// =====================================================
// Twilio XML SAFE RESPONSE
// =====================================================
function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function twiml(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
    msg || ""
  )}</Message></Response>`;
}

// =====================================================
// SESSION SYSTEM
// =====================================================
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

// =====================================================
// STRIPE CHECKOUT SESSION ROUTE
// =====================================================
app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
    const { email, quantity, price, currency, planName, metadata } = req.body;

    const checkout = await stripe.checkout.sessions.create({
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
            product_data: { name: planName },
          },
        },
      ],
      metadata,
    });

    return res.json({ id: checkout.id, url: checkout.url });
  } catch (err) {
    console.error("❌ Stripe checkout error:", err.message);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// =====================================================
// SUCCESS / CANCEL PAGES
// =====================================================
app.get("/success", (req, res) =>
  res.send("<h1>Payment Successful ✔️</h1>You may now return to WhatsApp.")
);

app.get("/cancel", (req, res) =>
  res.send("<h1>Payment Cancelled ❌</h1>You may retry from WhatsApp.")
);

// =====================================================
// WHATSAPP WEBHOOK — FULLY SAFE WITH TRY/CATCH
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const from = req.body.WaId || req.body.From?.replace("whatsapp:", "");
    const text = (req.body.Body || "").trim().toLowerCase();
    const session = getSession(from);

    // MENU
    if (["menu", "main"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml(
          "👋 Welcome to SimClaire!\n\n1) Browse plans\n2) FAQ\n3) Support"
        )
      );
    }

    if (session.step === "MENU") {
      if (text === "1") {
        session.step = "COUNTRY";
        return res.send(twiml("🌍 Enter your travel destination. Example: Italy, USA, Japan, United Kingdom."));
      }
      if (text === "2") return res.send(twiml("ℹ️ FAQ coming soon."));
      if (text === "3")
        return res.send(
          twiml("📞 Support: support@simclaire.com")
        );

      return res.send(
        twiml(
          "👋 Welcome to SimClaire!\n\n1) Browse plans\n2) FAQ\n3) Support"
        )
      );
    }

   // COUNTRY
if (session.step === "COUNTRY") {
  let list = await esimRequest("get", "/destinations");

  // Normalize API response safely
  if (Array.isArray(list)) {
    // OK
  } else if (Array.isArray(list.data)) {
    list = list.data;
  } else {
    console.error("❌ Unexpected /destinations response:", list);
    return res.send(
      twiml("⚠️ Destination list unavailable. Please try again later.")
    );
  }

  const match = list.find((d) =>
    d.destinationName.toLowerCase().includes(text)
  );

  if (!match)
    return res.send(twiml("❌ No match. Try another country."));

  session.country = match.destinationName;
  session.destinationId = match.destinationID;
  session.step = "PLAN";

  const products = await esimRequest(
    "get",
    `/products?destinationid=${match.destinationID}`
  );

  session.products = Array.isArray(products)
    ? products
    : products.data || [];

  let msg = `📡 Plans for *${session.country}*:\n\n`;
  session.products.slice(0, 5).forEach((p, i) => {
    msg += `${i + 1}) ${p.productName}\n💾 ${p.productDataAllowance}\n📅 ${p.validity} days\n💵 £${p.productPrice}\n\n`;
  });

  msg += "Reply with 1–5 to choose a plan.";
  return res.send(twiml(msg));
}

    // PLAN SELECT
    if (session.step === "PLAN") {
      const i = parseInt(text);
      if (isNaN(i) || i < 1 || i > session.products.length)
        return res.send(twiml("❌ Invalid option. Try again."));

      session.selectedProduct = session.products[i - 1];
      session.step = "QTY";
      return res.send(twiml("📦 How many eSIMs? (1–10)"));
    }

    // QTY
    if (session.step === "QTY") {
      const qty = parseInt(text);
      if (isNaN(qty) || qty < 1 || qty > 10)
        return res.send(twiml("❌ Enter a number 1–10."));

      session.quantity = qty;
      session.step = "MOBILE";

      return res.send(
        twiml("📱 Enter your mobile number (e.g., +447900123456)")
      );
    }

    // MOBILE
    if (session.step === "MOBILE") {
      if (!/^\+?\d{7,15}$/.test(req.body.Body.trim()))
        return res.send(twiml("❌ Invalid number. Try again."));

      session.mobile = req.body.Body.trim();
      session.step = "EMAIL";

      return res.send(twiml("📧 Enter your email address:"));
    }

    // EMAIL → STRIPE PAYMENT
    if (session.step === "EMAIL") {
      const email = req.body.Body.trim();
      if (!email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/))
        return res.send(twiml("❌ Invalid email. Try again."));

      session.email = email;
      const p = session.selectedProduct;

      try {
      const response = await axios.post(
          `http://simclaire-website-backend:10000/api/payments/create-checkout-session`,
          {
            email,
            quantity: session.quantity,
            price: p.productPrice,
            currency: "gbp",
            planName: p.productName,
            metadata: {
              country: session.country,
              planName: p.productName,
              data: p.productDataAllowance,
              flagEmoji: "🇬🇧",
              whatsappTo: `whatsapp:${from}`,
            },
          },
          { proxy: false }
        );
          
        resetSession(from);

        return res.send(
          twiml(
            `💳 *Secure Payment Link*\n\nComplete your purchase:\n${response.data.url}\n\nYour eSIM will be delivered instantly after payment.`
          )
        );
      } catch (err) {
        console.error("❌ Stripe error:", err.message);
        return res.send(
          twiml("⚠️ Payment error. Please type menu and try again.")
        );
      }
    }

    return res.send(twiml("😅 I got lost. Type menu to restart."));
  } catch (err) {
    console.error("❌ WhatsApp Webhook Error:", err);
    return res.send(
      twiml("⚠️ Something broke. Type menu to restart.")
    );
  }
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 Backend running on port ${PORT}`)
);