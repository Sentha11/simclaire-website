// =====================================================
// server.js – SimClaire Backend (FINAL CLEAN - OPTION C)
// WhatsApp (Twilio) + eSIM UAT (Destinations + Products) + Stripe (unchanged)
// NOTE: Stripe receipts are sent by Stripe automatically.
// NO SendGrid email / NO eSIM purchase in this version.
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const bodyParser = require("body-parser");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid enabled");
}

const app = express();

// =====================================================
// 1) QUOTAGUARD PROXY (eSIM API only)
// =====================================================
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using QuotaGuard STATIC HTTP proxy");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 Using QuotaGuard SOCKS5 proxy");
} else {
  console.log("🟡 No QuotaGuard proxy configured");
}

// =====================================================
// 2) CORE MIDDLEWARE (ORDER MATTERS)
// =====================================================

// Stripe webhook MUST see raw body (only on this route)
app.use("/webhook/stripe", bodyParser.raw({ type: "application/json" }));

app.use(cors());
// Twilio WhatsApp webhooks are x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
// Normal JSON APIs
app.use(express.json());

// =====================================================
// 3) CONFIG (DO NOT CHANGE ENV NAMES)
// =====================================================
const ESIM_BASE_URL = (process.env.ESIM_BASE_URL || "").replace(/\/+$/, ""); // your env: https://uat.esim-api.com
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

const APP_BASE_URL =
  process.env.APP_BASE_URL || "https://simclaire-website-backend.onrender.com";
const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL || "https://simclaire-website-backend.onrender.com";

const STRIPE_SUCCESS_URL =
  process.env.STRIPE_SUCCESS_URL || `${APP_BASE_URL}/success`;
const STRIPE_CANCEL_URL =
  process.env.STRIPE_CANCEL_URL || `${APP_BASE_URL}/cancel`;

// =====================================================
// 4) TWILIO INIT (API KEY/SECRET for GitGuardian friendliness)
// =====================================================
let twilioClient = null;

try {
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_API_KEY &&
    process.env.TWILIO_API_SECRET
  ) {
    // ✅ Preferred: API Key + Secret (no auth token committed)
    twilioClient = require("twilio")(
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { accountSid: process.env.TWILIO_ACCOUNT_SID }
    );
    console.log("📞 Twilio enabled (API KEY/SECRET)");
  } else if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    // Fallback (still works)
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    console.log("📞 Twilio enabled (AUTH TOKEN fallback)");
  } else {
    console.log("🟡 Twilio not configured (missing creds)");
  }
} catch (e) {
  console.log("🔴 Twilio init failed:", e.message);
}

// =====================================================
// 5) STRIPE INIT (KEEP AS-IS / WORKING)
// =====================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
} else {
  console.log("🟡 Stripe not configured");
}

// =====================================================
// 6) eSIM AUTH + REQUEST WRAPPER (UAT)
// Based on screenshots:
//   POST /api/esim/authenticate
//   GET  /api/esim/destinations
//   GET  /api/esim/products?destinationid=XXX
// =====================================================
let esimToken = null;
let esimExpiresAt = 0;

async function getEsimToken() {
  if (esimToken && Date.now() < esimExpiresAt) return esimToken;

  if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
    throw new Error("Missing ESIM_BASE_URL / ESIM_USERNAME / ESIM_PASSWORD");
  }

  const url = `${ESIM_BASE_URL}/api/esim/authenticate`;

  const res = await axios.post(
    url,
    { userName: ESIM_USERNAME, password: ESIM_PASSWORD },
    {
      httpsAgent: proxyAgent,
      proxy: false,
      timeout: 30000,
    }
  );

  // token naming can vary; handle common shapes
  const token = res.data?.token || res.data?.data?.token || res.data?.jwt || res.data?.accessToken;
  if (!token) {
    console.log("🔴 Auth response (no token):", res.data);
    throw new Error("eSIM auth succeeded but no token found in response");
  }

  // expiry might vary; fallback 10 minutes
  const expirySeconds =
    res.data?.expirySeconds || res.data?.data?.expirySeconds || 600;

  esimToken = token;
  esimExpiresAt = Date.now() + Number(expirySeconds) * 1000;

  console.log("🔐 eSIM token acquired ✅");
  return esimToken;
}

async function esimRequest(method, endpointPath, options = {}) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}${endpointPath}`;

  try {
    const result = await axios({
      method,
      url,
      httpsAgent: proxyAgent,
      proxy: false,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...options,
    });

    // If API returns HTML by mistake, catch it
    const contentType = (result.headers?.["content-type"] || "").toLowerCase();
    if (contentType.includes("text/html")) {
      console.log("🔴 eSIM returned HTML (wrong path/auth). First 200 chars:", String(result.data).slice(0, 200));
      throw new Error("eSIM API returned HTML instead of JSON (wrong endpoint/auth/base URL).");
    }

    return result.data;
  } catch (err) {
    console.log("🔴 eSIM request failed:", endpointPath);
    console.log("   status:", err.response?.status);
    console.log("   data:", err.response?.data || err.message);
    throw err;
  }
}

// Normalize arrays defensively
function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

// =====================================================
// 7) STRIPE CHECKOUT SESSION (KEEP WORKING)
// =====================================================
app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

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
      receipt_email: email,

      // ✅ Use env success/cancel (your simclaire.com pages)
      //success_url: STRIPE_SUCCESS_URL,
      //cancel_url: STRIPE_CANCEL_URL,
      success_url: `${APP_BASE_URL}/success`,
      cancel_url: `${APP_BASE_URL}/cancel`,

      line_items: [
        {
          quantity: Number(quantity || 1),
          price_data: {
            currency: currency || "gbp",
            unit_amount: Math.round(Number(price) * 100),
            product_data: { name: planName || "SimClaire eSIM" },
          },
        },
      ],

      // Keep metadata for later (when you add purchase + instructions)
      metadata: {
        planName: planName || "",
        productSku: productSku || "",
        productType: String(productType ?? ""),
        data: data || "",
        validity: String(validity ?? ""),
        quantity: String(quantity ?? ""),
        email: email || "",
        mobile: mobile || "",
        country: country || "",
        destinationId: String(destinationId ?? ""),
        whatsappTo: metadata?.whatsappTo || "",
        flagEmoji: metadata?.flagEmoji || "",
      },
    });

    console.log("✅ Stripe checkout created:", checkout.id);
    return res.json({ id: checkout.id, url: checkout.url });
  } catch (err) {
    console.log("🔴 Stripe checkout error:", err.message);
    return res.status(500).json({ error: "Stripe session failed" });
  }
});

// =====================================================
// 8) STRIPE WEBHOOK (kept, but NO eSIM purchase / NO email)
// =====================================================
if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
  app.post("/webhook/stripe", async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body, // raw Buffer (because of bodyParser.raw above)
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("🔴 Invalid Stripe Signature:", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "checkout.session.completed") {
      const sessionObj = event.data.object;

      const customerEmail = sessionObj.customer_details?.email || sessionObj.customer_email;

      console.log("✅ Stripe payment completed:", sessionObj.id);
      console.log("   customer_email:", sessionObj.customer_details?.email || sessionObj.customer_email);
      // Stripe sends receipt automatically if enabled in Stripe settings

    if (process.env.SENDGRID_API_KEY && customerEmail) {
      try {
      await sgMail.send({
        to: customerEmail,
        from: {
          email: process.env.SENDGRID_FROM_EMAIL,
          name: process.env.SENDGRID_FROM_NAME || "SimClaire",
        },
        subject: "Payment received – SimClaire",
        text: `Hi, We’ve received your payment successfully.
               Your order is being processed and you’ll receive your eSIM details shortly.
               Thank you for choosing SimClaire.`,});

        console.log("📧 SendGrid payment confirmation sent");
        } catch (err) {
        console.error(
        "❌ SendGrid email failed:",
        err.response?.body || err.message);
        }
      }
    }
    
    return res.json({ received: true });
  });
} else {
  console.log("🟡 Stripe webhook disabled (missing STRIPE_WEBHOOK_SECRET)");
}

// =====================================================
// 9) WHATSAPP XML HELPERS
// =====================================================
function escapeXml(unsafe) {
  return String(unsafe || "")
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
// 10) SIMPLE IN-MEMORY SESSION STORE
// =====================================================
const sessions = {};

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = { step: "MENU", products: [], country: "", destinationId: "" };
  }
  return sessions[id];
}

function resetSession(id) {
  sessions[id] = { step: "MENU", products: [], country: "", destinationId: "" };
}

// =====================================================
// 11) WHATSAPP WEBHOOK – DESTINATIONS + PRODUCTS (OPTION C)
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const fromRaw = req.body.WaId || req.body.From || "";
    const from = String(fromRaw).replace("whatsapp:", "") || "unknown";
    const textRaw = (req.body.Body || "").trim();
    const text = textRaw.toLowerCase();

    const session = getSession(from);

    // ================= INSTALL HANDLER =================
    if (text === "install") {
      const reply = `
📲 eSIM Installation

Your eSIM installation instructions will be sent shortly.

If you’ve already completed payment:
* Check your email for the QR code
* Follow the on-screen steps to install
* Restart your phone after installation

If you need help, reply SUPPORT.
      `.trim();

      return res.send(`
<Response>
  <Message>${reply}</Message>
</Response>
      `);
    }

    // ================= GREETING =================
    if (["hi", "hello", "hey"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml("👋 Welcome to SimClaire!\n\n1) Browse plans\n2) Support\n\nReply 1 or 2.")
      );
    }

    // ================= MENU RESET =================
    if (["menu", "main", "start"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml("👋 Welcome to SimClaire!\n\n1) Browse plans\n2) Support\n\nReply 1 or 2.")
      );
    }

    // ================= MENU =================
    if (session.step === "MENU") {
      if (text === "1") {
        session.step = "COUNTRY";
        return res.send(
          twiml("🌍 Enter your travel destination (country).\nExample: Italy, USA, Japan, United Kingdom.")
        );
      }

      if (text === "2") {
        return res.send(twiml("📞 Support: care@simclaire.com"));
      }

      return res.send(
        twiml("👋 Welcome to SimClaire!\n\n1) Browse plans\n2) Support\n\nReply 1 or 2.")
      );
    }

    // ================= COUNTRY → PLANS =================
    if (session.step === "COUNTRY") {
      const destRes = await esimRequest("get", "/api/esim/destinations");
      const destinations = extractArray(destRes);

      const match = destinations.find((d) =>
        String(d.destinationName || d.name || "")
          .toLowerCase()
          .includes(text)
      );

      if (!match) {
        return res.send(
          twiml("❌ No match found. Try another country or type menu.")
        );
      }

      session.country = match.destinationName || match.name;
      session.destinationId =
        match.destinationID || match.destinationId || match.id;
      session.step = "PLAN";

      const prodRes = await esimRequest(
        "get",
        `/api/esim/products?destinationid=${session.destinationId}`
      );

      const products = extractArray(prodRes);
      session.products = products;

      if (!products.length) {
        return res.send(
          twiml(`😕 No plans available for *${session.country}*.\nType *menu* to restart.`)
        );
      }

      let msg = `📡 Plans for *${session.country}*:\n\n`;
      products.slice(0, 8).forEach((p, i) => {
        msg += `${i + 1}) ${p.productName || "Plan"}\n💾 ${p.productDataAllowance}\n📅 ${p.validity} days\n💵 £${p.productPrice}\n\n`;
      });

      msg += "Reply with the plan number to continue.";
      return res.send(twiml(msg));
    }

    // ================= PLAN SELECT =================
    if (session.step === "PLAN") {
      const index = parseInt(textRaw, 10);
      if (!session.products[index - 1]) {
        return res.send(twiml("❌ Invalid selection. Reply with a plan number."));
      }

      session.selectedProduct = session.products[index - 1];
      session.step = "EMAIL";

      return res.send(twiml("📧 Enter your email address for the Stripe receipt:"));
    }

    // ================= EMAIL → STRIPE =================
    if (session.step === "EMAIL") {
      const email = textRaw;
      if (!email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
        return res.send(twiml("❌ Invalid email. Please try again."));
      }

      const p = session.selectedProduct;

      const response = await axios.post(
        `${BACKEND_BASE_URL}/api/payments/create-checkout-session`,
        {
          email,
          quantity: 1,
          price: p.productPrice,
          currency: "gbp",
          planName: p.productName,
          productSku: p.productSku,
          data: p.productDataAllowance,
          validity: p.validity,
          country: session.country,
          destinationId: session.destinationId,
          metadata: {
            whatsappTo: `whatsapp:${from}`,
          },
        }
      );

      resetSession(from);

      return res.send(
        twiml(`💳 *Secure Payment Link*\n\n${response.data.url}`)
      );
    }

    return res.send(twiml("😅 I got lost. Type menu to restart."));
  } catch (err) {
    console.log("🔴 WhatsApp webhook error:", err.message);
    return res.send(twiml("⚠️ Something broke. Type menu to restart."));
  }
});

// =====================================================
// 12) HEALTH + TEST ENDPOINTS
// =====================================================
app.get("/", (req, res) => res.send("SimClaire backend is running ✅"));
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    stripe: Boolean(stripe),
    twilio: Boolean(twilioClient),
    esimBase: ESIM_BASE_URL || null,
    usingProxy: Boolean(proxyAgent),
  })
);

// Quick test: does eSIM auth + destinations work?
app.get("/test-esim", async (req, res) => {
  try {
    const token = await getEsimToken();
    const destRes = await esimRequest("get", "/api/esim/destinations");
    const destinations = extractArray(destRes);

    return res.json({
      ok: true,
      token: token ? "YES" : "NO",
      destinationsCount: destinations.length,
      sample: destinations.slice(0, 5),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.response?.data || e.message,
    });
  }
});

app.get("/success", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Payment Successful</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body {
            font-family: Arial, sans-serif;
            background: #f6f9fc;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
          }
          .card {
            background: #ffffff;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            max-width: 420px;
            text-align: center;
          }
          h1 {
            color: #16a34a;
          }
          p {
            color: #555;
            margin-top: 10px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>✅ Payment Successful</h1>
          <p>Thank you for your purchase.</p>
          <p>A confirmation email has been sent.</p>
          <p>You may now close this window.</p>
        </div>
      </body>
    </html>
  `);
});

// =====================================================
// 13) START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 Backend running on port ${PORT} (SimClaire OPTION C)`);
  console.log(`➡️ APP_BASE_URL: ${APP_BASE_URL}`);
  console.log(`➡️ BACKEND_BASE_URL: ${BACKEND_BASE_URL}`);
  console.log(`➡️ STRIPE_SUCCESS_URL: ${STRIPE_SUCCESS_URL}`);
  console.log(`➡️ STRIPE_CANCEL_URL: ${STRIPE_CANCEL_URL}`);
});