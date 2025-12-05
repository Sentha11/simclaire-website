// =====================================================
// server.js – FINAL VERSION (WhatsApp + ESIM + QuotaGuard)
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
app.use(express.urlencoded({ extended: false })); // Twilio webhook sends form data
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
// ESIM ENV VARS
// -----------------------------------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL; // e.g. https://uat.esim-api.com/api/esim
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
  const ttlSeconds = res.data.expirySeconds || 600; // default 10 min
  esimTokenExpiresAt = now + ttlSeconds * 1000;

  console.log("🔐 eSIM token refreshed.");
  return esimToken;
}

// -----------------------------------------------------
// GENERIC ESIM API WRAPPER
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
      console.error("❌ esimRequest response data:", err.response.data);
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
  "UNITED STATES OF AMERICA": "🇺🇸",
  "UNITED STATES": "🇺🇸",
  USA: "🇺🇸",
  "UNITED KINGDOM": "🇬🇧",
  UK: "🇬🇧",
  UAE: "🇦🇪",
};

function getFlag(dest) {
  const name = (dest.destinationName || "").toUpperCase();
  const iso = (dest.isoCode || "").toUpperCase();
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
// BASIC API ROUTES (for Postman / frontend)
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
        type: "1", // no-KYC productType
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
// WHATSAPP FLOW
// -----------------------------------------------------

// In-memory sessions
const sessions = {};

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = {
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
  return sessions[id];
}

function resetSession(id) {
  delete sessions[id];
}

function cleanText(t) {
  return (t || "").trim();
}

// Semi-rich product cards (Option 2)
function formatProductCards(countryName, flag, products) {
  let msg = `${flag ? flag + " " : ""}Here are eSIM plans for *${countryName}*:\n\n`;

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

    msg += `────────────────\n`;
    msg += `*${label}) ${name}*\n`;
    msg += `💾 ${data}\n`;
    if (validity) msg += `📅 ${validity} days\n`;
    if (price) msg += `💵 ${price}\n\n`;
  });

  msg += `Reply with *1–${top.length}* to choose a plan.\n`;
  msg += `Type *menu* to go back to the main menu.`;
  return msg;
}

// WhatsApp webhook: set this URL in Twilio
// e.g. https://simclaire-website-backend.onrender.com/webhook/whatsapp
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From || "unknown";
  const body = cleanText(req.body.Body || "");
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

  if (["restart", "reset", "start over"].includes(lower)) {
    resetSession(from);
    return res.send(
      twiml(
        `✅ Session reset.

👋 Welcome to SimClaire eSIMs 🌍

1) Browse eSIM plans
2) Help & FAQ
3) Contact support

Reply with 1, 2, or 3.`
      )
    );
  }

  try {
    // ------------- MENU STATE -------------
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

Please type the country you're travelling to.
Example: Italy, USA, Japan, United Kingdom.`
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

Type menu to go back or 1 to browse plans.`
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
            `⚠️ We couldn't load destinations right now.

Please try again in a few minutes or type menu to go back.`
          )
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

Please type the country name again (e.g. Spain, USA, Japan),
or type menu to go back.`
          )
        );
      }

      const flag = getFlag(match);
      session.country = match.destinationName;
      session.destinationId = match.destinationID;
      session.countryIso = match.isoCode;
      session.step = "WAIT_PLAN";

      let productsRaw;
      try {
        productsRaw = await esimRequest(
          "get",
          `/products?destinationid=${encodeURIComponent(
            match.destinationID
          )}`
        );
      } catch (err) {
        console.error("❌ products error:", err.message);
        return res.send(
          twiml(
            `⚠️ ${flag} We couldn't fetch plans for ${match.destinationName} right now.

Please try again shortly or type menu to go back.`
          )
        );
      }

      const allProducts = Array.isArray(productsRaw)
        ? productsRaw
        : productsRaw.data || [];

      // Filter to no-KYC (productType 1) if productType is present
      const products = allProducts.filter(
        (p) => !p.productType || String(p.productType) === "1"
      );

      if (!products.length) {
        return res.send(
          twiml(
            `⚠️ ${flag} We currently don't have instant eSIMs for ${match.destinationName}.

You can try another country, or type menu to go back.`
          )
        );
      }

      session.products = products;

      const msg = formatProductCards(session.country, flag, products);
      return res.send(twiml(msg));
    }

    // ------------- PLAN -------------
    if (session.step === "WAIT_PLAN") {
      const choice = parseInt(lower, 10);

      if (
        Number.isNaN(choice) ||
        choice < 1 ||
        choice > session.products.length
      ) {
        return res.send(
          twiml(
            `❌ Please reply with a number between *1* and *${session.products.length}* to choose a plan.
          `)
        );
      }

      session.selectedProduct = session.products[choice - 1];
      session.step = "WAIT_QTY";

      return res.send(
        twiml(
          `📦 Great choice.

How many eSIMs do you need?
Reply with a number between 1 and 10.`
        )
      );
    }

    // ------------- QUANTITY -------------
    if (session.step === "WAIT_QTY") {
      const qty = parseInt(lower, 10);

      if (Number.isNaN(qty) || qty < 1 || qty > 10) {
        return res.send(
          twiml(
            `❌ Please reply with a number between *1* and *10* for how many eSIMs you need.
          `)
        );
      }

      session.quantity = qty;
      session.step = "WAIT_MOBILE";

      return res.send(
        twiml(
          `📱 Perfect — ${qty} eSIM(s).

Please send your mobile number including country code.
Example: +44 7123 456789.`
        )
      );
    }

    // ------------- MOBILE -------------
    if (session.step === "WAIT_MOBILE") {
      const mobile = body.replace(/\s+/g, "");

      if (!/^\+?\d{6,15}$/.test(mobile)) {
        return res.send(
          twiml(
            `❌ That doesn't look like a valid number.

Please send your mobile number with country code.
Example: +44 7123 456789.`
          )
        );
      }

      session.mobile = mobile;
      session.step = "WAIT_EMAIL";

      return res.send(
        twiml(
          `📧 Great — now send your *email address* so we can send your eSIM details.
        `)
      );
    }

    // ------------- EMAIL + PURCHASE -------------
    if (session.step === "WAIT_EMAIL") {
      const email = body.trim();

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.send(
          twiml(
            `❌ That doesn't look like a valid email.

Please send a valid email address.
Example: name@example.com.`
          )
        );
      }

      session.email = email;

      const product = session.selectedProduct;
      if (!product) {
        resetSession(from);
        return res.send(
          twiml(
            `⚠️ Something went wrong with your selected plan.

Type menu to start again.`
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

        const esimInfo = Array.isArray(purchase.esims)
          ? purchase.esims[0]
          : purchase.esims?.[0];

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

We couldn't automatically retrieve your activation code, but your eSIM details will be emailed to:
${session.email} shortly.

If you don't see it, check your spam folder or reply support.`;
        }

        resetSession(from);
        return res.send(twiml(msg));
      } catch (err) {
        console.error("❌ Purchase error:", err.message);
        return res.send(
          twiml(
            `⚠️ There was an issue processing your order.

No payment will be taken. Please try again later or type support for help.`
          )
        );
      }
    }

    // ------------- FALLBACK -------------
    return res.send(
      twiml(
        `😅 I got a bit lost.

Type menu to go back to the main menu, or restart to start again.`
      )
    );
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    return res.send(
      twiml(
        `⚠️ Something went wrong on our side.

Please try again in a moment or type menu to start over.`
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