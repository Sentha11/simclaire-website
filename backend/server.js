// =====================================================
// server.js – SimClaire Backend (Corrected Option A)
// ESIM + WhatsApp + Stripe + QuotaGuard + SendGrid
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const twilio = require("twilio");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const sgMail = require("@sendgrid/mail");

const app = express();

// =====================================================
// 1) QUOTAGUARD PROXY SETUP
// =====================================================
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using QuotaGuard STATIC HTTP proxy");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 Using QuotaGuard SOCKS5 proxy");
}

// =====================================================
// 2) ESIM BASE URL (UAT)
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL; 
// Example: https://uat.esim-api.com/api/esim

const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

// =====================================================
// 3) REMOVE BROKEN GLOBAL axios.defaults.baseURL
// =====================================================
// ❌ DO NOT SET axios.defaults.baseURL (breaks eSIM API)
// =====================================================

// =====================================================
// 4) ESIM AUTH TOKEN SYSTEM
// =====================================================
let esimToken = null;
let esimExpiresAt = 0;

async function getEsimToken() {
  if (esimToken && Date.now() < esimExpiresAt) return esimToken;

  const res = await axios.post(
    `${ESIM_BASE_URL}/authenticate`,
    {
      userName: ESIM_USERNAME,
      password: ESIM_PASSWORD,
    },
    {
      httpsAgent: proxyAgent,
      proxy: false,
    }
  );

  esimToken = res.data.token;
  esimExpiresAt = Date.now() + (res.data.expirySeconds || 600) * 1000;

  return esimToken;
}

// =====================================================
// 5) ESIM REQUEST WRAPPER (CORRECTED)
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
    console.error("❌ ESIM request error:", err.response?.data || err.message);
    throw err;
  }
}

// =====================================================
// 6) PURCHASE ESIM (CORRECTED ENDPOINT)
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

  // ✔ Correct path — NO /api/esim/purchase
  return await esimRequest("post", "/purchase", {
    data: payload,
  });
}

// =====================================================
// EXPRESS + TWILIO + STRIPE INIT
// =====================================================
app.use(cors());

// Twilio
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log("📞 Twilio enabled");
}

// Stripe
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
}

// SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid enabled");
}

const SENDGRID_FROM_EMAIL =
  process.env.SENDGRID_FROM_EMAIL || "care@simclaire.com";
const SENDGRID_FROM_NAME =
  process.env.SENDGRID_FROM_NAME || "SimClaire";

const LOGO_PATH = path.join(__dirname, "assets", "simclaire-logo.png");

// =====================================================
// STRIPE CHECKOUT SESSION (Corrected)
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
      metadata,
    } = req.body;

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,

      success_url: `${process.env.APP_BASE_URL}/success`,
      cancel_url: `${process.env.APP_BASE_URL}/cancel`,

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
        whatsappTo: metadata?.whatsappTo || "",
        flagEmoji: metadata?.flagEmoji || "",
      },
    });

    return res.json({ id: checkout.id, url: checkout.url });
  } catch (err) {
    console.error("❌ Stripe checkout error:", err);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// =====================================================
// STRIPE WEBHOOK — PAYMENT COMPLETED
// =====================================================
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

      app.use(express.urlencoded({ extended: false })); // For WhatsApp Webhook
      app.use(express.json());


      // ✔ Payment Completed
      if (event.type === "checkout.session.completed") {
        const sessionObj = event.data.object;
        const meta = sessionObj.metadata || {};

        const amount = (sessionObj.amount_total / 100).toFixed(2);
        const currencyCode = (sessionObj.currency || "GBP").toUpperCase();

        let symbol = currencyCode === "USD" ? "$" :
                     currencyCode === "EUR" ? "€" : "£";

        console.log("🎟 Stripe metadata:", meta);

        

        // ------------------------------------------------------
        // 1️⃣ PURCHASE THE ESIM (CORRECTED ENDPOINT)
        // ------------------------------------------------------
        let purchaseResult = null;

        try {
          purchaseResult = await purchaseEsim({
            sku: meta.productSku,
            quantity: Number(meta.quantity || 1),
            type: Number(meta.productType),
            destinationId: Number(meta.destinationId),
          });

          console.log("✅ purchaseEsim response:", purchaseResult);
        } catch (err) {
          console.error(
            "❌ Error calling purchaseEsim:",
            err.response?.data || err.message
          );
        }

        // ------------------------------------------------------
        // 2️⃣ SEND WHATSAPP CONFIRMATION
        // ------------------------------------------------------
        try {
          let msg = `
🎉 Payment Successful!

${meta.flagEmoji || ""} ${meta.country}
📦 ${meta.planName}
💾 ${meta.data}
💵 ${symbol}${amount}

📧 ${meta.email}
`;

          if (purchaseResult?.transactionId)
            msg += `🆔 Transaction: ${purchaseResult.transactionId}\n`;

          if (purchaseResult?.activationCode)
            msg += `🔐 Activation Code: ${purchaseResult.activationCode}\n`;

          msg += `\nYour official eSIM email with PDF will arrive shortly.`;

          if (
            twilioClient &&
            meta.whatsappTo &&
            process.env.TWILIO_WHATSAPP_FROM
          ) {
            await twilioClient.messages.create({
              from: process.env.TWILIO_WHATSAPP_FROM,
              to: meta.whatsappTo,
              body: msg.trim(),
            });

            console.log("✅ WhatsApp confirmation sent");
          }
        } catch (err) {
          console.error("❌ WhatsApp send error:", err);
        }

        // ------------------------------------------------------
        // 3️⃣ SEND EMAIL WITH PDF (CORRECTED SENDGRID BLOCK)
        // ------------------------------------------------------
        try {
          const customerEmail =
            sessionObj.customer_details?.email || meta.email;

          await sendEsimEmail({
            to: customerEmail,
            meta,
            amount,
            currency: currencyCode,
            purchaseResult,
          });

          console.log("📧 eSIM email sent");
        } catch (err) {
          console.error("❌ SendGrid email error:", err);
        }
      }

      res.json({ received: true });
    }
  );
} else {
  console.warn("⚠️ Stripe webhook disabled (missing STRIPE_WEBHOOK_SECRET)");
}

// =====================================================
// PDF GENERATION (UNCHANGED, WORKING)
// =====================================================
function generateEsimPdfBuffer({ meta, amount, currency, purchaseResult }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];

      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Title
      doc.fontSize(22).text("SimClaire — eSIM Order", { underline: true });
      doc.moveDown();

      doc.fontSize(14).text(`Destination: ${meta.country}`);
      doc.text(`Plan: ${meta.planName}`);
      doc.text(`Data: ${meta.data}`);
      doc.text(`Amount Paid: ${currency}${amount}`);
      doc.moveDown();

      if (purchaseResult) {
        doc.fontSize(12).text(`Transaction ID: ${purchaseResult.transactionId || "N/A"}`);
        if (purchaseResult.activationCode)
          doc.text(`Activation Code: ${purchaseResult.activationCode}`);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// =====================================================
// SEND EMAIL (SendGrid)
// =====================================================
async function sendEsimEmail({ to, meta, amount, currency, purchaseResult }) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn("⚠️ SendGrid disabled");
    return;
  }

  const pdfBuffer = await generateEsimPdfBuffer({
    meta,
    amount,
    currency: currency === "GBP" ? "£" : "$",
    purchaseResult,
  });

  const msg = {
    to,
    from: {
      email: SENDGRID_FROM_EMAIL,
      name: SENDGRID_FROM_NAME,
    },
    subject: `Your eSIM for ${meta.country}`,
    text: "Your eSIM is attached as a PDF.",
    attachments: [
      {
        content: pdfBuffer.toString("base64"),
        filename: "SimClaire-eSIM.pdf",
        type: "application/pdf",
      },
    ],
  };

  await sgMail.send(msg);
}

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
// TEST ESIM ENDPOINT
// =====================================================
app.get("/test-esim", async (req, res) => {
  try {
    console.log("🔍 Running /test-esim check...");

    const token = await getEsimToken();
    console.log("🔐 Token received:", token ? "YES" : "NO");

    const data = await esimRequest("get", "/destinations");

    const destinations = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
      ? data
      : [];

    console.log("🌍 Destinations:", destinations.length);

    return res.json({
      ok: true,
      message: "Render → Proxy → eSIM API connection works!",
      destinationsCount: destinations.length,
      sample: destinations.slice(0, 3),
    });
  } catch (err) {
    console.error("❌ /test-esim ERROR:", err.response?.data || err.message);
    return res.json({
      ok: false,
      error: err.response?.data || err.message,
    });
  }
});

// =====================================================
// DEBUG — GET PRODUCTS FOR A DESTINATION
// =====================================================
app.get("/debug/products", async (req, res) => {
  try {
    const id = req.query.destinationid;
    if (!id) {
      return res.json({ error: "destinationid query parameter is required" });
    }

    console.log("🔍 Fetching products for destination:", id);

    const data = await esimRequest("get", `/products?destinationid=${id}`);

    const products = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

    return res.json({
      ok: true,
      destinationid: id,
      count: products.length,
      products,
    });
  } catch (err) {
    console.error("❌ /debug/products error:", err.response?.data || err.message);
    return res.json({
      ok: false,
      error: err.response?.data || err.message,
    });
  }
});

// =====================================================
// TWILIO XML RESPONSE HELPER
// =====================================================
function escapeXml(unsafe) {
  return unsafe
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
// SIMPLE IN-MEMORY SESSION STORE
// =====================================================
let sessions = {};

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = {
      step: "MENU",
      products: [],
    };
  }
  return sessions[id];
}

function resetSession(id) {
  sessions[id] = {
    step: "MENU",
    products: [],
  };
}

// =====================================================
// WHATSAPP WEBHOOK — MAIN FLOW
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const from = req.body.WaId || req.body.From?.replace("whatsapp:", "");
    const text = (req.body.Body || "").trim().toLowerCase();
    const session = getSession(from);

    // MENU RESET
    if (["menu", "main"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml(
          "👋 Welcome to SimClaire!\n\n1) Browse plans\n2) FAQ\n3) Support"
        )
      );
    }

    // MENU OPTIONS
    if (session.step === "MENU") {
      if (text === "1") {
        session.step = "COUNTRY";
        return res.send(
          twiml(
            "🌍 Enter your travel destination.\nExample: Italy, USA, Japan, United Kingdom."
          )
        );
      }

      if (text === "2") {
        return res.send(
          twiml("ℹ️ FAQ: Visit https://simclaire.com/faq (coming soon)")
        );
      }

      if (text === "3") {
        return res.send(twiml("📞 Support: care@simclaire.com"));
      }

      // Default menu
      return res.send(
        twiml(
          "👋 Welcome to SimClaire!\n\n1) Browse plans\n2) FAQ\n3) Support"
        )
      );
    }

    // =================================================
    // COUNTRY SEARCH (FIXED: handle array correctly)
    // =================================================
    if (session.step === "COUNTRY") {
      const destRes = await esimRequest("get", "/destinations");

      const list = Array.isArray(destRes?.data)
        ? destRes.data
        : Array.isArray(destRes)
        ? destRes
        : [];

      if (!list.length) {
        console.error("❌ No destinations array returned:", destRes);
        return res.send(
          twiml("❌ No destinations available. Try again later or type menu.")
        );
      }

      const match = list.find((d) =>
        (d.destinationName || "").toLowerCase().includes(text)
      );

      if (!match) {
        return res.send(
          twiml("❌ No match. Try another country or type menu.")
        );
      }

      session.country = match.destinationName;
      session.destinationId = match.destinationID;
      session.step = "PLAN";

      const prodRes = await esimRequest(
        "get",
        `/products?destinationid=${match.destinationID}`
      );

      const products = Array.isArray(prodRes?.data)
        ? prodRes.data
        : Array.isArray(prodRes)
        ? prodRes
        : [];

      session.products = products;

      if (!products.length) {
        return res.send(
          twiml(
            `😕 No plans available for *${session.country}*.\nType *menu* to start over.`
          )
        );
      }

      let msg = `📡 Plans for *${session.country}*:\n\n`;
      products.slice(0, 5).forEach((p, i) => {
        msg += `${i + 1}) ${p.productName}\n💾 ${p.productDataAllowance}\n📅 ${
          p.validity
        } days\n💵 £${p.productPrice}\n\n`;
      });

      msg += "Reply with 1–5 to choose a plan.";
      return res.send(twiml(msg));
    }

    // PLAN SELECT
    if (session.step === "PLAN") {
      const index = parseInt(text, 10);

      if (
        Number.isNaN(index) ||
        index < 1 ||
        index > session.products.length
      ) {
        return res.send(twiml("❌ Invalid option. Try again."));
      }

      session.selectedProduct = session.products[index - 1];
      session.step = "QTY";

      return res.send(twiml("📦 How many eSIMs? (1–10)"));
    }

    // QUANTITY
    if (session.step === "QTY") {
      const qty = parseInt(text, 10);

      if (Number.isNaN(qty) || qty < 1 || qty > 10) {
        return res.send(twiml("❌ Enter a number 1–10."));
      }

      session.quantity = qty;
      session.step = "MOBILE";

      return res.send(
        twiml("📱 Enter your mobile number (e.g., +447900123456)")
      );
    }

    // MOBILE
    if (session.step === "MOBILE") {
      const num = req.body.Body.trim();

      if (!/^\+?\d{7,15}$/.test(num)) {
        return res.send(twiml("❌ Invalid number. Try again."));
      }

      session.mobile = num;
      session.step = "EMAIL";

      return res.send(twiml("📧 Enter your email address:"));
    }

    // EMAIL — FIRST ENTRY
    if (session.step === "EMAIL") {
      const email = req.body.Body.trim();

      if (!email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
        return res.send(twiml("❌ Invalid email. Please try again:"));
      }

      session.tempEmail = email;
      session.step = "EMAIL_CONFIRM";

      return res.send(
        twiml(
          "Just to make sure we send your eSIM correctly — please type your email again:"
        )
      );
    }

    // EMAIL — CONFIRMATION ENTRY
    if (session.step === "EMAIL_CONFIRM") {
      const confirm = req.body.Body.trim();

      if (confirm !== session.tempEmail) {
        return res.send(
          twiml("❌ Emails do not match.\n\nPlease enter your email again:")
        );
      }

      session.email = confirm;

      const p = session.selectedProduct;

      try {
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
              country: session.country,
              planName: p.productName,
              data: p.productDataAllowance,
              productSku: p.productSku || p.productSKU,
              productType: p.productType,
              destinationId: session.destinationId,
              flagEmoji: "🇬🇧",
              whatsappTo: `whatsapp:${from}`,
            },
          }
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

    // FALLBACK
    return res.send(twiml("😅 I got lost. Type menu to restart."));
  } catch (err) {
    console.error("❌ WhatsApp Webhook Error:", err);
    return res.send(twiml("⚠️ Something broke. Type menu to restart."));
  }
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 Backend running on port ${PORT}`));