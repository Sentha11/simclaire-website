// =====================================================
// server.js – SimClaire Backend (ESIM + WhatsApp + Stripe + Simple Admin)
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

// -----------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------
app.use(cors());
app.use(express.urlencoded({ extended: false })); // For Twilio form POST
app.use(express.json());

// -----------------------------------------------------
// QUOTAGUARD STATIC PROXY
// -----------------------------------------------------
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled!");
} else {
  console.warn("⚠️ QUOTAGUARD_URL missing — proxy OFF");
}

// -----------------------------------------------------
// ESIM ENV VARS
// -----------------------------------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL; // e.g. https://uat.esim-api.com/api/esim
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  console.warn("⚠️ Missing eSIM environment variables.");
}

// -----------------------------------------------------
// STRIPE SETUP (Test or Live Mode)
// -----------------------------------------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled (test or live based on key)");
} else {
  console.warn("⚠️ STRIPE_SECRET_KEY not set — Stripe checkout disabled");
}

// -----------------------------------------------------
// SIMPLE ORDER LOG (in-memory)
// -----------------------------------------------------
const orders = [];

function recordOrder(partial) {
  orders.push({
    id:
      Date.now().toString() +
      "-" +
      Math.random().toString(36).substring(2, 8),
    createdAt: new Date().toISOString(),
    ...partial,
  });
}

// -----------------------------------------------------
// SIMPLE ADMIN AUTH (header x-api-key)
// -----------------------------------------------------
function getRoleFromRequest(req) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (!key) return null;

  if (process.env.ADMIN_API_KEY && key === process.env.ADMIN_API_KEY) {
    return "admin";
  }
  if (process.env.SUPPORT_API_KEY && key === process.env.SUPPORT_API_KEY) {
    return "support";
  }
  return null;
}

// -----------------------------------------------------
// TOKEN CACHE (ESIM)
// -----------------------------------------------------
let esimToken = null;
let esimTokenExpiresAt = 0;

async function getEsimToken() {
  const now = Date.now();
  if (esimToken && now < esimTokenExpiresAt) return esimToken;

  const url = `${ESIM_BASE_URL}/authenticate`;
  console.log("🚀 [AUTH] Requesting:", url);

  const res = await axios.post(
    url,
    {
      userName: ESIM_USERNAME,
      password: ESIM_PASSWORD,
    },
    {
      httpsAgent: proxyAgent || undefined,
      proxy: false,
    }
  );

  esimToken = res.data.token;
  const ttlSeconds = res.data.expirySeconds || 600;
  esimTokenExpiresAt = now + ttlSeconds * 1000;

  console.log("🔐 eSIM token refreshed");
  return esimToken;
}

// -----------------------------------------------------
// GENERIC ESIM REQUEST WRAPPER
// -----------------------------------------------------
async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}${path}`;

  console.log("➡️ [ESIM]", method.toUpperCase(), url);

  try {
    const res = await axios({
      method,
      url,
      httpsAgent: proxyAgent || undefined,
      proxy: false,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.warn("🔁 Token expired, retrying…");
      esimToken = null;
      const newToken = await getEsimToken();

      const res2 = await axios({
        method,
        url,
        httpsAgent: proxyAgent || undefined,
        proxy: false,
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });

      return res2.data;
    }

    console.error("❌ esimRequest error:", err.message);
    if (err.response?.data) {
      console.error("❌ API response:", err.response.data);
    }
    throw err;
  }
}

// -----------------------------------------------------
// FLAG EMOJI HELPERS
// -----------------------------------------------------
function flagEmojiFromIso(iso) {
  if (!iso) return "";
  const code = iso.toUpperCase();
  return code.replace(/./g, (c) =>
    String.fromCodePoint(127397 + c.charCodeAt(0))
  );
}

const flagOverride = {
  USA: "🇺🇸",
  UK: "🇬🇧",
  UAE: "🇦🇪",
  "UNITED STATES": "🇺🇸",
  "UNITED STATES OF AMERICA": "🇺🇸",
  "UNITED KINGDOM": "🇬🇧",
};

function getFlag(dest) {
  const name = (dest.destinationName || "").toUpperCase();
  const iso = (dest.isoCode || "").toUpperCase();
  return flagOverride[name] || flagOverride[iso] || flagEmojiFromIso(iso);
}

// -----------------------------------------------------
// TwiML helper
// -----------------------------------------------------
function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${message}</Message>
</Response>`;
}

// -----------------------------------------------------
// SESSION SYSTEM (in-memory)
// -----------------------------------------------------
const sessions = {};

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = {
      step: "MENU",
      country: null,
      destinationId: null,
      products: [],
      selectedProduct: null,
      quantity: 1,
      mobile: null,
      email: null,
    };
  }
  return sessions[id];
}

function resetSession(id) {
  delete sessions[id];
}

function clean(t) {
  return (t || "").trim();
}

// -----------------------------------------------------
// UTIL: Format plans list for WhatsApp
// -----------------------------------------------------
function formatPlans(country, flag, products) {
  if (!products || !products.length) {
    return `${flag ? flag + " " : ""}No instant eSIMs available for *${country}*. Try another country or type *menu*.;
  `}

  let out = `${flag ? flag + " " : ""}Here are top plans for *${country}*:\n\n`;

  products.slice(0, 5).forEach((p, idx) => {
    out += `*${idx + 1}) ${p.productName}*\n`;
    out += `   💾 ${p.productDataAllowance || p.productData}\n`;
    out += `   📅 ${p.productValidity} days\n`;
    out += `   💵 £${p.productPrice}\n\n`;
  });

  out += `Reply with *1–${products.length}* to choose a plan.\nType *menu* to restart.`;
  return out;
}

// -----------------------------------------------------
// BASIC API ROUTES
// -----------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({ status: "OK", backend: "running" });
});

app.get("/api/esim/destinations", async (req, res) => {
  try {
    const data = await esimRequest("get", "/destinations");
    res.json(data);
  } catch {
    res.status(500).json({ error: "Cannot fetch destinations" });
  }
});

app.get("/api/esim/products", async (req, res) => {
  if (!req.query.destinationid)
    return res.status(400).json({ error: "destinationid required" });

  try {
    const data = await esimRequest(
      "get",
      `/products?destinationid=${req.query.destinationid}`
    );
    res.json(data);
  } catch {
    res.status(500).json({ error: "Cannot fetch products" });
  }
});

// Website/API eSIM purchase endpoint
app.post("/api/esim/purchase", async (req, res) => {
  const { sku, quantity, mobileno, emailid, country, source } = req.body;

  if (!sku || !quantity || !mobileno || !emailid) {
    return res.status(400).json({
      error: "sku, quantity, mobileno, emailid are required",
    });
  }

  const payload = {
    items: [
      {
        type: "1",
        sku,
        quantity,
        mobileno,
        emailid,
      },
    ],
  };

  try {
    const data = await esimRequest("post", "/purchaseesim", { data: payload });

    recordOrder({
      source: source || "website",
      channel: "api",
      sku,
      quantity,
      mobileno,
      emailid,
      country: country || null,
      providerResponse: data,
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to purchase eSIM" });
  }
});

// -----------------------------------------------------
// STRIPE CHECKOUT (test or live mode)
// -----------------------------------------------------

app.post("/api/payments/create-checkout-session", async (req, res) => {
  if (!stripe)
    return res.status(500).json({ error: "Stripe not configured" });

  const { sku, planName, country, quantity, price, currency, email } =
    req.body;

  if (!sku || !planName || !quantity || !price || !currency || !email) {
    return res.status(400).json({
      error:
        "sku, planName, quantity, price, currency, email are required",
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      payment_method_types: ["card"],
      success_url:
        process.env.STRIPE_SUCCESS_URL ||
        "https://simclaire.com/payment-success",
      cancel_url:
        process.env.STRIPE_CANCEL_URL ||
        "https://simclaire.com/payment-cancelled",
      line_items: [
        {
          quantity,
          price_data: {
            currency: currency.toLowerCase(),
            unit_amount: Math.round(Number(price) * 100),
            product_data: {
              name: `${country} ${planName}.trim()`,
              metadata: { sku, country },
            },
          },
        },
      ],
      metadata: {
        sku,
        quantity,
        country,
        planName,
        email,
        source: "website",
      },
    });

    recordOrder({
      source: "website",
      channel: "stripe",
      sku,
      quantity,
      emailid: email,
      country,
      stripeSessionId: session.id,
      stripeUrl: session.url,
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: "Stripe session creation failed" });
  }
});

// -----------------------------------------------------
// SIMPLE ADMIN API (read-only orders)
// -----------------------------------------------------
app.get("/api/admin/orders", (req, res) => {
  const role = getRoleFromRequest(req);
  if (!role) return res.status(401).json({ error: "Unauthorized" });

  res.json({
    role,
    count: orders.length,
    orders,
  });
});

// -----------------------------------------------------
// WHATSApp chatbot webhook (Twilio)
// -----------------------------------------------------

app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From || "unknown";
  const body = clean(req.body.Body || "");
  const lower = body.toLowerCase();
  const session = getSession(from);

  console.log("📲 WA:", { from, body, step: session.step });

  // MENU COMMANDS
  if (["menu", "main"].includes(lower)) {
    resetSession(from);
    return res.send(
      twiml(
        `👋 Welcome to SimClaire eSIMs 🌍

1) Browse eSIM plans
2) Help & FAQ
3) Contact support

Reply with 1, 2, or 3.`
      )
    );
  }

  if (["restart", "reset"].includes(lower)) {
    resetSession(from);
    return res.send(
      twiml(
        `🔄 Session reset.

1) Browse eSIM plans
2) Help & FAQ
3) Contact support`
      )
    );
  }

  try {
    // MENU
    if (session.step === "MENU") {
      if (
        ["hi", "hello", "hey"].includes(lower) ||
        !["1", "2", "3"].includes(lower)
      ) {
        return res.send(
          twiml(
            `👋 Welcome to SimClaire eSIMs 🌍

1) Browse eSIM plans
2) Help & FAQ
3) Contact support

Reply with 1, 2, or 3.`
          )
        );
      }

      if (lower === "1") {
        session.step = "WAIT_COUNTRY";
        return res.send(
          twiml(`🌍 Great! Type the *country* you're travelling to.`)
        );
      }

      if (lower === "2") {
        return res.send(
          twiml(
            `ℹ️ FAQ\n• eSIM delivered instantly by email.\n• Activate by scanning the QR code.\n• Most eSIMs activate upon arrival.\n\nType *menu* to go back.`
          )
        );
      }

      if (lower === "3") {
        return res.send(
          twiml(
            `📞 Support\nEmail: support@simclaire.com\n\nType *menu* to go back.`
          )
        );
      }
    }

    // COUNTRY
    if (session.step === "WAIT_COUNTRY") {
      const dests = await esimRequest("get", "/destinations");
      const list = Array.isArray(dests) ? dests : dests.data || [];

      const match = list.find((d) => {
        const name = (d.destinationName || "").toLowerCase();
        return (
          name === lower ||
          name.includes(lower) ||
          (d.isoCode || "").toLowerCase() === lower
        );
      });

      if (!match) {
        return res.send(
          twiml(
            `❌ Country not found.\nTry again (e.g. Spain, USA, Turkey).`
          )
        );
      }

      const flag = getFlag(match);

      session.country = match.destinationName;
      session.destinationId = match.destinationID;
      session.step = "WAIT_PLAN";

      const productData = await esimRequest(
        "get",
        `/products?destinationid=${match.destinationID}`
      );

      const products = Array.isArray(productData)
        ? productData
        : productData.data || [];

      if (!products.length) {
        return res.send(
          twiml(
            `⚠️ ${flag} No instant eSIMs available for *${match.destinationName}*.\nTry another country.`
          )
        );
      }

      session.products = products;
      return res.send(twiml(formatPlans(match.destinationName, flag, products)));
    }

    // PLAN
    if (session.step === "WAIT_PLAN") {
      const num = parseInt(lower, 10);

      if (isNaN(num) || num < 1 || num > session.products.length) {
        return res.send(
          twiml(`❌ Invalid choice. Reply with 1–${session.products.length}.`)
        );
      }

      session.selectedProduct = session.products[num - 1];
      session.step = "WAIT_QTY";
      return res.send(
        twiml(`📦 How many eSIMs would you like? (1–10)`)
      );
    }

    // QTY
    if (session.step === "WAIT_QTY") {
      const qty = parseInt(lower, 10);

      if (isNaN(qty) || qty < 1 || qty > 10) {
        return res.send(
          twiml(`❌ Please choose between 1 and 10.`)
        );
      }

      session.quantity = qty;
      session.step = "WAIT_MOBILE";

      return res.send(
        twiml(`📱 Send your *mobile number* with country code.\nExample: +44 7123 456789`)
      );
    }

    // MOBILE
    if (session.step === "WAIT_MOBILE") {
      const mobile = body.replace(/\s+/g, "");
      if (!/^\+?\d{6,15}$/.test(mobile)) {
        return res.send(
          twiml(`❌ Invalid number. Try again with country code.`)
        );
      }

      session.mobile = mobile;
      session.step = "WAIT_EMAIL";

      return res.send(
        twiml(`📧 Great! Now send your *email address*.`)
      );
    }

    // EMAIL + PURCHASE
    if (session.step === "WAIT_EMAIL") {
      const email = body.trim();

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.send(twiml(`❌ Invalid email. Try again.`));
      }

      session.email = email;
      const product = session.selectedProduct;

      if (!product) {
        resetSession(from);
        return res.send(twiml(`⚠️ Error. Type *menu* to restart.`));
      }

      const payload = {
        items: [
          {
            type: "1",
            sku: product.productSku || product.sku,
            quantity: session.quantity,
            mobileno: session.mobile,
            emailid: session.email,
          },
        ],
      };

      try {
        const purchase = await esimRequest("post", "/purchaseesim", {
          data: payload,
        });

        recordOrder({
          source: "whatsapp",
          channel: "twilio",
          country: session.country,
          sku: product.productSku || product.sku,
          quantity: session.quantity,
          mobileno: session.mobile,
          emailid: session.email,
          providerResponse: purchase,
        });

        resetSession(from);

        return res.send(
          twiml(
            `🎉 Your eSIM order is complete!\nDetails sent to *${email}*.\nReply *menu* to start again.`
          )
        );
      } catch (err) {
        return res.send(
          twiml(
            `⚠️ Could not process your order.\nPlease try again later or type *menu*.`
          )
        );
      }
    }

    // FALLBACK
    return res.send(
      twiml(`😅 I didn’t understand that. Type *menu* to restart.`)
    );
  } catch (err) {
    console.error("WA error:", err);
    return res.send(
      twiml(`⚠️ Server issue. Try again or type *menu*.`)
    );
  }
});

// -----------------------------------------------------
// SIMPLE ADMIN DASHBOARD (HTML VIEW)
// -----------------------------------------------------
app.get("/admin", (req, res) => {
  const role = getRoleFromRequest(req);
  if (!role) {
    return res.status(401).send("Unauthorized");
  }

  let rows = "";

  if (orders.length === 0) {
    rows = <tr><td colspan="6" style="text-align:center;">No orders yet</td></tr>;
  } else {
    rows = orders
      .map(
        (o) => `
      <tr>
        <td>${o.id}</td>
        <td>${o.createdAt}</td>
        <td>${o.source}</td>
        <td>${o.sku}</td>
        <td>${o.quantity}</td>
        <td>${o.emailid || ""}</td>
      </tr>
    `
      )
      .join("");
  }

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>SimClaire Admin</title>
    <style>
      body { font-family: Arial; padding: 20px; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th, td { border: 1px solid #ddd; padding: 8px; }
      th { background: #333; color: white; }
    </style>
  </head>
  <body>
    <h1>SimClaire Admin Dashboard</h1>
    <p>Role: <strong>${role}</strong></p>

    <table>
      <tr>
        <th>Order ID</th>
        <th>Date</th>
        <th>Source</th>
        <th>SKU</th>
        <th>Qty</th>
        <th>Email</th>
      </tr>
      ${rows}
    </table>
  </body>
  </html>
  `;

  res.send(html);
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 Backend running on port ${PORT}`);
});