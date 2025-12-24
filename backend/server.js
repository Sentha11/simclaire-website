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
      console.log("✅ Stripe payment completed:", sessionObj.id);
      console.log("   customer_email:", sessionObj.customer_details?.email || sessionObj.customer_email);
      // Stripe sends receipt automatically if enabled in Stripe settings
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

    // hi/hello handler
    if (["hi", "hello", "hey"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml("👋 Welcome to SimClaire!\n\n1) Browse plans\n2) Support\n\nReply 1 or 2.")
      );
    }

    // menu reset
    if (["menu", "main", "start"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml("👋 Welcome to SimClaire!\n\n1) Browse plans\n2) Support\n\nReply 1 or 2.")
      );
    }

    // MENU
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

    // COUNTRY -> fetch destinations -> match -> fetch products
    if (session.step === "COUNTRY") {
      console.log("🌍 Fetching destinations...");
      const destRes = await esimRequest("get", "/api/esim/destinations");
      const destinations = extractArray(destRes);

      if (!destinations.length) {
        console.log("🔴 No destinations array returned. Raw:", destRes);
        return res.send(
          twiml("❌ No destinations available right now. Type menu to restart.")
        );
      }

      console.log(`🌍 Destinations fetched: ${destinations.length}`);

      // Find match by name
      const match = destinations.find((d) => {
        const name =
          d.destinationName ||
          d.name ||
          d.countryName ||
          d.destination ||
          "";
        return String(name).toLowerCase().includes(text);
      });

      if (!match) {
        return res.send(
          twiml("❌ No match found. Try another country name (e.g., Italy, USA) or type menu.")
        );
      }

      const destinationName =
        match.destinationName || match.name || match.countryName || "Selected Destination";

      const destinationId =
        match.destinationID || match.destinationId || match.destinationid || match.id;

      if (!destinationId) {
        console.log("🔴 Destination matched but no destinationID field. Match:", match);
        return res.send(
          twiml("❌ Destination found but missing destination ID. Type menu and try again.")
        );
      }

      session.country = destinationName;
      session.destinationId = String(destinationId);
      session.step = "PLAN";

      console.log(`📡 Fetching products for destinationid=${destinationId} (${destinationName})`);
      const prodRes = await esimRequest(
        "get",
        `/api/esim/products?destinationid=${encodeURIComponent(destinationId)}`
      );

      const products = extractArray(prodRes);
      session.products = products;

      console.log(`📡 Products fetched: ${products.length}`);

      if (!products.length) {
        return res.send(
          twiml(`😕 No plans available for *${session.country}*.\nType *menu* to try another country.`)
        );
      }

      // Build message (top 8)
      const show = products.slice(0, 8);

      let msg = `📡 Plans for *${session.country}*:\n\n`;
      show.forEach((p, i) => {
        const name = p.productName || p.name || "Plan";
        const data = p.productDataAllowance || p.dataAllowance || p.data || "";
        const days = p.validity || p.validDays || "";
        const price = p.productPrice || p.price || "";
        msg += `${i + 1}) ${name}\n💾 ${data}\n📅 ${days} days\n💵 £${price}\n\n`;
      });

      msg += "Reply with the plan number to continue.";
      return res.send(twiml(msg));
    }

    // PLAN select -> generate payment link (Stripe)
    if (session.step === "PLAN") {
      const index = parseInt(textRaw, 10);

      if (Number.isNaN(index) || index < 1 || index > session.products.length) {
        return res.send(twiml("❌ Invalid plan number. Reply with the number shown, or type menu."));
      }

      const p = session.products[index - 1];
      const planName = p.productName || p.name || "SimClaire eSIM";
      const price = p.productPrice || p.price;
      const productSku = p.productSku || p.productSKU || p.sku || "";
      const productType = p.productType ?? p.type ?? "";
      const data = p.productDataAllowance || p.dataAllowance || "";
      const validity = p.validity || p.validDays || "";

      if (!price) {
        console.log("🔴 Selected product missing price:", p);
        return res.send(twiml("❌ This plan is missing a price. Please pick another plan or type menu."));
      }

      // We still need email to create checkout session (Stripe)
      session.selectedProduct = {
        planName,
        price,
        productSku,
        productType,
        data,
        validity,
      };
      session.step = "EMAIL";

      return res.send(twiml("📧 Enter your email address for the Stripe receipt:"));
    }

    // EMAIL -> create checkout link
    if (session.step === "EMAIL") {
      const email = textRaw.trim();

      if (!email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
        return res.send(twiml("❌ Invalid email. Please enter a valid email address:"));
      }

      const p = session.selectedProduct;
      if (!p) {
        resetSession(from);
        return res.send(twiml("⚠️ Session expired. Type menu to restart."));
      }

      // Create checkout session
      const response = await axios.post(
        `${BACKEND_BASE_URL}/api/payments/create-checkout-session`,
        {
          email,
          quantity: 1,
          price: p.price,
          currency: "gbp",
          planName: p.planName,
          productSku: p.productSku,
          productType: p.productType,
          data: p.data,
          validity: p.validity,
          country: session.country,
          destinationId: session.destinationId,
          metadata: {
            whatsappTo: `whatsapp:${from}`,
            flagEmoji: "", // you can populate later if you want
          },
        }
      );

      resetSession(from);

      return res.send(
        twiml(
          `💳 *Secure Payment Link*\n\nComplete your purchase here:\n${response.data.url}\n\n(Stripe receipt will be emailed automatically)`
        )
      );
    }

    // fallback
    return res.send(twiml("😅 I got lost. Type menu to restart."));
  } catch (err) {
    console.log("🔴 WhatsApp webhook error:", err.response?.data || err.message);
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