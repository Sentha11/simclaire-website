// =====================================================
// server.js – SimClaire Backend (FINAL CLEAN BUILD)
// Stripe + eSIM + SendGrid + WhatsApp + Proxy Support
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const twilio = require("twilio");
const PDFDocument = require("pdfkit");
const sgMail = require("@sendgrid/mail");
const path = require("path");

const app = express();

// =====================================================
// 1) PROXY SETUP (QuotaGuard HTTPS or SOCKS)
// =====================================================
let proxyAgent = null;
if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using QuotaGuard STATIC IP (HTTPS)");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 Using QuotaGuard SOCKS5");
}

// =====================================================
// 2) ESIM CONFIG
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL; 
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

let esimToken = null;
let esimExpiresAt = 0;

// =====================================================
// 3) ESIM AUTH TOKEN
// =====================================================
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

// =====================================================
// 4) ESIM API WRAPPER
// =====================================================
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
    console.error("❌ ESIM API Error:", err.response?.data || err.message);
    throw err;
  }
}

// =====================================================
// 5) PURCHASE ESIM
// =====================================================
async function purchaseEsim({ sku, quantity, type, destinationId }) {
  const payload = {
    items: [
      { sku, quantity, type, destinationId }
    ]
  };

  console.log("📦 PURCHASE PAYLOAD:", payload);

  return await esimRequest("post", "/purchase", { data: payload });
}

// =====================================================
// 6) INIT EXPRESS + MIDDLEWARE
// =====================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =====================================================
// 7) TWILIO INIT
// =====================================================
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log("📞 Twilio Enabled");
}

// =====================================================
// 8) STRIPE INIT
// =====================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe Enabled");
}

// =====================================================
// 9) SENDGRID INIT
// =====================================================
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid Enabled");
}

const SENDGRID_FROM_EMAIL = "care@simclaire.com";

// =====================================================
// 10) PDF GENERATOR (Simple Receipt)
// =====================================================
function generateEsimPdf(meta, purchaseResult, amount, currencySymbol) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];

    doc.on("data", (d) => chunks.push(d));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(24).text("SimClaire – eSIM Order", { underline: true });
    doc.moveDown();

    doc.fontSize(14).text(`Destination: ${meta.country}`);
    doc.text(`Plan: ${meta.planName}`);
    doc.text(`Data: ${meta.data}`);
    doc.text(`Amount Paid: ${currencySymbol}${amount}`);
    doc.moveDown();

    if (purchaseResult) {
      doc.text(`Transaction ID: ${purchaseResult.transactionId || "N/A"}`);
      if (purchaseResult.activationCode)
        doc.text(`Activation Code: ${purchaseResult.activationCode}`);
    }

    doc.text("\nYour QR code will be sent in a separate email automatically by the provider.");
    doc.end();
  });
}

// =====================================================
// 11) SEND EMAIL (SendGrid)
// =====================================================
async function sendEsimEmail({ to, meta, amount, currency, purchaseResult }) {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";

  const pdf = await generateEsimPdf(meta, purchaseResult, amount, symbol);

  await sgMail.send({
    to,
    from: SENDGRID_FROM_EMAIL,
    subject: `Your eSIM for ${meta.country}`,
    text: "Your eSIM receipt is attached. The QR will arrive separately from the provider.",
    attachments: [
      {
        content: pdf.toString("base64"),
        filename: "SimClaire-eSIM.pdf",
        type: "application/pdf",
        disposition: "attachment",
      },
    ],
  });

  console.log("📧 SendGrid email sent to", to);
}

// =====================================================
// 12) STRIPE CHECKOUT SESSION
// =====================================================
app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
    const body = req.body;

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: body.email,
      success_url: `${process.env.APP_BASE_URL}/success`,
      cancel_url: `${process.env.APP_BASE_URL}/cancel`,
      line_items: [
        {
          quantity: body.quantity,
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(body.price * 100),
            product_data: { name: body.planName },
          },
        },
      ],
      metadata: body.metadata,
    });

    res.json({ url: checkout.url });
  } catch (err) {
    console.error("❌ Stripe Checkout Error:", err);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// =====================================================
// 13) STRIPE WEBHOOK
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
      console.error("❌ Invalid Stripe Signature:", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const meta = session.metadata || {};

      // 1️⃣ Purchase ESIM
      let purchaseResult = null;
      try {
        purchaseResult = await purchaseEsim({
          sku: meta.productSku,
          quantity: Number(meta.quantity),
          type: Number(meta.productType),
          destinationId: Number(meta.destinationId),
        });
      } catch (err) {
        console.error("❌ purchaseEsim failed:", err.response?.data || err);
      }

      // 2️⃣ Email Customer
      try {
        await sendEsimEmail({
          to: meta.email,
          meta,
          amount: (session.amount_total / 100).toFixed(2),
          currency: session.currency,
          purchaseResult,
        });
      } catch (err) {
        console.error("❌ SendGrid Error:", err);
      }

      // 3️⃣ WhatsApp Confirmation
      if (twilioClient && meta.whatsappTo) {
        let msg = `
🎉 Payment Successful!

${meta.flagEmoji} ${meta.country}
${meta.planName}
${meta.data}

Your eSIM receipt has been emailed.
Your QR will arrive shortly from provider.
        `;

        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: meta.whatsappTo,
          body: msg.trim(),
        });
      }
    }

    res.json({ received: true });
  }
);

// =====================================================
// 14) SIMPLE TWIML HELPER
// =====================================================
function twiml(msg) {
  return `<?xml version="1.0"?>
<Response><Message>${msg}</Message></Response>`;
}

// =====================================================
// 15) IN-MEMORY SESSION
// =====================================================
const sessions = {};
function getSession(id) {
  if (!sessions[id]) sessions[id] = { step: "MENU", products: [] };
  return sessions[id];
}
function resetSession(id) {
  sessions[id] = { step: "MENU", products: [] };
}

// =====================================================
// 16) WHATSAPP WEBHOOK
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From?.replace("whatsapp:", "");
  const text = (req.body.Body || "").trim().toLowerCase();

  // 👋 NEW FEATURE — Respond to "hi" or "hello"
  if (["hi", "hello", "hey"].includes(text)) {
    return res.send(twiml("👋 Hi! Welcome to SimClaire.\nType menu anytime to begin."));
  }

  const session = getSession(from);

  // Reset
  if (text === "menu") {
    resetSession(from);
    return res.send(
      twiml("👋 Welcome to SimClaire!\n\n1) Browse Plans\n2) FAQ\n3) Support")
    );
  }

  // MENU
  if (session.step === "MENU") {
    if (text === "1") {
      session.step = "COUNTRY";
      return res.send(
        twiml("🌍 Enter your travel destination (example: Italy, Japan, USA)")
      );
    }
    if (text === "2") return res.send(twiml("FAQ coming soon"));
    if (text === "3") return res.send(twiml("Support: care@simclaire.com"));
    return res.send(
      twiml("👋 Welcome to SimClaire!\n\n1) Browse Plans\n2) FAQ\n3) Support")
    );
  }

  // COUNTRY SEARCH
  if (session.step === "COUNTRY") {
    const listRes = await esimRequest("get", "/destinations");
    const list = listRes.data || listRes;

    const match = list.find((d) =>
      d.destinationName.toLowerCase().includes(text)
    );

    if (!match) {
      return res.send(twiml("❌ No match. Try again or type menu."));
    }

    session.country = match.destinationName;
    session.destinationId = match.destinationID;
    session.step = "PLAN";

    const prodRes = await esimRequest(
      "get",
      `/products?destinationid=${match.destinationID}`
    );
    const products = prodRes.data || prodRes;
    session.products = products;

    let msg = `📡 Plans for *${session.country}*:\n\n`;
    products.slice(0, 5).forEach((p, i) => {
      msg += `${i + 1}) ${p.productName}\n💾 ${p.productDataAllowance}\n📅 ${p.validity} days\n💵 £${p.productPrice}\n\n`;
    });
    msg += "Reply with 1–5 to choose.";

    return res.send(twiml(msg));
  }

  // PLAN SELECT
  if (session.step === "PLAN") {
    const idx = parseInt(text);
    if (!idx || idx < 1 || idx > session.products.length)
      return res.send(twiml("Invalid option. Try again."));

    session.selectedProduct = session.products[idx - 1];
    session.step = "QTY";
    return res.send(twiml("📦 How many eSIMs? (1–10)"));
  }

  // QUANTITY
  if (session.step === "QTY") {
    const qty = parseInt(text);
    if (!qty || qty < 1 || qty > 10)
      return res.send(twiml("Enter 1–10"));
    session.quantity = qty;
    session.step = "MOBILE";
    return res.send(twiml("📱 Enter your mobile number (+447...)"));
  }

  // MOBILE
  if (session.step === "MOBILE") {
    const num = req.body.Body.trim();
    if (!/^\+?\d{7,15}$/.test(num))
      return res.send(twiml("Invalid number. Try again."));
    session.mobile = num;
    session.step = "EMAIL";
    return res.send(twiml("📧 Enter your email:"));
  }

  // EMAIL CONFIRM
  if (session.step === "EMAIL") {
    const email = req.body.Body.trim();
    if (!email.includes("@"))
      return res.send(twiml("Invalid email. Try again."));
    session.email = email;

    const p = session.selectedProduct;

    const checkoutRes = await axios.post(
      `${process.env.APP_BASE_URL}/api/payments/create-checkout-session`,
      {
        email,
        quantity: session.quantity,
        price: p.productPrice,
        currency: "gbp",
        planName: p.productName,
        productSku: p.productSku,
        productType: p.productType,
        data: p.productDataAllowance,
        validity: p.validity,
        country: session.country,
        mobile: session.mobile,
        destinationId: session.destinationId,
        metadata: {
          email,
          country: session.country,
          planName: p.productName,
          data: p.productDataAllowance,
          productSku: p.productSku,
          productType: p.productType,
          destinationId: session.destinationId,
          flagEmoji: "📶",
          whatsappTo: `whatsapp:${from}`,
        },
      }
    );

    resetSession(from);

    return res.send(
      twiml(`💳 Payment link:\n${checkoutRes.data.url}`)
    );
  }

  return res.send(twiml("Type menu to start again."));
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 SimClaire backend running on port ${PORT}`)
);