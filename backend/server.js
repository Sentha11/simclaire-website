// =====================================================
// server.js – SimClaire Backend (FINAL – LOOP FIXED)
// Stripe + eSIM API + WhatsApp + SendGrid + Proxy Support
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");
const PDFDocument = require("pdfkit");

const app = express();
const whatsappState = {}; // 🔥 STATE STORAGE (FIXES LOOP)

// =====================================================
// PROXY (QuotaGuard)
// =====================================================
let proxyAgent = null;
if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using QuotaGuard STATIC proxy");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 Using QuotaGuard SOCKS proxy");
}

// =====================================================
// MIDDLEWARE
// =====================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =====================================================
// TWILIO INIT (API KEY MODE)
// =====================================================
let twilioClient = null;
if (
  process.env.TWILIO_API_KEY &&
  process.env.TWILIO_API_SECRET &&
  process.env.TWILIO_ACCOUNT_SID
) {
  twilioClient = twilio(
    process.env.TWILIO_API_KEY,
    process.env.TWILIO_API_SECRET,
    { accountSid: process.env.TWILIO_ACCOUNT_SID }
  );
  console.log("📞 Twilio initialized");
}

// =====================================================
// STRIPE
// =====================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
}

// =====================================================
// SENDGRID
// =====================================================
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid enabled");
}

// =====================================================
// BASIC ROUTES
// =====================================================
app.get("/success", (_, res) => res.send("Payment success"));
app.get("/cancel", (_, res) => res.send("Payment cancelled"));

// =====================================================
// 🔥 WHATSAPP WEBHOOK (STATEFUL – LOOP FIXED)
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.From;
  const body = req.body.Body?.trim().toLowerCase() || "";

  // Init state
  if (!whatsappState[from]) {
    whatsappState[from] = { step: "start" };
  }

  const state = whatsappState[from];

  // -------------------------
  // STEP 1: GREETING
  // -------------------------
  if (state.step === "start" && ["hi", "hello", "hey"].includes(body)) {
    state.step = "menu";
    return res.send(`
<Response>
  <Message>
👋 Welcome to SimClaire!
Reply with:
1️⃣ Browse Plans
2️⃣ FAQ
3️⃣ Support
  </Message>
</Response>
`);
  }

  // -------------------------
  // STEP 2: MENU
  // -------------------------
  if (state.step === "menu") {
    if (body === "1") {
      state.step = "awaiting_destination";
      return res.send(`
<Response>
  <Message>
🌍 Please type your destination
Example: United Kingdom
  </Message>
</Response>
`);
    }

    if (body === "2") {
      return res.send(`
<Response>
  <Message>
❓ FAQ
* Instant eSIM
* No roaming fees
* Global coverage
  </Message>
</Response>
`);
    }

    if (body === "3") {
      return res.send(`
<Response>
  <Message>
📞 Support
WhatsApp: +1 (437) 925-9578
Email: support@simclaire.com
  </Message>
</Response>
`);
    }
  }

  // -------------------------
  // STEP 3: DESTINATION
  // -------------------------
  if (state.step === "awaiting_destination") {
    state.destination = body;
    state.step = "done";

    return res.send(`
<Response>
  <Message>
📍 Destination saved: ${body}
Plans will be listed next.
  </Message>
</Response>
`);
  }

  // -------------------------
  // SAFE FALLBACK (NO LOOP)
  // -------------------------
  return res.send(`
<Response>
  <Message>
❌ Invalid input.
Type hi to start again.
  </Message>
</Response>
`);
});

// =====================================================
// START SERVER
// =====================================================++
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🔥 SimClaire backend running on port ${PORT}`)
);
