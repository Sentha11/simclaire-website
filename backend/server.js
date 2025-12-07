 // =====================================================
// server.js – SimClaire Backend (ESIM + WhatsApp + Stripe + Admin API)
// Fully Patched + Fixed Middleware Order + Internal Axios Routing
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const twilio = require("twilio");

const app = express();

// -----------------------------------------------------
// GLOBAL CONFIG
// -----------------------------------------------------
const APP_BASE_URL =
  process.env.APP_BASE_URL ||
  "https://simclaire-website-backend.onrender.com";

// Use this for ALL axios calls inside the server:
axios.defaults.baseURL = APP_BASE_URL;

// -----------------------------------------------------
// MIDDLEWARE (ORDER MATTERS!)
// -----------------------------------------------------
app.use(cors());

// 1️⃣ WhatsApp requires urlencoded:
app.use(express.urlencoded({ extended: false }));

// Stripe webhook requires RAW BODY:
const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

// 2️⃣ Stripe webhook must come BEFORE express.json():
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
        console.error("❌ Stripe signature error:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const sessionObj = event.data.object;
        try {
          const amount = (sessionObj.amount_total / 100).toFixed(2);
          const currency = sessionObj.currency.toUpperCase();
          const email =
            sessionObj.customer_details?.email ||
            sessionObj.customer_email ||
            "N/A";
          const meta = sessionObj.metadata || {};

          const country =
            meta.country || meta.destinationName || "your destination";
          const planName = meta.planName || "eSIM Plan";
          const dataAmount = meta.data || "High-Speed Data";
          const flagEmoji = meta.flagEmoji || "📶";

          let symbol = "£";
          if (currency === "USD") symbol = "$";
          if (currency === "EUR") symbol = "€";

          const message = `
🎉 Payment Successful!

Your eSIM order is confirmed.

──────────────────────

${flagEmoji} ${country} — ${planName}
📶 ${dataAmount}
${symbol}${amount} Paid

🧾 Receipt ID: ${sessionObj.id}
📧 Email: ${email}

──────────────────────

Your QR code & installation steps will follow shortly.
          `.trim();

          const whatsappTo = meta.whatsappTo;

          if (whatsappTo && process.env.TWILIO_WHATSAPP_FROM) {
            await twilio(
              process.env.TWILIO_ACCOUNT_SID,
              process.env.TWILIO_AUTH_TOKEN
            ).messages.create({
              from: process.env.TWILIO_WHATSAPP_FROM,
              to: whatsappTo,
              body: message,
            });
          }
        } catch (err) {
          console.error("❌ Webhook processing error:", err);
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

// 3️⃣ JSON parser for ALL OTHER ROUTES AFTER the raw webhook
app.use(express.json());

// -----------------------------------------------------
// QUOTAGUARD STATIC PROXY
// -----------------------------------------------------
let proxyAgent = null;
if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled");
}

// -----------------------------------------------------
// ESIM API
// -----------------------------------------------------
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
    const res = await axios({
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

    return res.data;
  } catch (err) {
    console.error("❌ ESIM error:", err.response?.data || err.message);
    throw err;
  }
}

// -----------------------------------------------------
// Twilio XML helper
// -----------------------------------------------------
function escapeXml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function twiml(message) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?> +
    <Response><Message>${escapeXml(message)}</Message></Response>`
  );
}

// -----------------------------------------------------
// SESSION MANAGEMENT
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

// -----------------------------------------------------
// STRIPE CHECKOUT SESSION ROUTE
// -----------------------------------------------------
app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
    if (!stripe)
      return res.status(500).json({ error: "Stripe not initialized" });

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
    console.error(
      "❌ Stripe checkout creation failed:",
      err.response?.data || err.message
    );
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// -----------------------------------------------------
// SUCCESS / CANCEL PAGES
// -----------------------------------------------------
app.get("/success", (req, res) => {
  res.send("<h1>Payment Successful ✔️</h1><p>You may return to WhatsApp.</p>");
});

app.get("/cancel", (req, res) => {
  res.send("<h1>Payment Cancelled ❌</h1><p>Please try again.</p>");
});

// -----------------------------------------------------
// WHATSAPP WEBHOOK FLOW
// -----------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From?.replace("whatsapp:", "");
  const body = (req.body.Body || "").trim().toLowerCase();
  const session = getSession(from);

  // MENU
  if (["menu", "main"].includes(body)) {
    resetSession(from);
    return res.send(
      twiml(`👋 Welcome to SimClaire!

1) Browse eSIM plans
2) FAQ
3) Support`)
    );
  }

  if (session.step === "MENU") {
    if (body === "1") {
      session.step = "COUNTRY";
      return res.send(twiml("🌍 Enter the country you're travelling to. Example: Italy, USA, Japan, United Kingdom."));
    }
    if (body === "2")
      return res.send(twiml("ℹ️ FAQ coming soon.\nType menu to return."));
    if (body === "3")
      return res.send(twiml("📞 Support: support@simclaire.com"));

    return res.send(
      twiml(`👋 Welcome to SimClaire!

1) Browse eSIM plans
2) FAQ
3) Support`)
    );
  }

  // COUNTRY SEARCH
  if (session.step === "COUNTRY") {
    const list = await esimRequest("get", "/destinations");
    const match = list.find((d) =>
      d.destinationName.toLowerCase().includes(body)
    );

    if (!match)
      return res.send(
        twiml("❌ Country not found. Try again or type menu.")
      );

    session.country = match.destinationName;
    session.destinationId = match.destinationID;
    session.step = "PLAN";

    const prod = await esimRequest(
      "get",
      `/products?destinationid=${match.destinationID}`
    );
    session.products = prod;

    let msg = `📡 Top eSIM plans for *${session.country}*:\n\n`;
    prod.slice(0, 5).forEach((p, i) => {
      msg += `${i + 1}) ${p.productName}\n💾 ${
        p.productDataAllowance
      }\n📅 ${p.validity} days\n💵 £${p.productPrice}\n\n`;
    });

    return res.send(twiml(msg + "Reply with a number to choose a plan."));
  }

  // PLAN SELECT
  if (session.step === "PLAN") {
    const i = parseInt(body);
    if (isNaN(i) || i < 1 || i > session.products.length)
      return res.send(twiml("❌ Invalid choice. Try again."));

    session.selectedProduct = session.products[i - 1];
    session.step = "QTY";
    return res.send(twiml("📦 How many eSIMs? (1–10)"));
  }

  // QUANTITY
  if (session.step === "QTY") {
    const qty = parseInt(body);
    if (isNaN(qty) || qty < 1 || qty > 10)
      return res.send(twiml("❌ Enter a number between 1–10."));

    session.quantity = qty;
    session.step = "MOBILE";
    return res.send(
      twiml(
        "📱 Enter your mobile number (with +country code). Example: +447900123456"
      )
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

  // EMAIL + STRIPE PAYMENT LINK
  if (session.step === "EMAIL") {
    const email = req.body.Body.trim();

    if (!email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/))
      return res.send(twiml("❌ Invalid email address. Try again."));

    session.email = email;

    const p = session.selectedProduct;

    try {
      const stripeRes = await axios.post(
        "/api/payments/create-checkout-session",
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
            flagEmoji: "🇬🇧", // Future: dynamic
            whatsappTo: `whatsapp:${from}`,
          },
        }
      );

      resetSession(from);

      return res.send(
        twiml(
          `💳 Secure Payment Link

Please complete your purchase here:
${stripeRes.data.url}

Once paid, your eSIM will be delivered instantly.`
        )
      );
    } catch (err) {
      console.error("❌ PAYMENT ERROR:", err.message);
      return res.send(
        twiml("⚠️ Unable to start payment. Try again or type menu.")
      );
    }
  }

  res.send(twiml("😅 I got lost. Type menu to restart."));
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 Backend running on port ${PORT}`)
);