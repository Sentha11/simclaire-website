// =====================================================
// server.js – SimClaire Backend (ROLLBACK STABLE)
// Stripe Checkout + WhatsApp (NO eSIM fulfillment)
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const twilio = require("twilio");
const bodyParser = require("body-parser");

const app = express();

// =====================================================
// MIDDLEWARE (ORDER MATTERS)
// =====================================================
app.use(cors());
app.use(express.urlencoded({ extended: false })); // Twilio
app.use(express.json());

// Stripe webhook needs raw body
app.use("/webhook/stripe", bodyParser.raw({ type: "application/json" }));

// =====================================================
// STRIPE INIT
// =====================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
}

// =====================================================
// TWILIO INIT (API KEY MODE – GitGuardian safe)
// =====================================================
const twilioClient = twilio(
  process.env.TWILIO_API_KEY,
  process.env.TWILIO_API_SECRET,
  { accountSid: process.env.TWILIO_ACCOUNT_SID }
);

console.log("📞 Twilio enabled");

// =====================================================
// CONSTANTS
// =====================================================
const APP_BASE_URL =
  process.env.APP_BASE_URL || "https://simclaire-website-backend.onrender.com";
const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL || "https://simclaire-website-backend.onrender.com";

// =====================================================
// STRIPE CHECKOUT SESSION (WORKING VERSION)
// =====================================================
app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
    const {
      email,
      quantity,
      price,
      currency,
      planName,
      metadata,
    } = req.body;

    if (!stripe) {
      return res.status(500).json({ error: "Stripe not configured" });
    }

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
            product_data: {
              name: planName,
            },
          },
        },
      ],

      metadata: metadata || {},
    });

    return res.json({
      id: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error("❌ Stripe checkout error:", err.message);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// =====================================================
// STRIPE WEBHOOK (NO FULFILLMENT — RECEIPT ONLY)
// =====================================================
if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
  app.post("/webhook/stripe", async (req, res) => {
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

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("✅ Payment completed:", session.id);
      // Stripe automatically sends receipt email
    }

    res.json({ received: true });
  });
}

// =====================================================
// BASIC PAGES
// =====================================================
app.get("/", (req, res) => {
  res.send("SimClaire backend is running ✅");
});

app.get("/success", (req, res) =>
  res.send("<h1>Payment Successful ✔️</h1>You may now return to WhatsApp.")
);

app.get("/cancel", (req, res) =>
  res.send("<h1>Payment Cancelled ❌</h1>You may retry from WhatsApp.")
);

// =====================================================
// TWILIO XML HELPERS
// =====================================================
function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(message)}</Message>
</Response>`;
}

// =====================================================
// SIMPLE SESSION STORE
// =====================================================
const sessions = {};

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = { step: "MENU" };
  }
  return sessions[id];
}

function resetSession(id) {
  sessions[id] = { step: "MENU" };
}

// =====================================================
// WHATSAPP WEBHOOK (WORKING FLOW)
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const fromRaw = req.body.WaId || req.body.From || "";
    const from = fromRaw.replace("whatsapp:", "");
    const text = (req.body.Body || "").trim().toLowerCase();

    const session = getSession(from);

    // HI / HELLO
    if (["hi", "hello", "hey", "menu"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml(
          "👋 Welcome to SimClaire!\n\n1) Buy eSIM\n2) Support"
        )
      );
    }

    // MENU
    if (session.step === "MENU") {
      if (text === "1") {
        session.step = "PAY";
        return res.send(
          twiml("💳 Please confirm to receive your secure payment link.\nReply YES to continue.")
        );
      }

      if (text === "2") {
        return res.send(twiml("📧 Support: care@simclaire.com"));
      }

      return res.send(twiml("Type menu to begin."));
    }

    // PAYMENT LINK
    if (session.step === "PAY" && text === "yes") {
      resetSession(from);

      return res.send(
        twiml(
          `💳 Complete your purchase here:\n\n${BACKEND_BASE_URL}/success\n\n(Stripe receipt will be emailed automatically)`
        )
      );
    }

    return res.send(twiml("Type menu to restart."));
  } catch (err) {
    console.error("❌ WhatsApp error:", err);
    return res.send(twiml("⚠️ Something went wrong. Type menu."));
  }
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🔥 SimClaire backend running on port ${PORT}`)
);