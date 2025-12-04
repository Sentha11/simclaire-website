// =====================================================
// server.js – FINAL CLEAN VERSION (FULL WHATSAPP FLOW)
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
  console.log("🔐 QuotaGuard STATIC proxy enabled!");
} else {
  console.warn("⚠️ QUOTAGUARD_URL missing — proxy OFF");
}

// -----------------------------------------------------
// ESIM ENV VARS
// -----------------------------------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

// -----------------------------------------------------
// TOKEN CACHE
// -----------------------------------------------------
let esimToken = null;
let esimTokenExpiresAt = 0;

async function getEsimToken() {
  const now = Date.now();

  if (esimToken && now < esimTokenExpiresAt) return esimToken;

  const url = `${ESIM_BASE_URL}/authenticate`;

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

  return esimToken;
}

// -----------------------------------------------------
// GENERIC API WRAPPER
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
      esimToken = null; // refresh token
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
    throw err;
  }
}

// -----------------------------------------------------
// FLAG EMOJI
// -----------------------------------------------------
function flagEmojiFromIso(iso) {
  if (!iso) return "";
  const code = iso.toUpperCase();
  return code.replace(/./g, c =>
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
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message><![CDATA]${message}</Message></Response>`;
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
// WhatsApp Webhook
// -----------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From || "unknown";
  const body = clean(req.body.Body || "");
  const lower = body.toLowerCase();
  const session = getSession(from);

  console.log("📲 Incoming WhatsApp:", { from, body, step: session.step });

  // ---------------- GLOBAL COMMANDS ----------------
  if (["menu", "main"].includes(lower)) {
    resetSession(from);
    return res.send(twiml(
      `👋 Welcome to SimClaire eSIMs 🌍

      1) Browse eSIM plans
      2) Help & FAQ
      3) Contact support`)
    );
  }

  if (["restart", "reset"].includes(lower)) {
    resetSession(from);
    return res.send(twiml(
      `🔄 Session reset.

      1) Browse eSIM plans
      2) Help & FAQ
      3) Contact support`)
    );
  }

  // ---------------- MENU ----------------
  if (session.step === "MENU") {
    if (
      ["hi", "hello", "hey"].includes(lower) ||
      !["1", "2", "3"].includes(lower)
    ) {
      return res.send(twiml(
        `👋 Welcome to SimClaire eSIMs 🌍

        1) Browse eSIM plans
        2) Help & FAQ
        3) Contact support

        Reply with 1, 2, or 3.`)
      );
    }

    if (lower === "1") {
      session.step = "WAIT_COUNTRY";
      return res.send(twiml(
        `🌍 Great!  
        Please type the country you are travelling to.`)
      );
    }

    if (lower === "2") {
      return res.send(twiml(
        `ℹ️ FAQ  
      * You will receive an eSIM by email.  
      * Scan the activation code.  
      * Most eSIMs activate when you land.`)
      );
    }

    if (lower === "3") {
      return res.send(twiml(
        `📞 Support  
        support@simclaire.com`)
      );
    }
  }

  // ---------------- COUNTRY ----------------
  if (session.step === "WAIT_COUNTRY") {
    const destData = await esimRequest("get", "/destinations");

    const list = Array.isArray(destData)
      ? destData
      : destData.data || [];

    const match = list.find(d => {
      const name = (d.destinationName || "").toLowerCase();
      const iso = (d.isoCode || "").toLowerCase();
      return name.includes(lower) || name === lower || iso === lower;
    });

    if (!match) {
      return res.send(twiml(
        `❌ Country not found. Try again.`)
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
      return res.send(twiml(
        `⚠️ ${flag} No instant eSIMs found for ${match.destinationName}.`)
      );
    }

    session.products = products;

    // FORMAT PLAN LIST
    let msg = `${flag} Plans for *${session.country}*:\n\n`;

    products.slice(0, 5).forEach((p, i) => {
      msg += `*${i + 1}) ${p.productName}*\n`;
      msg += `   💾 ${p.productDataAllowance || p.productData}\n`;
      msg += `   📅 ${p.productValidity || ""} days\n`;
      msg += `   💵 £${p.productPrice}\n\n`;
    });

    msg += `Reply with *1–${products.length}* to choose a plan.`;

    return res.send(twiml(msg));
  }

  // ---------------- PLAN ----------------
  if (session.step === "WAIT_PLAN") {
    const choice = parseInt(lower);

    if (isNaN(choice) || choice < 1 || choice > session.products.length) {
      return res.send(twiml(`❌ Invalid choice. Try again.`));
    }

    session.selectedProduct = session.products[choice - 1];
    session.step = "WAIT_QTY";

    return res.send(twiml(
      `📦 How many eSIMs would you like? (1–10)`)
    );
  }

  // ---------------- QUANTITY ----------------
  if (session.step === "WAIT_QTY") {
    const qty = parseInt(lower);

    if (isNaN(qty) || qty < 1 || qty > 10) {
      return res.send(twiml(`❌ Enter a number 1–10`));
    }

    session.quantity = qty;
    session.step = "WAIT_MOBILE";

    return res.send(twiml(
      `📱 Enter your *mobile number* with country code.\nExample: +44 7123 456789`)
    );
  }

  // ---------------- MOBILE ----------------
  if (session.step === "WAIT_MOBILE") {
    const mobile = body.replace(/\s+/g, "");

    if (!/^\+?\d{6,15}$/.test(mobile)) {
      return res.send(twiml(`❌ Invalid mobile number. Try again.`));
    }

    session.mobile = mobile;
    session.step = "WAIT_EMAIL";

    return res.send(twiml(`📧 Send your *email address*.`));
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
      await esimRequest("post", "/purchaseesim", { data: payload });

      resetSession(from);

      return res.send(
        twiml(`🎉 Your eSIM order is complete!\nDetails sent to *${email}*.`)
      );
    } catch (err) {
      console.error("Purchase error:", err.message);
      return res.send(
        twiml(`⚠️ Unable to complete order. Try again later.`)
      );
    }
  }

  // ---------------- FALLBACK ----------------
  return res.send(
    twiml(`😅 I got lost.\nType *menu* to restart.`)
  );
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 Backend running on port ${PORT}`);
});