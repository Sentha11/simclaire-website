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
// STRIPE SETUP (for website checkout)
// -----------------------------------------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
} else {
  console.warn("⚠️ STRIPE_SECRET_KEY not set — Stripe checkout disabled");
}

// -----------------------------------------------------
// SIMPLE ORDER LOG (in-memory for now)
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
// TOKEN CACHE
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
// TwiML helper (SAFE)
// -----------------------------------------------------
function twiml(message) {
  // No CDATA; Twilio accepts plain text body
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message><![CDATA[${message}]]></Message>
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
    return `${flag ? flag + " " : ""}No instant eSIMs are available for *${country}* right now. Please try another destination or type *menu*.`;
  }

  let out = `${flag ? flag + " " : ""}Here are top plans for *${country}*:\n\n`;

  const top = products.slice(0, 5);
  top.forEach((p, idx) => {
    const name = p.productName || p.productDisplayName || "Plan";
    const data =
      p.productDataAllowance ||
      p.productData ||
      p.dataAllowance ||
      "Data bundle";
    const validity = p.productValidity || p.validity || "";
    const price =
      p.productPrice != null
        ? `£${p.productPrice}`
        : p.price != null
        ? `£${p.price}`
        : "";

    out += `*${idx + 1}) ${name}*\n`;
    out += `   💾 ${data}\n`;
    if (validity) out += `   📅 ${validity} days\n`;
    if (price) out += `   💵 ${price}\n`;
    out += "\n";
  });

  out += `Reply with *1–${top.length}* to choose a plan.\nType *menu* to restart.`;
  return out;
}

// -----------------------------------------------------
// BASIC API ROUTES (health + ESIM)
// -----------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({ status: "OK", backend: "running" });
});

app.get("/api/test-auth", async (req, res) => {
  try {
    const token = await getEsimToken();
    res.json({ ok: true, token });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/esim/destinations", async (req, res) => {
  try {
    const data = await esimRequest("get", "/destinations");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Cannot fetch destinations" });
  }
});

app.get("/api/esim/products", async (req, res) => {
  const { destinationid } = req.query;
  if (!destinationid) {
    return res.status(400).json({ error: "destinationid required" });
  }

  try {
    const data = await esimRequest(
      "get",
      `/products?destinationid=${encodeURIComponent(destinationid)}`
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Cannot fetch products" });
  }
});

// Website/API eSIM purchase endpoint (no-KYC, type=1)
app.post("/api/esim/purchase", async (req, res) => {
  const { sku, quantity, mobileno, emailid, country, source } = req.body;

  if (!sku || !quantity || !mobileno || !emailid) {
    return res.status(400).json({
      error: "sku, quantity, mobileno, and emailid are required",
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

    // Log order (website/api)
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
    console.error("❌ /api/esim/purchase error:", err.message);
    res.status(500).json({ error: "Failed to purchase eSIM" });
  }
});

// -----------------------------------------------------
// STRIPE CHECKOUT (simple)
// -----------------------------------------------------
// Body: { sku, country, planName, quantity, price, currency, email }
app.post("/api/payments/create-checkout-session", async (req, res) => {
  if (!stripe) {
    return res
      .status(500)
      .json({ error: "Stripe is not configured on the server." });
  }

  const {
    sku,
    country,
    planName,
    quantity,
    price, // numeric, e.g. 15.99
    currency,
    email,
  } = req.body;

  if (
    !sku ||
    !planName ||
    !quantity ||
    !price ||
    !currency ||
    !email
  ) {
    return res.status(400).json({
      error:
        "sku, planName, quantity, price, currency, and email are required",
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
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
              name: `${country || ""} ${planName}.trim()`,
              metadata: { sku, country: country || "" },
            },
          },
        },
      ],
      metadata: {
        sku,
        quantity,
        country: country || "",
        planName,
        email,
        source: "website",
      },
    });

    // Optional: log intent/order stub
    recordOrder({
      source: "website",
      channel: "stripe",
      sku,
      quantity,
      emailid: email,
      country: country || null,
      stripeSessionId: session.id,
      stripeUrl: session.url,
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error("❌ Stripe session error:", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// -----------------------------------------------------
// SIMPLE ADMIN API (read-only orders)
// -----------------------------------------------------
app.get("/api/admin/orders", (req, res) => {
  const role = getRoleFromRequest(req);
  if (!role) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json({
    role,
    count: orders.length,
    orders,
  });
});

// -----------------------------------------------------
// WHATSAPP WEBHOOK (Twilio) – Conversational eSIM flow
// -----------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From || "unknown";
  const body = clean(req.body.Body || "");
  const lower = body.toLowerCase();
  const session = getSession(from);

  console.log("📲 Incoming WhatsApp:", { from, body, step: session.step });

  // ------------- GLOBAL COMMANDS -------------
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
3) Contact support

Reply with 1, 2, or 3.`
      )
    );
  }

  try {
    // ------------- MENU -------------
    if (session.step === "MENU") {
      if (
        ["hi", "hello", "hey"].includes(lower) ||
        !["1", "2", "3"].includes(lower)
      ) {
        return res.send(
          twiml(
            `👋 Welcome to SimClaire eSIMs 🌍

I can help you instantly buy travel eSIMs.

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
          twiml(
            `🌍 Great! Let's find you a plan.

Please type the country you are travelling to.`
          )
        );
      }

      if (lower === "2") {
        return res.send(
          twiml(
            `ℹ️ Help & FAQ

* You’ll receive an eSIM by email.
* Scan or enter the activation code on your device.
* Most eSIMs activate when you land.

Type menu to go back.`
          )
        );
      }

      if (lower === "3") {
        return res.send(
          twiml(
            `📞 Support

Email: support@simclaire.com

Type menu to go back.`
          )
        );
      }

      return res.send(
        twiml(
          `❓ I didn't understand that.

Reply with:
1) Browse eSIM plans
2) Help & FAQ
3) Contact support`
        )
      );
    }

    // ------------- COUNTRY -------------
    if (session.step === "WAIT_COUNTRY") {
      const destData = await esimRequest("get", "/destinations");
      const list = Array.isArray(destData)
        ? destData
        : destData.data || [];

      if (!list.length) {
        return res.send(
          twiml(
            `⚠️ I couldn't load destinations right now. Please try again in a few minutes or type *menu*.
          `)
        );
      }

      const match = list.find((d) => {
        const name = (d.destinationName || "").toLowerCase();
        const iso = (d.isoCode || "").toLowerCase();
        return (
          name === lower ||
          iso === lower ||
          name.includes(lower)
        );
      });

      if (!match) {
        return res.send(
          twiml(
            `❌ I couldn't find that destination.

Please type the country name again, e.g. Spain, USA, Japan,
or type menu to go back.`
          )
        );
      }

      const flag = getFlag(match);

      session.country = match.destinationName;
      session.destinationId = match.destinationID;
      session.step = "WAIT_PLAN";

      const productsData = await esimRequest(
        "get",
        `/products?destinationid=${match.destinationID}`
      );

      const products = Array.isArray(productsData)
        ? productsData
        : productsData.data || [];

      if (!products.length) {
        return res.send(
          twiml(
            `⚠️ ${flag} No instant eSIMs available for ${match.destinationName} right now.

Try another country or type menu.`
          )
        );
      }

      session.products = products;
      const msg = formatPlans(session.country, flag, products);
      return res.send(twiml(msg));
    }

    // ------------- PLAN -------------
    if (session.step === "WAIT_PLAN") {
      const num = parseInt(lower, 10);
      if (
        Number.isNaN(num) ||
        num < 1 ||
        num > session.products.length
      ) {
        return res.send(
          twiml(
            `❌ Invalid choice. Reply with a number *1–${session.products.length}*.
          `)
        );
      }

      session.selectedProduct = session.products[num - 1];
      session.step = "WAIT_QTY";

      return res.send(
        twiml(`📦 How many eSIMs would you like?\nReply with *1–10*.`)
      );
    }

    // ------------- QUANTITY -------------
    if (session.step === "WAIT_QTY") {
      const qty = parseInt(lower, 10);

      if (Number.isNaN(qty) || qty < 1 || qty > 10) {
        return res.send(
          twiml(`❌ Please reply with a number between *1* and *10*.`)
        );
      }

      session.quantity = qty;
      session.step = "WAIT_MOBILE";

      return res.send(
        twiml(
          `📱 Great — *${qty}* eSIM(s).\n\nPlease send your *mobile number* including country code.\nExample: *+44 7123 456789*
       `)
      );
    }

    // ------------- MOBILE -------------
    if (session.step === "WAIT_MOBILE") {
      const mobile = body.replace(/\s+/g, "");
      if (!/^\+?\d{6,15}$/.test(mobile)) {
        return res.send(
          twiml(
            `❌ That doesn't look like a valid number.\n\nPlease send your mobile number with country code.\nExample: *+44 7123 456789*
          `)
        );
      }

      session.mobile = mobile;
      session.step = "WAIT_EMAIL";

      return res.send(
        twiml(
          `📧 Almost done!\n\nPlease send your *email address* so we can send your eSIM details.
        `)
      );
    }

    // ------------- EMAIL + PURCHASE -------------
    if (session.step === "WAIT_EMAIL") {
      const email = body.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.send(
          twiml(
            `❌ That doesn't look like a valid email.\n\nPlease send a valid email address.\nExample: *name@example.com*`
          )
        );
      }

      session.email = email;
      const product = session.selectedProduct;

      if (!product) {
        resetSession(from);
        return res.send(
          twiml(
            `⚠️ Something went wrong with your selected plan.\nType *menu* to start again.`
          )
        );
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

        // log order
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
            `🎉 Your eSIM order is complete!\n\nWe’ve sent full details to *${email}*.\n\nIf you don't see it, check spam or reply *support*.
          `)
        );
      } catch (err) {
        console.error("WhatsApp purchase error:", err.message);
        return res.send(
          twiml(
            `⚠️ There was an issue processing your order.\nNo payment will be taken. Please try again later or type *menu* to start over.
          `)
        );
      }
    }

    // ------------- FALLBACK -------------
    return res.send(
      twiml(`😅 I got a bit lost.\nType *menu* to go back to the main menu.`)
    );
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    return res.send(
      twiml(
        `⚠️ Something went wrong on our side.\nPlease try again in a moment or type *menu* to restart.
      `)
    );
  }
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 Backend running on port ${PORT}`);
});