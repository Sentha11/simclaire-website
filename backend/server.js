// =====================================================
// server.js – SimClaire Backend (FINAL CLEAN - OPTION C)
// WhatsApp (Twilio) + eSIM UAT (Destinations + Products) + Stripe (unchanged)
// NOTE: Stripe receipts are sent by Stripe automatically.
// NO SendGrid email / NO eSIM purchase in this version.
// =====================================================

require("dotenv").config();

const ESIM_BASE_URL = process.env.ESIM_BASE_URL;

if (!ESIM_BASE_URL) {
  throw new Error("❌ ESIM_BASE_URL is missing");
}

const isUAT = ESIM_BASE_URL.includes("uat");

console.log("🌍 eSIM Environment:", isUAT ? "UAT" : "PRODUCTION");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const bodyParser = require("body-parser");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

// =====================================================
// PHASE 1 – FULFILLMENT STORAGE (JSON)
// =====================================================
const FULFILLMENTS_PATH = path.join(__dirname, "data", "fulfillments.json");

function saveFulfillment(entry) {
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(FULFILLMENTS_PATH, "utf8"));
  } catch {}

  existing.push(entry);

  fs.writeFileSync(
    FULFILLMENTS_PATH,
    JSON.stringify(existing, null, 2)
  );
}
// =====================================================
const WHATSAPP_FROM = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;

const USERNAME = process.env.ESIM_USERNAME;
const PASSWORD = process.env.ESIM_PASSWORD;

if (!USERNAME || !PASSWORD) {
  throw new Error("❌ eSIM USERNAME or PASSWORD is missing");
}

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid enabled");
}

const app = express();
app.set("trust proxy", true);

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


app.use(cors());
// Twilio WhatsApp webhooks are x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
//app.use(express.json());
// =====================================================
// CSV PRICING (PROD FINAL PRICES)
// =====================================================
const pricingMap = new Map();

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
//app.use("/webhook/stripe", bodyParser.raw({ type: "application/json" }));
// Normal JSON APIs

// =====================================================
// STATIC WEBSITE (NO VITE / NO REACT)
// =====================================================
app.use(express.static(path.join(__dirname, "frontend-static")));

// =====================================================
// 3) CONFIG (DO NOT CHANGE ENV NAMES)
// =====================================================
//const ESIM_BASE_URL = (process.env.ESIM_BASE_URL || "").replace(/\/+$/, ""); // your env: https://uat.esim-api.com
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
// STRIPE WEBHOOK – FULL eSIM FULFILLMENT
// =====================================================
if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
  app.post(
    "/api/webhook/stripe",
    express.raw({ type: "application/json" }),
    async (req, res) => {
    const sig = req.headers['stripe-signature'];
      let event;
  try {
      event = stripe.webhooks.constructEvent(
        req.body, // <-- RAW BUFFER (this is the fix)
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
         console.error('❌ Stripe signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

      // -------------------------------------------------
      // PAYMENT COMPLETED
      // -------------------------------------------------
      if (event.type === "checkout.session.completed") {
        console.log("🚀 Stripe webhook reached checkout.session.completed");
        const session = event.data.object;

        console.log("✅ Stripe payment completed:", session.id);

        const customerEmail = session.customer_details?.email;
        const metadata = session.metadata || {};
       // const whatsappTo =
      // metadata.whatsappTo ||
       // (metadata.mobileno ? `whatsapp:+${metadata.mobileno}` : null);

        console.log("🧾 Metadata received:", metadata);

         // ===============================
          // SAFE / BULLETPROOF MOBILE FIX
          // ===============================
          // ✅ MOBILE NUMBER (DO NOT NORMALIZE)
          const mobileno = String(metadata.mobileno || "").trim();

          if (!mobileno) {
            console.error("❌ Missing mobileno - cannot proceed with eSIM purchase");
            throw new Error("mobileno is required for eSIM purchase");
          }

          console.log("📞 Using mobileno (exact):", mobileno);

        try {
          // =============================================
          // ✅ FIX #2: PURCHASE eSIM - send items array with sku/quantity/destinationId
          // =============================================
          console.log("📡 Purchasing eSIM...");

          if (!metadata.productType) {
            console.error("❌ Missing productType", {
              sku: metadata.productSku,
              metadata,
            });
            throw new Error("Missing productType for eSIM purchase");
          }

          const payload = {
            items: [
              {
                type: metadata.productType,
                sku: metadata.productSku,
                quantity: Number(metadata.quantity || 1),
                mobileno: mobileno,
                emailid: metadata.email,
              },
            ],
          };
         
          console.log("🧪 eSIM TYPE CHECK", {
              sku: metadata.productSku,
              productType: metadata.productType,
            });
          console.log("📤 purchaseesim payload:", payload);

          const esimRes = await esimRequest("post", "/api/esim/purchaseesim", {
            data: payload,
          });

          console.log("✅ eSIM queued:", esimRes);

          // Keep your original pattern (in case API nests data)
          //const esim = esimRes?.data || esimRes || {};
          const transactionId = esimRes.uniqueRefno;
          const activationCode = esimRes.esims?.[0]?.activationcode;

          console.log("✅ eSIM purchased");
          console.log("📄 Transaction ID:", transactionId);
          console.log("🔑 Activation Code:", activationCode);

          // =====================================================
          // PHASE 1 – SAVE FULFILLMENT RECORD
          // =====================================================
          saveFulfillment({
            email: metadata.email,
            sessionId: session.id,
            sku: metadata.productSku,
            planName: metadata.planName,
            country: metadata.country,
            activationCode,
            transactionId,
            createdAt: new Date().toISOString()
          });

          //if (!metadata?.acceptedTerms) {
           // return res.status(400).json({
            //  error: "Terms and Conditions must be accepted",
            //});
         // }
          // ===============================
          // FIX 4️⃣ – POST-PURCHASE THANK YOU WHATSAPP
          // ===============================

         // ✅ Build WhatsApp destination safely
          let whatsappToFinal = null;

          if (metadata.whatsappTo && metadata.whatsappTo.trim()) {
            whatsappToFinal = metadata.whatsappTo.trim();
          } else if (mobileno) {
            whatsappToFinal = `whatsapp:+${mobileno}`;
          }

          console.log("📱 Final WhatsApp To:", whatsappToFinal);

          const thankYouMessage =
            "✅ Thank you for your purchase!\n\n" +
            "📧 Your eSIM setup instructions have been sent to your email.\n\n" +
            "📱 Need help? Reply support anytime.\n\n" +
            "✈️ Safe travels!\n— SimClaire";

          if (
            twilioClient &&
            WHATSAPP_FROM &&
            whatsappToFinal &&
            whatsappToFinal.startsWith("whatsapp:")
          ) {
            console.log("📤 WhatsApp send attempt", {
            from: WHATSAPP_FROM,
            to: whatsappToFinal,
            });

            await twilioClient.messages.create({
              from: WHATSAPP_FROM,   // ✅ FIXED
              to: whatsappToFinal,
              body: thankYouMessage,
            });
          } else {
            console.log("📵 WhatsApp skipped", {
              from: WHATSAPP_FROM,
              to: whatsappToFinal,
            });
          }
          console.log("✅ Order completed end-to-end", {
          transactionId,
          activationCode,
          email: metadata.email,
          whatsappTo: whatsappToFinal,
        });
        
        } catch (err) {
          console.error("❌ Fulfillment error:", err.response?.data || err.message);
        }
      }

      res.json({ received: true });
    }
  );
}

app.post("/api/checkout", async (req, res) => {
  const { sku } = req.body;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price: process.env[`STRIPE_${sku.toUpperCase()}`],
      quantity: 1
    }],
    success_url: `${FRONTEND_URL}/success`,
    cancel_url: `${FRONTEND_URL}/cancel`
  });

  res.json({ url: session.url });
});

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

  console.log("🔌 ESIM BASE URL:", ESIM_BASE_URL);
  console.log("🔐 ESIM MODE:", isUAT ? "UAT" : "PROD");
  console.log("👤 ESIM USER PREFIX:", USERNAME?.slice(0, 4));

  const res = await axios.post(
    url,
    { userName: USERNAME, password: PASSWORD },
    {
      httpsAgent: proxyAgent,
      proxy: false,
      timeout: 30000,
    }
  );

  // token naming can vary; handle common shapes
  const token =
    res.data?.token ||
    res.data?.data?.token ||
    res.data?.jwt ||
    res.data?.accessToken;

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
      console.log(
        "🔴 eSIM returned HTML (wrong path/auth). First 200 chars:",
        String(result.data).slice(0, 200)
      );
      throw new Error(
        "eSIM API returned HTML instead of JSON (wrong endpoint/auth/base URL)."
      );
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
// Resolve productType server-side (DO NOT TRUST FRONTEND)
// =====================================================
async function resolveProductType(destinationId, productSku) {
  if (!destinationId || !productSku) return "";

  try {
    const prodRes = await esimRequest(
      "get",
      `/api/esim/products?destinationid=${encodeURIComponent(destinationId)}`
    );

    const products = extractArray(prodRes);

    const match = products.find(
      p => String(p.productSku || "").trim() === String(productSku || "").trim()
    );

    return match?.productType != null
      ? String(match.productType).trim()
      : "";
  } catch (err) {
    console.error("❌ resolveProductType failed", err.message);
    return "";
  }
}

// =====================================================
// WEB: Browse eSIM products (same logic as WhatsApp)
// =====================================================
app.get("/api/web/esim/products", async (req, res) => {
  try {
    const { country } = req.query;

    if (!country) {
      return res.status(400).json({ error: "country is required" });
    }

    // 1️⃣ Get destinations
    const destRes = await esimRequest("get", "/api/esim/destinations");
    const destinations = extractArray(destRes);

    const match = destinations.find(d =>
      String(d.destinationName || d.name || "")
        .toLowerCase()
        .includes(country.toLowerCase())
    );

    if (!match) {
      return res.json([]);
    }

    const destinationId =
      match.destinationID || match.destinationId || match.id;

    // 2️⃣ Get products
    const prodRes = await esimRequest(
      "get",
      `/api/esim/products?destinationid=${destinationId}`
    );

    const products = extractArray(prodRes);

    // 3️⃣ Filter + map using CSV (same as WhatsApp)
    const results = products
      .filter(p => p.productSku && pricingMap.has(p.productSku))
      .map(p => {
        const csv = pricingMap.get(p.productSku);

        return {
          name: p.productName,
          sku: p.productSku,
          productType: String(
            p.productType ?? ""),
          data: p.productDataAllowance,
          validity: csv.validity || p.validity,
          price: csv.finalPrice,
          country: match.destinationName || match.name,
          destinationId
        };
      });

      console.log("🧪 SAMPLE PRODUCT", products[0]);

    res.json(results);
  } catch (err) {
    console.error("❌ WEB PRODUCT ERROR:", err.message);
    res.status(500).json({ error: "Failed to load products" });
  }
});



// =====================================================
// LOAD PRICING CSV ON STARTUP
// =====================================================
async function loadPricingCSV() {
  return new Promise((resolve, reject) => {
    const csvPath = path.join(__dirname, "data", "pricing_prod.csv");

    console.log("📄 Loading pricing CSV:", csvPath);

    fs.createReadStream(csvPath)
      .pipe(csv())
      .on("data", (row) => {
        const sku = String(row["Product SKU"] || "").trim();
        const price = Number(row["finalPrice"]);

        if (!sku || isNaN(price)) return;

        pricingMap.set(sku, {
        finalPrice: Number(row["finalPrice"]),
        baseCost: Number(row["BaseCost"]),
        currency: row["currency"] || "GBP",
        destinationId: row["Destination ID"] || "",
        country: row["Country"] || "",
        validity: row["Validity Days"] || "",
        data: row["Data Allowanance"] || "",
        status: row["status"] || "active",
      });
      })
      .on("end", () => {
        console.log(`💰 Pricing loaded: ${pricingMap.size} SKUs`);
        resolve();
      })
      .on("error", reject);
  });
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
      //whatsappTo,
      metadata,
    } = req.body;
    
    // =====================================================
    // ✅ Resolve productType BEFORE Stripe session
    // =====================================================
    let finalProductType = productType ? String(productType).trim() : "";

    if (!finalProductType) {
      finalProductType = await resolveProductType(destinationId, productSku);

      console.log("🧠 productType resolved server-side", {
        productSku,
        destinationId,
        finalProductType,
      });
    }

    // Hard stop ONLY if resolution truly fails
    if (!finalProductType) {
      console.error("❌ productType could not be resolved", {
        productSku,
        destinationId,
      });
      return res.status(400).json({
        error: "Unable to determine product type",
      });
    }


          // 🔒 HARD BLOCK IF MOBILE IS MISSING
      if (!mobile) {
        console.error("❌ Missing mobile in create-checkout-session");
        return res.status(400).json({
          error: "Destination mobile number is required",
        });
      }

      console.log("📞 Checkout mobile received:", mobile);

      // ===============================
// 💰 FINAL PRICE ENFORCEMENT (CSV)
// ===============================
const rawPrice = price; // ← this IS finalPrice from CSV

const numericPrice = Number(
  String(rawPrice).replace(/[^\d.]/g, "")
);

if (isNaN(numericPrice) || numericPrice <= 0) {
  console.error("❌ Invalid finalPrice:", rawPrice);
  return res.status(400).json({
    error: "Pricing not available for this plan",
  });
}

const unitAmount = Math.round(numericPrice * 100);

console.log("💷 Stripe unitAmount (pence):", unitAmount);
console.log("💷 Stripe unitAmount:", unitAmount);

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,

      success_url: `${APP_BASE_URL}/success`,
      cancel_url: `${APP_BASE_URL}/cancel`,

      line_items: [
        {
          quantity: Number(quantity || 1),
          price_data: {
            currency: currency || "gbp",
            unit_amount: unitAmount,
            product_data: { name: planName || "SimClaire eSIM" },
          },
        },
      ],

      // =================================================
      // ✅ FIX #1: Store the correct destinationId key/value
      // =================================================
      metadata: {
        planName: planName || "",
        productSku: productSku || "",
        productType: finalProductType,
        data: data || "",
        validity: String(validity ?? ""),
        quantity: String(quantity ?? ""),
        email: email || "",
        mobileno: mobile || "",
        country: country || "",
        destinationId: String(destinationId ?? ""), // ✅ FIX #1
        //whatsappTo: whatsappTo || "",
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

function renderPlans(session) {
  const PAGE_SIZE = 5;
  const start = session.page * PAGE_SIZE;
  const end = start + PAGE_SIZE;

  let msg = `📡 *Plans for ${session.country}*\n\n`;

  session.products.slice(start, end).forEach((p, i) => {
    const csvEntry = pricingMap.get(p.productSku);

    // 🔐 OPTIONAL SKU + PRICE SAFETY CHECK (SAFE IN PROD)
    if (!csvEntry) {
      console.warn("⚠️ CSV MISSING FOR SKU", {
        sku: p.productSku,
        productName: p.productName,
        page: session.page,
        index: start + i,
      });
    }

    // ✅ WhatsApp should show FINAL (customer) price
    const displayPrice =
        csvEntry?.finalPrice != null
        ? Number(csvEntry.finalPrice)
        : (p.productPrice ?? "N/A");
    
    console.log("💰 PRICE DEBUG", {
      sku: p.productSku,
      finalPrice: csvEntry?.finalPrice,
      parsed: Number(csvEntry?.finalPrice),
      displayPrice,
    });

    const displayValidity =
      csvEntry?.validityDays ?? csvEntry?.validity ?? p.validity ?? "See plan details";

    msg +=
      `*${start + i + 1}) ${p.productName}*\n` +
      `💾 Data: ${p.productDataAllowance}\n` +
      `📅 Validity: ${displayValidity} days\n` +
      `💷 Price: £${displayPrice}\n\n`;
  });

  if (end < session.products.length) {
    msg += `➡️ Type *more* to see more plans\n\n`;
  }

  msg +=
    `Reply with the plan number to continue.\n\n` +
    "ℹ️ Introductory pricing • Final prices confirmed at checkout\n" +
    "🔁 Type menu to restart\n" +
    "❌ Type exit to cancel";

  return msg;
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

    if (!session.step) { session.step = "MENU";}
    // 🔢 Pagination (safe default)
    session.page = session.page ?? 0;

    const PAGE_SIZE = 5;
    const start = session.page * PAGE_SIZE;
    const end = start + PAGE_SIZE;

    if (["hi", "hello", "hey"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml(
        "👋 Welcome to SimClaire!\n\n" +
        "🛍️ Shop Holiday eSIM\n\n"+
        "1) Browse plans\n" +
        "2) Support\n" +
        "3) FAQ\n\n" +
        "Reply with 1, 2, or 3."
      )
      );
    }

    if (["menu", "main", "start"].includes(text)) {
      resetSession(from);
      return res.send(
              twiml(
        "👋 Welcome to SimClaire!\n\n" +
        "🛍️ Shop Holiday eSIM\n\n"+
        "1) Browse plans\n" +
        "2) Support\n" +
        "3) FAQ\n\n" +
        "Reply with 1, 2, or 3."
      )
      );
    }

    if (["exit", "cancel", "stop"].includes(text)) {
    resetSession(from);
    return res.send(
      twiml("✅ Session cancelled.\nType menu to start again.")
    );
    }

    if (session.step === "MENU") {
      if (text === "1") {
        session.step = "COUNTRY";
        return res.send(
          twiml("🌍 Enter your travel destination.")
        );
      }

      if (text === "2") {
        return res.send(
            twiml(
              "🆘 Customer Support\n\n" +
              "📧 Email: care@simclaire.com\n" +
              "💬 WhatsApp: wa.me/+14376056560\n\n" +
              "Type menu to return."
            )
          );
      }

      if (text === "3") {
      return res.send(
        twiml(
          "❓ Frequently Asked Questions\n\n" +
          "📶 When does my eSIM activate?\n" +
          "→ On arrival or when enabled.\n\n" +
          "📱 Is my phone compatible?\n" +
          "→ Your device must support eSIM.\n\n" +
          "🔄 Can I top up or change plans?\n" +
          "→ Not currently. Purchase a new plan.\n\n" +
          "🆘 Need help?\n" +
          "→ Type 2 for support\n\n" +
          "🔁 Type menu to return."
        )
      );
    }

      return res.send(
        twiml(
  "👋 Welcome to SimClaire!\n\n" +
  "🛍️ Shop Holiday eSIM\n\n"+
  "1️⃣ Browse plans\n" +
  "2️⃣ Support\n" +
  "3️⃣ FAQ\n\n" +
  "Reply 1, 2, or 3."
)
      );
    }

    if (session.step === "COUNTRY") {
      // 👉 Handle "see more plans"
    //if (text === "more") { session.page += 1; }

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
      session.page = 0; // reset pagination for new destination
      session.step = "PLAN";

      const prodRes = await esimRequest(
        "get",
        `/api/esim/products?destinationid=${session.destinationId}`
      );

      const products = extractArray(prodRes);

      // ✅ ADD THIS FILTER
      const destinationProducts = products.filter(p =>
        p.productSku &&
        pricingMap.has(p.productSku)
      );

      session.products = destinationProducts;

      // 🔐 OPTIONAL SAFETY LOG (SAFE TO KEEP IN PROD)
      console.log("📦 DESTINATION PRODUCT CHECK", {
        country: session.country,
        destinationId: session.destinationId,
        productCount: destinationProducts.length,
        skus: destinationProducts.map(p => p.productSku),
      });

      if (!products.length) {
        return res.send(
          twiml(`😕 No plans available for *${session.country}*.\nType *menu* to restart.`)
        );
      }

      if (text === "faq") {
        return res.send(
          twiml(
            "❓ Frequently Asked Questions\n\n" +
            "📶 eSIM activates on arrival or when enabled.\n" +
            "📱 Device must support eSIM.\n" +
            "🆘 Type support for help.\n\n" +
            "Type menu to return."
          )
        );
      }

      if (text === "support" || text === "help") {
        return res.send(
          twiml(
            "👩‍💻 Connecting you to customer care\n\n" +
            "👉 wa.me/14379259578\n\n" +
            "Our team will assist you shortly.\n\n" +
            "Type menu to return."
          )
        );
      }
     
//return res.send(twiml(msg));
session.page = 0;
session.step = "PLAN";
return res.send(twiml(renderPlans(session)));
    }

    if (session.step === "PLAN") {

      if (text === "more" || text === "next") {
        session.page += 1;

        // ⛔ ADD GUARD HERE ⬅️
        const PAGE_SIZE = 5;
        const maxPage = Math.ceil(session.products.length / PAGE_SIZE) - 1;

        if (session.page > maxPage) {
          session.page = maxPage;
          return res.send(
            twiml(
              "⚠️ No more plans available.\n\n" +
              "Reply with a plan number or type menu."
            )
          );
        }

        console.log("📄 PAGINATION NEXT", {
          page: session.page,
          totalProducts: session.products.length,
        });

        return res.send(twiml(renderPlans(session)));
      }

      const selectedId =
      req.body.ButtonPayload ||          // (Twilio uses this for interactive replies)
      req.body.ListResponse?.id ||        // if present
      req.body.ListResponse?.Id ||        // if present
      textRaw;

      if (text === "more" || text === "next") {
        // pagination already handled above
        return;
      }

      const inputNumber = parseInt(selectedId, 10);

if (!Number.isFinite(inputNumber) || inputNumber < 1) {
  return res.send(twiml("❌ Invalid selection. Reply with a plan number."));
}

// Because renderPlans uses start+i+1, numbering is GLOBAL
const realIndex = inputNumber - 1;

console.log("✅ SELECTION RESOLVE", {
  inputNumber,
  realIndex,
  sku: session.products?.[realIndex]?.productSku,
});

if (!session.products?.[realIndex]) {
  return res.send(twiml("❌ Invalid selection. Reply with a plan number shown."));
}

// 🔍 ADD THIS LINE
console.log("🧪 SELECTED PRODUCT RAW", session.products[realIndex]);

session.selectedProduct = session.products[realIndex];
session.step = "EMAIL";

return res.send(twiml("📧 Enter your email address for the Stripe receipt:"));
      
    }

    if (session.step === "EMAIL") {
      const email = textRaw.trim().toLowerCase();

      if (!email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
        return res.send(twiml("❌ Invalid email format.\nPlease enter a valid email address."));
      }

      session.emailDraft = email;
      session.step = "EMAIL_CONFIRM";

      return res.send(
        twiml(
          "🔁 Please re-enter your email to confirm:\n\n" +
          "📧 " + email
        )
      );
    }

    if (session.step === "EMAIL_CONFIRM") {
  const confirmEmail = textRaw.trim().toLowerCase();

  if (confirmEmail !== session.emailDraft) {
    session.emailDraft = "";
    session.step = "EMAIL";

    return res.send(
      twiml(
        "❌ Emails do not match.\n\n" +
        "Please enter your email again carefully:"
      )
    );
  }

    // ✅ Emails match — safe to proceed
    const email = confirmEmail;

    const p = session.selectedProduct;
    const csvEntry = pricingMap.get(p.productSku);

    if (!csvEntry?.finalPrice) {
  console.warn("⚠️ MISSING FINAL PRICE", {
    sku: p.productSku,
    csvEntry,
  });

  return res.send(
    twiml(
      "⚠️ This plan is temporarily unavailable.\n" +
      "Please select another plan or type menu."
    )
  );
}

    const finalPrice = csvEntry.finalPrice;

    const response = await axios.post(
      `${BACKEND_BASE_URL}/api/payments/create-checkout-session`,
      {
        email,
        quantity: 1,
        price: finalPrice,
        currency: "gbp",
        planName: p.productName,
        productSku: p.productSku,
        productType: p.productType,
        data: p.productDataAllowance,
        validity: p.validity,
        country: session.country,
        destinationId: session.destinationId,
        mobile: from,
      }
    );

    resetSession(from);

    return res.send(
      twiml(
        "💳 Secure Payment Link\n\n" +
        response.data.url
      )
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

app.get("/api/account/purchases", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    let records = [];
    try {
      records = JSON.parse(
        fs.readFileSync(FULFILLMENTS_PATH, "utf8")
      );
    } catch {}

    const purchases = records.filter(
      r => r.email.toLowerCase() === email.toLowerCase()
    );

    res.json({
      email,
      totalPurchases: purchases.length,
      purchases
    });

  } catch (err) {
    console.error("Account lookup error:", err);
    res.status(500).json({ error: "Failed to fetch account data" });
  }
});


// =====================================================
// WEBSITE ROUTE FALLBACK (SPA SUPPORT)
// =====================================================
app.get("*", (req, res) => {
  // Allow API & webhook routes to behave normally
  if (
    req.path.startsWith("/api") ||
    req.path.startsWith("/webhook")
  ) {
    return res.status(404).json({ error: "Not found" });
  }

  res.sendFile(path.join(__dirname, "frontend-static", "index.html"));
});


// =====================================================
// 13) START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;

loadPricingCSV().then(() => {
  app.listen(PORT, () => {
    console.log(`🔥 Backend running on port ${PORT} (SimClaire OPTION C)`);
    console.log(`➡️ APP_BASE_URL: ${APP_BASE_URL}`);
    console.log(`➡️ BACKEND_BASE_URL: ${BACKEND_BASE_URL}`);
    console.log(`➡️ STRIPE_SUCCESS_URL: ${STRIPE_SUCCESS_URL}`);
    console.log(`➡️ STRIPE_CANCEL_URL: ${STRIPE_CANCEL_URL}`);
  });
});