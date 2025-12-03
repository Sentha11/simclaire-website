// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

// -----------------------------------------------------
// BASIC MIDDLEWARE
// -----------------------------------------------------
app.use(cors());
app.use(express.urlencoded({ extended: false })); // Twilio sends x-www-form-urlencoded
app.use(express.json());

// -----------------------------------------------------
// QUOTAGUARD STATIC PROXY SETUP
// -----------------------------------------------------
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled!");
  console.log("QUOTAGUARD_URL =", process.env.QUOTAGUARD_URL);
} else {
  console.warn("⚠️ QUOTAGUARD_URL missing — proxy is OFF");
}

// -----------------------------------------------------
// ESIM ENV VARS
// -----------------------------------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  console.warn("⚠️ Missing eSIM API environment variables");
}

// -----------------------------------------------------
// TOKEN CACHE
// -----------------------------------------------------
let esimToken = null;
let esimTokenExpiresAt = 0;

async function getEsimToken() {
  const now = Date.now();
  if (esimToken && now < esimTokenExpiresAt) {
    return esimToken;
  }

  const url = `${ESIM_BASE_URL}/authenticate`;

  console.log("🚀 [AUTH] Using proxy:", !!proxyAgent);
  console.log("🔗 [AUTH] Requesting:", url);

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
// GENERIC ESIM API REQUEST WRAPPER
// -----------------------------------------------------
async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}${path}`;

  console.log("➡️ [ESIM] Request:", method.toUpperCase(), url);

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
    // Retry once if token expired
    if (err.response && err.response.status === 401) {
      console.warn("🔁 Token expired, refreshing and retrying…");
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
      console.error("❌ esimRequest response data:", err.response.data);
    }
    throw err;
  }
}

// -----------------------------------------------------
// FLAG EMOJI HELPER
// -----------------------------------------------------
function flagEmojiFromIso(isoCode) {
  if (!isoCode) return "";
  const code = isoCode.toUpperCase();
  // ISO country to emoji flag
  return code.replace(/./g, (c) =>
    String.fromCodePoint(127397 + c.charCodeAt(0))
  );
}

// Fallback mapping for non-standard names
const countryFlagsOverride = {
  "UNITED STATES OF AMERICA": "🇺🇸",
  "UNITED STATES": "🇺🇸",
  "UNITED KINGDOM": "🇬🇧",
  UK: "🇬🇧",
  UAE: "🇦🇪",
};

function getCountryFlag(dest) {
  const name = (dest.destinationName || "").toUpperCase();
  const iso = (dest.isoCode || "").toUpperCase();

  if (countryFlagsOverride[name]) return countryFlagsOverride[name];
  if (countryFlagsOverride[iso]) return countryFlagsOverride[iso];

  const flag = flagEmojiFromIso(iso);
  return flag || "";
}

// -----------------------------------------------------
// SIMPLE HEALTH & TEST ROUTES
// -----------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({ status: "OK", message: "Backend running" });
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
    res.status(500).json({ error: "Failed to fetch destinations" });
  }
});

app.get("/api/esim/products", async (req, res) => {
  const { destinationid } = req.query;
  if (!destinationid) {
    return res.status(400).json({ error: "destinationid is required" });
  }

  try {
    const data = await esimRequest(
      "get",
      `/products?destinationid=${encodeURIComponent(destinationid)}`
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.post("/api/esim/purchase", async (req, res) => {
  const { sku, quantity, mobileno, emailid } = req.body;

  if (!sku || !quantity || !mobileno || !emailid) {
    return res.status(400).json({
      error: "sku, quantity, mobileno, and emailid are required",
    });
  }

  const payload = {
    items: [
      {
        type: "1", // no-KYC product type
        sku,
        quantity,
        mobileno,
        emailid,
      },
    ],
  };

  try {
    const data = await esimRequest("post", "/purchaseesim", { data: payload });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to purchase eSIM" });
  }
});

// -----------------------------------------------------
// WHATSAPP FLOW (TWILIO WEBHOOK) – IMPROVED UI
// -----------------------------------------------------

// TwiML helper
function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${message}</Message>
</Response>`;
}

// In-memory sessions
const sessions = {};

// Simple session object
function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      step: "MENU", // MENU | WAIT_COUNTRY | WAIT_PLAN | WAIT_QTY | WAIT_MOBILE | WAIT_EMAIL
      country: null,
      destinationId: null,
      countryIso: null,
      products: [],
      selectedProduct: null,
      quantity: 1,
      mobile: null,
      email: null,
    };
  }
  return sessions[userId];
}

function resetSession(userId) {
  delete sessions[userId];
}

// Utility: clean text
function cleanText(t) {
  return (t || "").trim();
}

// Format product nicely for WhatsApp
function formatProductsList(countryName, flag, products) {
  let text = `${flag ? flag + " " : ""}Here are eSIM plans for *${countryName}*:\n\n`;

  const top = products.slice(0, 5);
  top.forEach((p, idx) => {
    const label = idx + 1;
    const name = p.productName || p.productDisplayName || "Plan";
    const data =
      p.productDataAllowance || p.productData || p.dataAllowance || "Data bundle";
    const validity = p.productValidity || p.validityDays || p.validity || "";
    const price =
      p.productPrice != null
        ? `£${p.productPrice}`
        : p.price != null
        ? `£${p.price}`
        : "";

    text += `*${label}) ${name}*\n`;
    text += `   💾 ${data}\n`;
    if (validity) text += `   📅 ${validity} days\n`;
    if (price) text += `   💵 ${price}\n`;
    text += "\n";
  });

  text += "Reply with 1, 2, 3… to choose a plan.\n";
  text += 'You can also type menu to go back to the main menu.';
  return text;
}

// WhatsApp webhook – set this URL in Twilio: /webhook/whatsapp
app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.WaId || req.body.From || "unknown";
  const body = cleanText(req.body.Body || "");
  const lower = body.toLowerCase();
  const session = getSession(from);

  console.log("📲 Incoming WhatsApp:", { from, body, step: session.step });

  // Global commands
  if (["menu", "main"].includes(lower)) {
    resetSession(from);
    const msg = `👋 Welcome to SimClaire eSIMs 🌍

1) Browse eSIM plans
2) Help & FAQ
3) Contact support

Reply with 1, 2, or 3.`;
    res.set("Content-Type", "text/xml");
    return res.send(twiml(msg));
  }

  if (["restart", "reset", "start over"].includes(lower)) {
    resetSession(from);
    const msg = `✅ Session reset.

👋 Welcome to SimClaire eSIMs 🌍

1) Browse eSIM plans
2) Help & FAQ
3) Contact support

Reply with 1, 2, or 3.`;
    res.set("Content-Type", "text/xml");
    return res.send(twiml(msg));
  }

  try {
    // ----------------- MENU STATE -----------------
    if (session.step === "MENU") {
      // First-time or generic hi
      if (
        ["hi", "hello", "hey"].includes(lower) ||
        !["1", "2", "3"].includes(lower)
      ) {
        const msg = `👋 Welcome to SimClaire eSIMs 🌍

I can help you instantly buy travel eSIMs.

1) Browse eSIM plans
2) Help & FAQ
3) Contact support

Reply with 1, 2, or 3.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      if (lower === "1") {
        session.step = "WAIT_COUNTRY";
        const msg = `🌍 Great! Let's find you a plan.

Please type the country you're travelling to.
For example: Italy, USA, Japan, United Kingdom.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      if (lower === "2") {
        const msg = `ℹ️ Help & FAQ

* You'll receive an eSIM via email.
* Scan or enter the activation code on your device.
* Most eSIMs activate when you land.

Type menu to go back or 1 to browse plans.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      if (lower === "3") {
        const msg = `📞 Support

Email: support@simclaire.com
We'll help you with any eSIM issues.

Type menu to go back.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      // Fallback
      const msg = `❓ I didn't understand that.

Reply with:
1) Browse eSIM plans
2) Help & FAQ
3) Contact support`;
      res.set("Content-Type", "text/xml");
      return res.send(twiml(msg));
    }

    // ----------------- COUNTRY SELECTION -----------------
    if (session.step === "WAIT_COUNTRY") {
      const countryInput = lower;

      // 1) Fetch destinations
      const destResponse = await esimRequest("get", "/destinations");
      const destinations = Array.isArray(destResponse)
        ? destResponse
        : destResponse.data || [];

      if (!destinations.length) {
        const msg = `⚠️ We couldn't load destinations right now.

Please try again in a few minutes or type menu to go back.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      // 2) Match country
      const matched = destinations.find((d) => {
        const name = (d.destinationName || "").toLowerCase();
        const iso = (d.isoCode || "").toLowerCase();
        return (
          name === countryInput ||
          iso === countryInput ||
          name.includes(countryInput)
        );
      });

      if (!matched) {
        const msg = `❌ I couldn't find that destination.

Please type the country name again (e.g. Spain, USA, Turkey),
or type menu to go back.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      session.country = matched.destinationName;
      session.destinationId = matched.destinationID;
      session.countryIso = matched.isoCode;

      const flag = getCountryFlag(matched);

      // 3) Fetch products
      let productResponse;
      try {
        productResponse = await esimRequest(
          "get",
          `/products?destinationid=${encodeURIComponent(
            matched.destinationID
          )}`
        );
      } catch (err) {
        console.error("❌ products error:", err.message);
        const msg = `⚠️ ${flag} We couldn't fetch plans for ${matched.destinationName} right now.

Please try again in a few minutes or type menu to go back.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      const allProducts = Array.isArray(productResponse)
        ? productResponse
        : productResponse.data || [];

      // Filter no-KYC products if productType present
      const type1 = allProducts.filter(
        (p) => !p.productType || String(p.productType) === "1"
      );

      if (!type1.length) {
        const msg = `⚠️ ${flag} We currently don't have instant eSIMs available for ${matched.destinationName}.

Please try another country, or type menu to go back.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      session.products = type1;
      session.step = "WAIT_PLAN";

      const plansText = formatProductsList(
        matched.destinationName,
        flag,
        type1
      );

      res.set("Content-Type", "text/xml");
      return res.send(twiml(plansText));
    }

    // ----------------- PLAN CHOICE -----------------
    if (session.step === "WAIT_PLAN") {
      const choice = parseInt(lower, 10);
      if (
        Number.isNaN(choice) ||
        choice < 1 ||
        choice > session.products.length
      ) {
        const msg = `❌ Please reply with a number between 1 and ${session.products.length} to choose a plan.

Or type menu to go back.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      session.selectedProduct = session.products[choice - 1];
      session.step = "WAIT_QTY";

      const msg = `✅ Got it.

How many eSIMs do you need?
Reply with a number between 1 and 10.`;
      res.set("Content-Type", "text/xml");
      return res.send(twiml(msg));
    }

    // ----------------- QUANTITY -----------------
    if (session.step === "WAIT_QTY") {
      const qty = parseInt(lower, 10);

      if (Number.isNaN(qty) || qty < 1 || qty > 10) {
        const msg = `❌ Please reply with a number between *1* and *10* for how many eSIMs you need.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      session.quantity = qty;
      session.step = "WAIT_MOBILE";

      const msg = `📱 Great — ${qty} eSIM(s).

Please send your mobile number including country code.
For example: +44 7123 456789`;
      res.set("Content-Type", "text/xml");
      return res.send(twiml(msg));
    }

    // ----------------- MOBILE -----------------
    if (session.step === "WAIT_MOBILE") {
      const mobile = body.replace(/\s+/g, "");
      if (!/^\+?\d{6,15}$/.test(mobile)) {
        const msg = `❌ That doesn't look like a valid number.

Please send your mobile number with country code.
Example: +44 7123 456789`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      session.mobile = mobile;
      session.step = "WAIT_EMAIL";

      const msg = `📧 Almost done!

Please send your email address so we can send your eSIM details.`;
      res.set("Content-Type", "text/xml");
      return res.send(twiml(msg));
    }

    // ----------------- EMAIL + PURCHASE -----------------
    if (session.step === "WAIT_EMAIL") {
      const email = body;

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        const msg = `❌ That doesn't look like a valid email.

Please send a valid email address.
Example: name@example.com`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      session.email = email;

      const product = session.selectedProduct;
      if (!product) {
        const msg = `⚠️ Something went wrong with your selected plan.

Please type menu to start again.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
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
        const purchaseRes = await esimRequest("post", "/purchaseesim", {
          data: payload,
        });

        const esimInfo = Array.isArray(purchaseRes.esims)
          ? purchaseRes.esims[0]
          : purchaseRes.esims?.[0];

        let msg;
        if (esimInfo?.activationcode) {
          msg = `🎉 Your eSIM order is complete!

Destination: ${session.country}
Quantity: ${session.quantity}

Your activation code (LPA):
\\\`
${esimInfo.activationcode}
\\\`

We've also emailed full details to:
${session.email}

If you need help installing your eSIM, reply help.`;
        } else {
          msg = `✅ Your order has been received.

We couldn't automatically retrieve your activation code, but our team will email your full eSIM details to:
${session.email} shortly.

If you don't see it, check your spam folder or reply support.`;
        }

        resetSession(from);
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      } catch (err) {
        console.error("❌ Purchase error:", err.message);
        const msg = `⚠️ There was an issue processing your order.

No payment will be taken. Please try again later or type support for help.`;
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }
    }

    // ----------------- FALLBACK -----------------
    const fallback = `😅 I got a bit lost.

Type menu to go back to the main menu, or restart to start again.`;
    res.set("Content-Type", "text/xml");
    return res.send(twiml(fallback));
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    const msg = `⚠️ Something went wrong on our side.

Please try again in a moment or type menu to start over.`;
    res.set("Content-Type", "text/xml");
    return res.send(twiml(msg));
  }
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 Backend running on port ${PORT}`);
});