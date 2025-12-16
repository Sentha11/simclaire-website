// =====================================================
// server.js – SimClaire Backend (FINAL CLEAN VERSION)
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
const path = require("path");
const fs = require("fs");
const whatsappState = {};
const app = express();

// =====================================================
// 0) PROXY SETUP (QuotaGuard)
// =====================================================
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using QuotaGuard STATIC proxy");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 Using QuotaGuard SOCKS5 proxy");
}

// =====================================================
// 1) ESIM API CONFIG
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

let esimToken = null;
let esimExpiresAt = 0;

// =====================================================
// AUTHENTICATE TO ESIM PROVIDER
// =====================================================
async function getEsimToken() {
  if (esimToken && Date.now() < esimExpiresAt) return esimToken;

  const res = await axios.post(
    `${ESIM_BASE_URL}/authenticate`,
    {
      userName: ESIM_USERNAME,
      password: ESIM_PASSWORD,
    },
    { httpsAgent: proxyAgent, proxy: false }
  );

  esimToken = res.data.token;
  esimExpiresAt = Date.now() + (res.data.expirySeconds || 600) * 1000;

  console.log("🔐 New eSIM token issued");
  return esimToken;
}

// =====================================================
// UNIVERSAL ESIM REQUEST WRAPPER
// =====================================================
async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();

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
}

// =====================================================
// PURCHASE ESIM
// =====================================================
async function purchaseEsim({ sku, quantity, type, destinationId }) {
  const payload = {
    items: [
      {
        sku,
        quantity,
        type,
        destinationId,
      },
    ],
  };

  console.log("📦 FINAL PURCHASE PAYLOAD:", payload);

  return await esimRequest("post", "/purchase", {
    data: payload,
  });
}

// =====================================================
// EXPRESS MIDDLEWARE
// =====================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =====================================================
// TWILIO CLIENT (SAFE API KEY MODE)
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

  console.log("📞 Twilio initialized using API Key mode");
} else {
  console.warn("⚠️ Twilio disabled (missing TWILIO_API_KEY or SECRET)");
}

// =====================================================
// STRIPE INIT
// =====================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
}

// =====================================================
// SENDGRID INIT
// =====================================================
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid enabled");
}

const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const SENDGRID_FROM_NAME = "SimClaire";

// =====================================================
// PDF GENERATION
// =====================================================
function generateEsimPdfBuffer({ meta, amount, currency, purchaseResult }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];

    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(22).text("SimClaire — eSIM Order", { underline: true });
    doc.moveDown();

    doc.fontSize(14).text(`Destination: ${meta.country}`);
    doc.text(`Plan: ${meta.planName}`);
    doc.text(`Data: ${meta.data}`);
    doc.text(`Amount Paid: ${currency}${amount}`);
    doc.moveDown();

    if (purchaseResult) {
      doc.text(`Transaction ID: ${purchaseResult.transactionId || "N/A"}`);
      if (purchaseResult.activationCode)
        doc.text(`Activation Code: ${purchaseResult.activationCode}`);
    }

    doc.end();
  });
}

// =====================================================
// SEND EMAIL (SENDGRID)
// =====================================================
async function sendEsimEmail({ to, meta, amount, currency, purchaseResult }) {
  const pdf = await generateEsimPdfBuffer({
    meta,
    amount,
    currency,
    purchaseResult,
  });

  const msg = {
    to,
    from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
    subject: `Your eSIM for ${meta.country}`,
    text: "Your eSIM & instructions are attached",
    attachments: [
      {
        content: pdf.toString("base64"),
        type: "application/pdf",
        filename: "SimClaire-eSIM.pdf",
      },
    ],
  };

  await sgMail.send(msg);
  console.log("📧 Email sent to:", to);
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
      planName,
      productSku,
      productType,
      data,
      validity,
      country,
      mobile,
      destinationId,
      metadata,
    } = req.body;

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      success_url: `${process.env.BACKEND_BASE_URL}/success`,
      cancel_url: `${process.env.BACKEND_BASE_URL}/cancel`,
      payment_method_types: ["card"],
      line_items: [
        {
          quantity,
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(price * 100),
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
        quantity,
        email,
        mobile,
        country,
        destinationId,
        whatsappTo: metadata?.whatsappTo,
        flagEmoji: metadata?.flagEmoji,
      },
    });

    res.json({ id: checkout.id, url: checkout.url });
  } catch (err) {
    console.error("❌ Stripe session error:", err);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// =====================================================
// STRIPE WEBHOOK — PAYMENT SUCCESSFUL
// =====================================================
app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 🎉 PAYMENT COMPLETE
    if (event.type === "checkout.session.completed") {
      const sessionObj = event.data.object;
      const meta = sessionObj.metadata;
      const amount = (sessionObj.amount_total / 100).toFixed(2);

      // 1️⃣ Purchase eSIM
      let purchaseResult = null;
      try {
        purchaseResult = await purchaseEsim({
          sku: meta.productSku,
          quantity: Number(meta.quantity),
          type: Number(meta.productType),
          destinationId: Number(meta.destinationId),
        });
      } catch (err) {
        console.error("❌ Purchase error:", err.response?.data || err);
      }

      // 2️⃣ Send WhatsApp confirmation
      if (twilioClient && meta.whatsappTo) {
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: meta.whatsappTo,
          body: `🎉 Payment received!\n${meta.flagEmoji} ${meta.country}\n${meta.planName}\nAmount: £${amount}`,
        });
      }

      // 3️⃣ Send email
      await sendEsimEmail({
        to: meta.email,
        meta,
        amount,
        currency: "£",
        purchaseResult,
      });
    }

    res.json({ received: true });
  }
);

// =====================================================
// BASIC ROUTES
// =====================================================
app.get("/success", (req, res) => res.send("Payment Success ✔"));
app.get("/cancel", (req, res) => res.send("Payment Cancelled ❌"));

// =====================================================
// WHATSAPP FLOW ENTRY POINT — RESPOND TO HI/HELLO
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const body = req.body.Body?.trim().toLowerCase() || "";

  if (["hi", "hello", "hey"].includes(body)) {
    return res.send(`
      <Response>
        <Message>👋 Welcome to SimClaire!\nReply with:\n1) Browse Plans\n2) FAQ\n3) Support</Message>
      </Response>
    `);
  }

  // (You can add full WhatsApp flow here if needed)
  return res.send(`
    <Response>
      <Message>Type hi to begin.</Message>
    </Response>
  `);
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 Backend running on port ${PORT}`));