// =====================================================
// server.js – CLEAN FINAL VERSION
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
app.use(express.urlencoded({ extended: false })); // For Twilio webhook (form POST)
app.use(express.json());

// -----------------------------------------------------
// QUOTAGUARD STATIC PROXY
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
// ESIM ENV
// -----------------------------------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  console.warn("⚠️ Missing eSIM environment variables.");
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

  console.log("🔐 eSIM token refreshed.");
  return esimToken;
}

// -----------------------------------------------------
// GENERIC ESIM REQUEST WRAPPER
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
      console.error("❌ API:", err.response.data);
    }
    throw err;
  }
}

// -----------------------------------------------------
// FLAG EMOJI SYSTEM
// -----------------------------------------------------
function flagEmojiFromIso(iso) {
  if (!iso) return "";
  const code = iso.toUpperCase();
  return code.replace(/./g, c =>
    String.fromCodePoint(127397 + c.charCodeAt(0))
  );
}

const flagOverride = {
  "UNITED STATES OF AMERICA": "🇺🇸",
  "UNITED STATES": "🇺🇸",
  USA: "🇺🇸",
  UK: "🇬🇧",
  "UNITED KINGDOM": "🇬🇧",
  UAE: "🇦🇪",
};

function getFlag(dest) {
  const name = (dest.destinationName || "").toUpperCase();
  const iso = (dest.isoCode || "").toUpperCase();
  return flagOverride[name] || flagOverride[iso] || flagEmojiFromIso(iso);
}

// -----------------------------------------------------
// QUICK API ROUTES
// -----------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({ status: "OK", backend: "running" });
});

app.get("/api/test-auth", async (req, res) => {
  try {
    const token = await getEsimToken();
    res.json({ ok: true, token });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
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
  const { destinationid } = req.query;
  if (!destinationid)
    return res.status(400).json({ error: "destinationid required" });

  try {
    const data = await esimRequest(
      "get",
      `/products?destinationid=${encodeURIComponent(destinationid)}`
    );
    res.json(data);
  } catch {
    res.status(500).json({ error: "Cannot fetch products" });
  }
});

// -----------------------------------------------------
// WHATSAPP TWILIO WEBHOOK
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

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = {
      step: "MENU",
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
  return sessions[id];
}

function resetSession(id) {
  delete sessions[id];
}

function clean(t) {
  return (t || "").trim();
}

// Format product list UI
function formatPlans(country, flag, products) {
  let msg = `${flag} Here are top plans for *${country}*:\n\n`;

  products.slice(0, 5).forEach((p, i) => {
    const name = p.productName || "Plan";
    const data = p.productDataAllowance || p.productData || "Data";
    const validity = p.productValidity || "";
    const price =
      p.productPrice != null
        ? `£${p.productPrice}`
        : p.price != null
        ? `£${p.price}`
        : "";

    msg += `*${i + 1}) ${name}*\n`;
    msg += `   💾 ${data}\n`;
    if (validity) msg += `   📅 ${validity} days\n`;
    if (price) msg += `   💵 ${price}\n`;
    msg += "\n";
  });

  msg += `Reply with *1–${products.length}* to choose a plan.\nType *menu* to restart.`;
  return msg;
}

// -----------------------------------------------------
// WHATSAPP ROUTE
// -----------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From || "unknown";
  const body = clean(req.body.Body);
  const lower = body.toLowerCase();

  const session = getSession(from);
  console.log("📲 WhatsApp:", { from, body, step: session.step });

  // GLOBAL COMMANDS
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
        `🔄 Session restarted.

1) Browse eSIM plans
2) Help & FAQ
3) Contact support`
      )
    );
  }

  try {
    // -----------------------------------------------------
    // MENU
    // -----------------------------------------------------
    if (session.step === "MENU") {
      if (["1", "2", "3"].includes(lower) === false) {
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
          twiml(
            `🌍 Great! Which country are you travelling to?

Example: USA, Italy, Japan, Turkey, Spain.`
          )
        );
      }

      if (lower === "2") {
        return res.send(
          twiml(
            `ℹ️ FAQ

* You receive eSIM via email.
* Install by scanning QR code.
* Most plans activate on arrival.

Type menu to go back.`
          )
        );
      }

      if (lower === "3") {
        return res.send(
          twiml(`📞 Support: support@simclaire.com\nType *menu* to return.`)
        );
      }
    }

    // -----------------------------------------------------
    // COUNTRY
    // -----------------------------------------------------
    if (session.step === "WAIT_COUNTRY") {
      const destData = await esimRequest("get", "/destinations");

      const list = Array.isArray(destData)
        ? destData
        : destData.data || [];

      const match = list.find(d => {
        const name = (d.destinationName || "").toLowerCase();
        const iso = (d.isoCode || "").toLowerCase();
        return (
          name === lower || iso === lower || name.includes(lower)
        );
      });

      if (!match) {
        return res.send(
          twiml(
            `❌ Country not found.

Please type country again (e.g. Spain, USA, Japan).`
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
            `⚠️ ${flag} No instant eSIMs available for ${match.destinationName}.

Try another country or type menu.`
          )
        );
      }

      session.products = products;

      return res.send(
        twiml(formatPlans(session.country, flag, products))
      );
    }

    // -----------------------------------------------------
    // PLAN
    // -----------------------------------------------------
    if (session.step === "WAIT_PLAN") {
      const num = parseInt(lower);
      if (Number.isNaN(num) || num < 1 || num > session.products.length) {
        return res.send(
          twiml(
            `❌ Invalid choice. Reply with a number *1–${session.products.length}*.`
          )
        );
      }

      session.selectedProduct = session.products[num - 1];
      session.step = "WAIT_QTY";

      return res.send(
        twiml(
          `📦 How many eSIMs would you like?\nReply with *1–10*.`
        )
      );
    }

    // -----------------------------------------------------
    // QTY
    // -----------------------------------------------------
    if (session.step === "WAIT_QTY") {
      const qty = parseInt(lower);
      if (Number.isNaN(qty) || qty < 1 || qty > 10) {
        return res.send(twiml(`❌ Enter a number between 1–10.`));
      }

      session.quantity = qty;
      session.step = "WAIT_MOBILE";

      return res.send(
        twiml(
          `📱 Enter your *mobile number* including country code.\nExample: *+44 7123 456789*.`
        )
      );
    }

    // -----------------------------------------------------
    // MOBILE
    // -----------------------------------------------------
    if (session.step === "WAIT_MOBILE") {
      const mobile = body.replace(/\s+/g, "");
      if (!/^\+?\d{6,15}$/.test(mobile)) {
        return res.send(
          twiml(
            `❌ Invalid number. Please send correct mobile number with country code.`
          )
        );
      }

      session.mobile = mobile;
      session.step = "WAIT_EMAIL";

      return res.send(
        twiml(`📧 Great! Now send your *email address*.`)
      );
    }

    // -----------------------------------------------------
    // EMAIL + PURCHASE
    // -----------------------------------------------------
    if (session.step === "WAIT_EMAIL") {
      const email = body.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.send(twiml(`❌ Invalid email. Please try again.`));
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

        resetSession(from);

        return res.send(
          twiml(
            `🎉 Your eSIM order is complete!\n\nDetails sent to *${email}*.\n\nIf you need help, type *support*.`
          )
        );
      } catch (err) {
        console.error("Purchase error:", err.message);
        return res.send(
          twiml(`⚠️ We could not complete your order. Try again later.`)
        );
      }
    }

    // -----------------------------------------------------
    // FALLBACK
    // -----------------------------------------------------
    return res.send(
      twiml(
        `😅 I got lost.\nType *menu* to return to the main menu.`
      )
    );
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    return res.send(
      twiml(
        `⚠️ Something went wrong.\nTry again or type *menu*.`
      )
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