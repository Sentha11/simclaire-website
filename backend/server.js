// =====================================================
// server.js – FINAL WORKING VERSION FOR SIMCLAIRE
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
// 1) PROXY SETUP
// =====================================================
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using HTTP QuotaGuard proxy");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 Using SOCKS QuotaGuard proxy");
}

// =====================================================
// 2) ESIM API CONFIG
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

let esimToken = null;
let esimExpiresAt = 0;

async function getEsimToken() {
  if (esimToken && Date.now() < esimExpiresAt) return esimToken;

  const response = await axios.post(
    `${ESIM_BASE_URL}/authenticate`,
    { userName: ESIM_USERNAME, password: ESIM_PASSWORD },
    { httpsAgent: proxyAgent, proxy: false }
  );

  esimToken = response.data.token;
  esimExpiresAt = Date.now() + (response.data.expirySeconds || 600) * 1000;

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
      headers: { Authorization: `Bearer ${token}`},
      ...options,
    });
    return result.data;
  } catch (err) {
    console.error("❌ ESIM API Error:", err.response?.data || err.message);
    throw err;
  }
}

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

  console.log("📦 PURCHASE PAYLOAD:", payload);

  return await esimRequest("post", "/purchase", {
    data: payload,
  });
}

// =====================================================
// EXPRESS MIDDLEWARE (MUST COME AFTER WEBHOOK)
// =====================================================
app.use(cors());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// =====================================================
// 3) TWILIO + STRIPE + SENDGRID
// =====================================================
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log("📞 Twilio Ready");
}

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe Ready");
}

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid Ready");
}

const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;

// =====================================================
// 4) STRIPE CHECKOUT SESSION
// =====================================================
app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
    const body = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: body.email,

      success_url: `${process.env.APP_BASE_URL}/success`,
      cancel_url: `${process.env.APP_BASE_URL}/cancel`,

      payment_method_types: ["card"],

      line_items: [
        {
          quantity: body.quantity,
          price_data: {
            currency: "gbp",
            product_data: { name: body.planName },
            unit_amount: Math.round(body.price * 100),
          },
        },
      ],

      metadata: {
        ...body.metadata,
      },
    });

    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error("❌ Stripe session error:", err);
    return res.status(500).json({ error: "Stripe failed" });
  }
});

// =====================================================
// 5) STRIPE WEBHOOK
// =====================================================
app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Stripe Webhook Error:", err.message);
      return res.status(400).send("Webhook error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const meta = session.metadata;

      console.log("🎉 PAYMENT COMPLETED");
      console.log("Metadata:", meta);

      // 1️⃣ PURCHASE ESIM
      let purchaseResult = null;
      try {
        purchaseResult = await purchaseEsim({
          sku: meta.productSku,
          quantity: Number(meta.quantity),
          type: Number(meta.productType),
          destinationId: Number(meta.destinationId),
        });
      } catch (err) {
        console.error("❌ purchaseEsim error:", err);
      }

      // 2️⃣ SEND CONFIRMATION WHATSAPP
      if (twilioClient && meta.whatsappTo) {
        try {
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_FROM,
            to: meta.whatsappTo,
            body: `🎉 Payment Successful!\n\nYour eSIM is being emailed.\n\nTransaction: ${purchaseResult?.transactionId || "N/A"}`,
          });
        } catch (err) {
          console.error("❌ WhatsApp send failed:", err);
        }
      }

      // 3️⃣ EMAIL CUSTOMER
      try {
        await sendEsimEmail({
          to: meta.email,
          meta,
          purchaseResult,
        });
      } catch (err) {
        console.error("❌ Email error:", err);
      }
    }

    res.json({ received: true });
  }
);

// =====================================================
// PDF + SENDGRID
// =====================================================
async function generatePdf({ meta, purchaseResult }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(22).text("Your eSIM From SimClaire", { underline: true });
    doc.moveDown();

    doc.fontSize(14).text(`Destination: ${meta.country}`);
    doc.text(`Plan: ${meta.planName}`);
    doc.text(`Data: ${meta.data}`);
    doc.moveDown();

    doc.text(`Transaction ID: ${purchaseResult?.transactionId || "N/A"}`);

    doc.end();
  });
}

async function sendEsimEmail({ to, meta, purchaseResult }) {
  const pdfBuffer = await generatePdf({ meta, purchaseResult });

  const msg = {
    to,
    from: SENDGRID_FROM_EMAIL,
    subject: `Your eSIM for ${meta.country}`,
    text: "Attached is your eSIM file.",
    attachments: [
      {
        filename: "SimClaire-eSIM.pdf",
        type: "application/pdf",
        content: pdfBuffer.toString("base64"),
      },
    ],
  };

  await sgMail.send(msg);
}

// =====================================================
// WHATSAPP BOT
// =====================================================
app.use(express.urlencoded({ extended: false })); 
app.use(express.json());

let sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { step: "MENU", products: [] };
  return sessions[id];
}

function resetSession(id) {
  sessions[id] = { step: "MENU", products: [] };
}

function twiml(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;
}

app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from =
    req.body.WaId ||
    req.body.From?.replace("whatsapp:", "") ||
    "unknown";

  const text = (req.body.Body || "").trim().toLowerCase();
  const session = getSession(from);

  try {
    if (["menu", "main"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml("👋 Welcome to SimClaire!\n1) Browse plans\n2) FAQ\n3) Support")
      );
    }

    if (session.step === "MENU") {
      if (text === "1") {
        session.step = "COUNTRY";
        return res.send(
          twiml("🌍 Enter your travel destination (e.g. Italy, Japan, USA)")
        );
      }
    }

    if (session.step === "COUNTRY") {
      const destRes = await esimRequest("get", "/destinations");
      const list = Array.isArray(destRes.data) ? destRes.data : [];

      const match = list.find((d) =>
        d.destinationName.toLowerCase().includes(text)
      );

      if (!match)
        return res.send(
          twiml("❌ Destination not found. Try again or type menu.")
        );

      session.country = match.destinationName;
      session.destinationId = match.destinationID;
      session.step = "PLAN";

      const prodRes = await esimRequest(
        "get",
        `/products?destinationid=${match.destinationID}`
      );
      const products = prodRes.data || [];
      session.products = products;

      let msg = `📡 Plans for ${session.country}:\n\n`;
      products.slice(0, 5).forEach((p, i) => {
        msg += `${i + 1}) ${p.productName} - £${p.productPrice}\n`;
      });

      return res.send(twiml(msg + "\nReply with 1–5"));
    }

    if (session.step === "PLAN") {
      const index = parseInt(text);
      const product = session.products[index - 1];

      if (!product)
        return res.send(twiml("❌ Invalid selection. Try 1–5."));

      session.selectedProduct = product;
      session.step = "QTY";
      return res.send(twiml("How many eSIMs? (1–10)"));
    }

    if (session.step === "QTY") {
      const qty = parseInt(text);
      if (qty < 1 || qty > 10)
        return res.send(twiml("❌ Enter a number between 1–10."));
      session.quantity = qty;
      session.step = "MOBILE";
      return res.send(twiml("📱 Enter your mobile number (e.g. +447900123456)"));
    }

    if (session.step === "MOBILE") {
      session.mobile = req.body.Body.trim();
      session.step = "EMAIL";
      return res.send(twiml("📧 Enter your email address:"));
    }

    if (session.step === "EMAIL") {
      session.email = req.body.Body.trim();
      session.step = "CONFIRM_EMAIL";
      return res.send(twiml("Please confirm your email:"));
    }

    if (session.step === "CONFIRM_EMAIL") {
      if (req.body.Body.trim() !== session.email)
        return res.send(twiml("❌ Emails do not match. Try again."));

      const p = session.selectedProduct;

      const response = await axios.post(
        `${process.env.BACKEND_BASE_URL}/api/payments/create-checkout-session`,
        {
          email: session.email,
          quantity: session.quantity,
          price: p.productPrice,
          currency: "gbp",
          planName: p.productName,
          productSku: p.productSku || p.productSKU,
          productType: p.productType,
          data: p.productDataAllowance,
          validity: p.validity,
          country: session.country,
          mobile: session.mobile,
          destinationId: session.destinationId,
          metadata: {
            email: session.email,
            country: session.country,
            planName: p.productName,
            productSku: p.productSku || p.productSKU,
            productType: p.productType,
            destinationId: session.destinationId,
            quantity: session.quantity,
            whatsappTo: `whatsapp:${from}`,
          },
        }
      );

      resetSession(from);

      return res.send(
        twiml(
          `💳 *Secure Payment Link*\n${response.data.url}\n\nYour eSIM will be delivered after payment.`
        )
      );
    }

    return res.send(twiml("❌ I didn’t understand. Type menu."));
  } catch (err) {
    console.error("❌ WhatsApp Error:", err);
    return res.send(twiml("⚠️ Something broke. Type menu."));
  }
});

// SUCCESS + CANCEL
app.get("/success", (req, res) =>
  res.send("<h1>Payment Successful ✔️</h1><p>You may now return to WhatsApp.</p>")
);

app.get("/cancel", (req, res) =>
  res.send("<h1>Payment Canceled ❌</h1><p>You may retry from WhatsApp.</p>")
);

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 Backend is live → Port ${PORT}`)
);