// =====================================================
// server.js – SimClaire Backend (FINAL FIXED)
// Stripe + eSIM Life API (UAT/PROD) + WhatsApp + SendGrid + QuotaGuard Proxy
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

// =====================================================
// 0) IMPORTANT: Stripe webhook needs RAW body
// =====================================================
app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res, next) => next()
);

// Normal middleware for everything else
app.use(cors());
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded by default
app.use(express.json());

// =====================================================
// 1) PROXY SETUP (QuotaGuard)
// =====================================================
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using QuotaGuard STATIC proxy");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 Using QuotaGuard SOCKS5 proxy");
} else {
  console.log("🟡 QuotaGuard not enabled (no QUOTAGUARD_URL / QUOTAGUARD_SOCKS_URL)");
}

function axiosCfg(extra = {}) {
  return {
    httpsAgent: proxyAgent || undefined,
    proxy: false, // IMPORTANT when using custom agent
    timeout: 30000,
    ...extra,
  };
}

// =====================================================
// 2) ESIM API CONFIG (per https://esim-api.com/api/esim/apidocs/)
// =====================================================
const ESIM_BASE_URL = (process.env.ESIM_BASE_URL || "").replace(/\/$/, ""); // ex: https://uat.esim-api.com
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

let esimToken = null;
let esimExpiresAt = 0;

function pickToken(payload) {
  // Swagger UI varies; handle both direct + nested shapes
  return (
    payload?.token ||
    payload?.data?.token ||
    payload?.data?.jwt ||
    payload?.data?.accessToken ||
    payload?.data?.data?.token ||
    null
  );
}

async function getEsimToken() {
  if (esimToken && Date.now() < esimExpiresAt) return esimToken;

  if (!ESIM_BASE_URL) throw new Error("Missing ESIM_BASE_URL");
  if (!ESIM_USERNAME || !ESIM_PASSWORD) throw new Error("Missing ESIM_USERNAME/ESIM_PASSWORD");

  // ✅ Correct path (NO double /api/esim)
  const url = `${ESIM_BASE_URL}/api/esim/authenticate`;

  const resp = await axios.post(
    url,
    { userName: ESIM_USERNAME, password: ESIM_PASSWORD },
    axiosCfg()
  );

  const token = pickToken(resp.data);
  if (!token) {
    console.error("❌ Auth response (no token found):", resp.data);
    throw new Error("eSIM auth failed (token missing)");
  }

  esimToken = token;

  // Some APIs provide expiry; if not, just refresh every 9 minutes
  const expirySeconds =
    resp.data?.expirySeconds ||
    resp.data?.data?.expirySeconds ||
    resp.data?.data?.expiresIn ||
    540;

  esimExpiresAt = Date.now() + Number(expirySeconds) * 1000;
  console.log("🔐 New eSIM token issued");
  return esimToken;
}

function unwrapList(respData) {
  // Swagger shows { statuscode, status, statusmsg, data: [...] }
  if (Array.isArray(respData)) return respData;
  if (Array.isArray(respData?.data)) return respData.data;
  if (Array.isArray(respData?.data?.data)) return respData.data.data;
  return [];
}

async function esimGetDestinations() {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}/api/esim/destinations`;

  const resp = await axios.get(
    url,
    axiosCfg({
      headers: { Authorization: `Bearer ${token}` },
    })
  );

  return unwrapList(resp.data);
}

async function esimGetProductsByDestination(destinationId) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}/api/esim/products`;

  // Swagger says: 400 missing destination ID
  // Different backends use destinationID vs destinationId — try both.
  const tryParams = [
    { destinationID: Number(destinationId) },
    { destinationId: Number(destinationId) },
  ];

  let lastErr = null;

  for (const params of tryParams) {
    try {
      const resp = await axios.get(
        url,
        axiosCfg({
          headers: { Authorization: `Bearer ${token}` },
          params,
        })
      );
      return unwrapList(resp.data);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr;
}

async function purchaseEsimBySku({ sku, quantity = 1 }) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}/api/esim/purchaseesim`;

  // Body shape can vary; send the most compatible payload
  const payload = {
    productSku: sku,
    sku,
    quantity: Number(quantity),
  };

  const resp = await axios.post(
    url,
    payload,
    axiosCfg({
      headers: { Authorization: `Bearer ${token}` },
    })
  );

  return resp.data;
}

// =====================================================
// 3) TWILIO CLIENT (API KEY MODE - safer for GitGuardian)
// =====================================================
let twilioClient = null;
if (process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET && process.env.TWILIO_ACCOUNT_SID) {
  twilioClient = twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
  });
  console.log("📞 Twilio initialized using API Key mode");
} else {
  console.log("🟡 Twilio disabled (missing TWILIO_API_KEY/SECRET/ACCOUNT_SID)");
}

// =====================================================
// 4) STRIPE INIT
// =====================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
} else {
  console.log("🟡 Stripe disabled (missing STRIPE_SECRET_KEY)");
}

// =====================================================
// 5) SENDGRID INIT
// =====================================================
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid enabled");
} else {
  console.log("🟡 SendGrid disabled (missing SENDGRID_API_KEY)");
}

const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "care@simclaire.com";
const SENDGRID_FROM_NAME = "SimClaire";

// =====================================================
// 6) PDF + EMAIL
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

    doc.fontSize(14).text(`Destination: ${meta.country || "N/A"}`);
    doc.text(`Plan: ${meta.planName || "N/A"}`);
    doc.text(`Data: ${meta.data || "N/A"}`);
    doc.text(`Validity: ${meta.validity || "N/A"}`);
    doc.text(`Amount Paid: ${currency}${amount}`);
    doc.moveDown();

    // purchaseResult shape varies by provider
    const pr = purchaseResult || {};
    const tx =
      pr?.transactionId ||
      pr?.data?.transactionId ||
      pr?.data?.transactionID ||
      pr?.data?.orderId ||
      pr?.data?.orderID ||
      "N/A";
    doc.text(`Transaction ID: ${tx}`);

    const activation =
      pr?.activationCode ||
      pr?.data?.activationCode ||
      pr?.data?.qrCode ||
      pr?.data?.iccid ||
      null;

    if (activation) doc.text(`Activation/Info: ${activation}`);

    doc.end();
  });
}

async function sendEsimEmail({ to, meta, amount, currency, purchaseResult }) {
  if (!process.env.SENDGRID_API_KEY) return;

  const pdf = await generateEsimPdfBuffer({ meta, amount, currency, purchaseResult });

  const msg = {
    to,
    from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
    subject: `Your eSIM for ${meta.country || "your destination"}`,
    text: "Your eSIM & instructions are attached.",
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
// 7) STRIPE CHECKOUT SESSION (Website)
// =====================================================
app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

    const {
      email,
      quantity,
      price,
      planName,
      productSku,
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
          quantity: Number(quantity || 1),
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(Number(price) * 100),
            product_data: { name: planName },
          },
        },
      ],
      metadata: {
        planName,
        productSku,
        data,
        validity,
        quantity: String(quantity || 1),
        email,
        mobile,
        country,
        destinationId: String(destinationId || ""),
        whatsappTo: metadata?.whatsappTo,
        flagEmoji: metadata?.flagEmoji,
      },
    });

    res.json({ id: checkout.id, url: checkout.url });
  } catch (err) {
    console.error("❌ Stripe session error:", err?.response?.data || err);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// =====================================================
// 8) STRIPE WEBHOOK (Payment Completed -> Purchase eSIM + WhatsApp + Email)
// NOTE: This handler is attached via express.raw above.
// =====================================================
app._router.stack = app._router.stack; // no-op (keeps linter calm)

app.post("/webhook/stripe", async (req, res) => {
  try {
    if (!stripe) return res.status(500).send("Stripe not configured");

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

    if (event.type === "checkout.session.completed") {
      const sessionObj = event.data.object;
      const meta = sessionObj.metadata || {};
      const amount = (sessionObj.amount_total / 100).toFixed(2);

      // 1) Purchase eSIM by SKU (Unified API)
      let purchaseResult = null;
      try {
        purchaseResult = await purchaseEsimBySku({
          sku: meta.productSku,
          quantity: Number(meta.quantity || 1),
        });
      } catch (err) {
        console.error("❌ Purchase error:", err?.response?.data || err);
      }

      // 2) WhatsApp confirmation
      if (twilioClient && meta.whatsappTo) {
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: meta.whatsappTo,
          body: `🎉 Payment received!\n${meta.flagEmoji || ""} ${meta.country || ""}\n${
            meta.planName || ""
          }\nAmount: £${amount}`,
        });
      }

      // 3) Email PDF
      await sendEsimEmail({
        to: meta.email,
        meta,
        amount,
        currency: "£",
        purchaseResult,
      });
    }

    res.json({ received: true });
  } catch (e) {
    console.error("❌ Webhook handler crashed:", e);
    res.status(500).json({ error: "Webhook failed" });
  }
});

// =====================================================
// 9) WHATSAPP FLOW (Menu -> Destination -> Plans)
// =====================================================
const whatsappState = {}; // keyed by From (whatsapp:+number)

function twiml(message) {
  return `
    <Response>
      <Message>${message}</Message>
    </Response>
  `;
}

function cleanText(s) {
  return (s || "").toString().trim();
}

function normalizeCountry(s) {
  return cleanText(s).toLowerCase().replace(/\s+/g, " ");
}

function formatPlanRow(p, idx) {
  const name = p.productName || p.planName || "Plan";
  const sku = p.productSku || p.sku || "";
  const data = p.productDataAllowance || p.data || "";
  const validity = p.productValidity || p.validity || "";
  const price = p.productPrice ?? p.price ?? "";
  const curr = p.productCurrency || p.currency || "";
  return `${idx}) ${name}\n   Data: ${data} | Validity: ${validity}\n   Price: ${curr}${price}\n   SKU: ${sku}`;
}

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    res.set("Content-Type", "text/xml");

    const from = req.body.From; // "whatsapp:+1555..."
    const bodyRaw = cleanText(req.body.Body);
    const body = normalizeCountry(bodyRaw);

    if (!from) return res.send(twiml("Missing sender."));

    whatsappState[from] = whatsappState[from] || {
      step: "menu",
      destinationId: null,
      destinationName: null,
      plans: [],
    };

    const st = whatsappState[from];

    // HI / HELLO -> MENU
    if (["hi", "hello", "hey"].includes(body)) {
      st.step = "menu";
      st.destinationId = null;
      st.destinationName = null;
      st.plans = [];
      return res.send(
        twiml(`👋 Welcome to SimClaire!\nReply with:\n1) Browse Plans\n2) FAQ\n3) Support`)
      );
    }

    // MENU
    if (st.step === "menu") {
      if (body === "1" || body.includes("browse")) {
        st.step = "awaiting_destination";
        return res.send(twiml(`🌍 Please type your destination country\nExample: United Kingdom`));
      }

      if (body === "2" || body.includes("faq")) {
        return res.send(
          twiml(
            `FAQ:\n- eSIM works on supported phones\n- Install before travel\n- Data starts when activated\n\nReply "hi" for menu.`
          )
        );
      }

      if (body === "3" || body.includes("support")) {
        return res.send(twiml(`Support: Reply here or email care@simclaire.com\n\nReply "hi" for menu.`));
      }

      return res.send(twiml(`Reply "hi" to begin.`));
    }

    // DESTINATION INPUT -> FIND destinationID -> LOAD products
    if (st.step === "awaiting_destination") {
      const userCountry = body;

      let destinations = [];
      try {
        destinations = await esimGetDestinations();
      } catch (e) {
        console.error("❌ destinations error:", e?.response?.data || e);
        st.step = "menu";
        return res.send(twiml(`⚠️ Could not load destinations right now.\nReply "hi" to restart.`));
      }

      // Match by exact name, then partial includes
      const exact = destinations.find(
        (d) => normalizeCountry(d.destinationName) === userCountry
      );
      const partial = destinations.find((d) =>
        normalizeCountry(d.destinationName).includes(userCountry)
      );

      const match = exact || partial;

      if (!match) {
        return res.send(twiml(`❌ Destination not found.\nPlease try again (example: United Kingdom).`));
      }

      st.destinationId = match.destinationID;
      st.destinationName = match.destinationName;

      // Now fetch products (plans)
      let plans = [];
      try {
        plans = await esimGetProductsByDestination(st.destinationId);
      } catch (e) {
        console.error("❌ products error:", e?.response?.data || e);
        st.step = "menu";
        return res.send(twiml(`⚠️ Could not load plans for ${st.destinationName}.\nReply "hi" to restart.`));
      }

      if (!plans.length) {
        st.step = "menu";
        return res.send(twiml(`No plans found for ${st.destinationName}.\nReply "hi" to try again.`));
      }

      st.plans = plans.slice(0, 8); // keep message short
      st.step = "awaiting_plan";

      const lines = st.plans.map((p, i) => formatPlanRow(p, i + 1)).join("\n\n");
      return res.send(
        twiml(
          `📍 Destination saved: ${st.destinationName}\n\n📦 Available plans:\n\n${lines}\n\nReply with the plan number (1-${st.plans.length}).`
        )
      );
    }

    // PLAN SELECT
    if (st.step === "awaiting_plan") {
      const n = parseInt(bodyRaw, 10);
      if (!Number.isInteger(n) || n < 1 || n > st.plans.length) {
        return res.send(twiml(`Please reply with a number between 1 and ${st.plans.length}.`));
      }

      const plan = st.plans[n - 1];
      const name = plan.productName || "Selected plan";
      const sku = plan.productSku || plan.sku;

      st.step = "menu"; // reset back to menu after showing result

      return res.send(
        twiml(
          `✅ Selected: ${name}\nSKU: ${sku}\n\nNext step: complete checkout on the website (or reply "hi" to browse again).`
        )
      );
    }

    // Fallback
    st.step = "menu";
    return res.send(twiml(`Reply "hi" to begin.`));
  } catch (e) {
    console.error("❌ WhatsApp route crashed:", e);
    return res.send(twiml(`⚠️ Something went wrong. Please try again.\nReply "hi" to restart.`));
  }
});

// =====================================================
// 10) BASIC ROUTES
// =====================================================
app.get("/success", (req, res) => res.send("Payment Success ✔"));
app.get("/cancel", (req, res) => res.send("Payment Cancelled ❌"));
app.get("/health", (req, res) => res.json({ ok: true }));

// =====================================================
// 11) START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 SimClaire backend running on port ${PORT}`));