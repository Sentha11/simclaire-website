// =====================================================
// server.js – SimClaire Backend (ESIM + WhatsApp + Stripe + Admin)
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
app.use(express.urlencoded({ extended: false })); // Twilio webhook
app.use(express.json());

// -----------------------------------------------------
// QUOTAGUARD STATIC PROXY
// -----------------------------------------------------
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled");
} else {
  console.warn("⚠️ QUOTAGUARD_URL missing — proxy disabled");
}

// -----------------------------------------------------
// ESIM ENV VARS
// -----------------------------------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  console.warn("⚠️ Missing eSIM environment vars");
}

// -----------------------------------------------------
// STRIPE SETUP
// -----------------------------------------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
} else {
  console.warn("⚠️ Stripe disabled (no STRIPE_SECRET_KEY)");
}

// -----------------------------------------------------
// SIMPLE ORDER LOG (in-memory)
// -----------------------------------------------------
const orders = [];

function recordOrder(order) {
  orders.push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    createdAt: new Date().toISOString(),
    ...order,
  });
}

// -----------------------------------------------------
// ADMIN AUTH (header: x-api-key)
// -----------------------------------------------------
function getRole(req) {
  const key = req.headers["x-api-key"] || req.query.key;

  if (!key) return null;

  if (key === process.env.ADMIN_API_KEY) return "admin";
  if (key === process.env.SUPPORT_API_KEY) return "support";

  return null;
}

// -----------------------------------------------------
// TOKEN CACHE
// -----------------------------------------------------
let esimToken = null;
let esimExpires = 0;

async function getEsimToken() {
  const now = Date.now();

  if (esimToken && now < esimExpires) return esimToken;

  const url = `${ESIM_BASE_URL}/authenticate`;

  const res = await axios.post(
    url,
    { userName: ESIM_USERNAME, password: ESIM_PASSWORD },
    { httpsAgent: proxyAgent || undefined, proxy: false }
  );

  esimToken = res.data.token;
  esimExpires = now + (res.data.expirySeconds || 600) * 1000;

  console.log("🔐 eSIM token refreshed");
  return esimToken;
}

// -----------------------------------------------------
// ESIM REQUEST WRAPPER
// -----------------------------------------------------
async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}${path}`;

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
      esimToken = null;
      return esimRequest(method, path, options);
    }
    console.error("❌ ESIM API ERROR:", err.message);
    throw err;
  }
}

// -----------------------------------------------------
// FLAG EMOJI
// -----------------------------------------------------
const flagOverride = {
  USA: "🇺🇸",
  UK: "🇬🇧",
  UAE: "🇦🇪",
};

function flagEmojiFromIso(iso) {
  return iso
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

function getFlag(dest) {
  const name = dest.destinationName?.toUpperCase() || "";
  const iso = dest.isoCode?.toUpperCase() || "";
  return flagOverride[name] || flagOverride[iso] || flagEmojiFromIso(iso);
}

// -----------------------------------------------------
// TwiML HELPER
// -----------------------------------------------------
function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${message}</Message>
</Response>`;
}

// -----------------------------------------------------
// SESSION MANAGER
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

const clean = (t) => (t || "").trim();

// -----------------------------------------------------
// PLAN FORMATTER
// -----------------------------------------------------
function formatPlans(country, flag, products) {
  if (!products.length)
    return `${flag} No eSIMs available for *${country}*. Try another country.`;

  let out = `${flag} Plans for *${country}*:\n\n`;

  products.slice(0, 5).forEach((p, i) => {
    out += `*${i + 1}) ${p.productName}*\n`;
    out += `💾 ${p.productDataAllowance}\n`;
    out += `📅 ${p.productValidity} days\n`;
    out += `💵 £${p.productPrice}\n\n`;
  });

  out += `Reply with 1–${products.length};`
  return out;
}

// -----------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({ ok: true });
});

// -----------------------------------------------------
// DESTINATIONS
// -----------------------------------------------------
app.get("/api/esim/destinations", async (req, res) => {
  try {
    const data = await esimRequest("get", "/destinations");
    res.json(data);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// -----------------------------------------------------
// PRODUCTS
// -----------------------------------------------------
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
    res.status(500).json({ error: "Failed" });
  }
});

// -----------------------------------------------------
// WEBSITE PURCHASE API
// -----------------------------------------------------
app.post("/api/esim/purchase", async (req, res) => {
  const { sku, quantity, mobileno, emailid, country } = req.body;

  if (!sku || !quantity || !mobileno || !emailid)
    return res.status(400).json({ error: "Missing required fields" });

  try {
    const data = await esimRequest("post", "/purchaseesim", {
      data: {
        items: [
          { type: "1", sku, quantity, mobileno, emailid },
        ],
      },
    });

    recordOrder({ source: "website", sku, quantity, mobileno, emailid, country });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Purchase failed" });
  }
});

// -----------------------------------------------------
// STRIPE CHECKOUT
// -----------------------------------------------------
app.post("/api/payments/create-checkout-session", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe disabled" });

  const { sku, planName, quantity, price, currency, email, country } = req.body;

  if (!sku || !planName || !quantity || !price || !currency || !email)
    return res.status(400).json({ error: "Missing required fields" });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      payment_method_types: ["card"],
      success_url: process.env.STRIPE_SUCCESS_URL,
      cancel_url: process.env.STRIPE_CANCEL_URL,
      line_items: [
        {
          quantity,
          price_data: {
            currency: currency,
            unit_amount: Math.round(price * 100),
            product_data: {
              name: `${country} ${planName}`,
              metadata: { sku },
            },
          },
        },
      ],
    });

    recordOrder({
      source: "website",
      sku,
      quantity,
      emailid: email,
      country,
      stripeSessionId: session.id,
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// -----------------------------------------------------
// ADMIN DASHBOARD (HTML)
// -----------------------------------------------------
app.get("/admin", (req, res) => {
  const role = getRole(req);
  if (!role) return res.status(401).send("Unauthorized");

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
      </tr>`
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
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #ccc; padding: 8px; }
      th { background: #333; color: #fff; }
    </style>
  </head>
  <body>
    <h1>SimClaire Admin Dashboard</h1>
    <p>Role: <b>${role}</b></p>

    <table>
      <tr>
        <th>ID</th>
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
// WHATSAPP BOT
// -----------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From;
  const body = clean(req.body.Body || "");
  const session = getSession(from);
  const lower = body.toLowerCase();

  console.log("📲 WhatsApp:", { from, body, step: session.step });

  // ---------------- MENU RESET ----------------
  if (["menu", "restart", "reset", "main"].includes(lower)) {
    resetSession(from);
    return res.send(
      twiml(
        `👋 Welcome to SimClaire eSIMs 🌍

1) Browse eSIM plans
2) Help & FAQ
3) Contact support`
      )
    );
  }

  try {
    // ---------------- MENU ----------------
    if (session.step === "MENU") {
      if (!["1", "2", "3"].includes(lower)) {
        return res.send(
          twiml(
            `👋 Welcome to SimClaire eSIMs 🌍

1) Browse eSIM plans
2) Help & FAQ
3) Contact support`
          )
        );
      }

      if (lower === "1") {
        session.step = "WAIT_COUNTRY";
        return res.send(
          twiml(
            `🌍 Great! Please type the *country* you're travelling to.`
          )
        );
      }

      if (lower === "2") {
        return res.send(
          twiml(
            `ℹ️ FAQ:
* eSIM delivered by email
* Works instantly when you land
* Easy activation

Type menu to return`
          )
        );
      }

      if (lower === "3") {
        return res.send(
          twiml(`📞 Support: support@simclaire.com`)
        );
      }
    }

    // ---------------- COUNTRY ----------------
    if (session.step === "WAIT_COUNTRY") {
      const destData = await esimRequest("get", "/destinations");
      const list = Array.isArray(destData) ? destData : destData.data || [];

      const match = list.find((d) => {
        const name = (d.destinationName || "").toLowerCase();
        const iso = (d.isoCode || "").toLowerCase();
        return name.includes(lower) || name === lower || iso === lower;
      });

      if (!match) {
        return res.send(
          twiml(`❌ Country not found. Try again.`)
        );
      }

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
            `⚠️ No plans found for ${session.country}. Try another country.`
          )
        );
      }

      session.products = products;
      return res.send(
        twiml(formatPlans(session.country, getFlag(match), products))
      );
    }

    // ---------------- PLAN ----------------
    if (session.step === "WAIT_PLAN") {
      const num = parseInt(lower);

      if (isNaN(num) || num < 1 || num > session.products.length) {
        return res.send(
          twiml(`❌ Invalid choice. Pick 1–${session.products.length}`)
        );
      }

      session.selectedProduct = session.products[num - 1];
      session.step = "WAIT_QTY";

      return res.send(
        twiml(`📦 How many eSIMs would you like? (1–10)`)
      );
    }

    // ---------------- QTY ----------------
    if (session.step === "WAIT_QTY") {
      const qty = parseInt(lower);

      if (isNaN(qty) || qty < 1 || qty > 10) {
        return res.send(twiml(`❌ Enter a number 1–10`));
      }

      session.quantity = qty;
      session.step = "WAIT_MOBILE";

      return res.send(
        twiml(
          `📱 Send your mobile number with country code.\nExample: +44 7123 456789`
        )
      );
    }

    // ---------------- MOBILE ----------------
    if (session.step === "WAIT_MOBILE") {
      const mobile = body.replace(/\s+/g, "");

      if (!/^\+?\d{6,15}$/.test(mobile)) {
        return res.send(
          twiml(`❌ Invalid mobile number. Try again.`)
        );
      }

      session.mobile = mobile;
      session.step = "WAIT_EMAIL";

      return res.send(twiml(`📧 Send your email address`));
    }

    // ---------------- EMAIL + PURCHASE ----------------
    if (session.step === "WAIT_EMAIL") {
      const email = body.trim();

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.send(twiml(`❌ Invalid email. Try again.`));
      }

      session.email = email;

      const product = session.selectedProduct;

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
        const purchase = await esimRequest(
          "post",
          "/purchaseesim",
          { data: payload }
        );

        recordOrder({
          source: "whatsapp",
          country: session.country,
          sku: product.productSku,
          quantity: session.quantity,
          mobileno: session.mobile,
          emailid: session.email,
        });

        resetSession(from);

        return res.send(
          twiml(
            `🎉 Your eSIM order is complete!\nDetails sent to ${email}.`
          )
        );
      } catch (err) {
        console.error("Purchase error:", err.message);
        return res.send(
          twiml(
            `⚠️ Order failed.\nTry again later or type *menu*.`
          )
        );
      }
    }

    // ---------------- FALLBACK ----------------
    return res.send(
      twiml(`😅 I got lost.\nType *menu* to start again.`)
    );
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    return res.send(
      twiml(`⚠️ Something went wrong. Try again.`)
    );
  }
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 Backend running on port ${PORT}`));