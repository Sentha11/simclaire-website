// =====================================================
// server.js – FINAL VERSION with Rich WhatsApp UI
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
app.use(express.urlencoded({ extended: false })); // Twilio webhook uses form POST
app.use(express.json());

// -----------------------------------------------------
// QUOTAGUARD STATIC PROXY
// -----------------------------------------------------
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled");
  console.log("QUOTAGUARD_URL =", process.env.QUOTAGUARD_URL);
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
  console.warn("⚠️ Missing ESIM_BASE_URL / ESIM_USERNAME / ESIM_PASSWORD");
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
// FLAG EMOJI SYSTEM
// -----------------------------------------------------
function flagEmojiFromIso(iso) {
  if (!iso) return "";
  const code = iso.toUpperCase();
  return code.replace(/./g, (c) =>
    String.fromCodePoint(127397 + c.charCodeAt(0))
  );
}

const flagOverride = {
  "UNITED STATES": "🇺🇸",
  "UNITED STATES OF AMERICA": "🇺🇸",
  USA: "🇺🇸",
  US: "🇺🇸",
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
// CURRENCY DETECTION + FORMATTING (Option E)
// -----------------------------------------------------
function detectCurrencyForDestination(dest, products = []) {
  // 1) If any product exposes a currency field, use that
  const pWithCurrency = products.find(
    (p) => p.currency || p.currencyCode || p.productCurrency
  );
  if (pWithCurrency) {
    const code =
      pWithCurrency.currency ||
      pWithCurrency.currencyCode ||
      pWithCurrency.productCurrency;
    if (code) return code.toUpperCase();
  }

  // 2) Fallback by destination ISO
  const iso = (dest.isoCode || "").toUpperCase();
  const eurCountries = new Set([
    "FR","DE","ES","IT","NL","BE","PT","IE","FI","GR",
    "AT","LU","SI","SK","EE","LV","LT","CY","MT","HR"
  ]);

  if (iso === "GB" || iso === "UK") return "GBP";
  if (iso === "US" || iso === "USA") return "USD";
  if (iso === "CA") return "CAD";
  if (eurCountries.has(iso)) return "EUR";

  // 3) Global default
  return "USD";
}

function formatPrice(amount, currencyCode) {
  const value = Number(amount);
  if (Number.isNaN(value)) return "";

  const cur = (currencyCode || "USD").toUpperCase();
  let symbol = "$";

  switch (cur) {
    case "GBP":
      symbol = "£";
      break;
    case "EUR":
      symbol = "€";
      break;
    case "CAD":
      symbol = "C$";
      break;
    case "AUD":
      symbol = "A$";
      break;
    case "USD":
    default:
      symbol = "$";
      break;
  }

  return `${symbol}${value.toFixed(2)}`;
}

// -----------------------------------------------------
// BASIC API ROUTES (handy for testing with Thunder Client)
// -----------------------------------------------------
app.get("/api/status", (req, res) => {
  res.json({ ok: true, status: "backend running" });
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

// -----------------------------------------------------
// TwiML HELPER
// -----------------------------------------------------
function twiml(message) {
  // Keep it simple; WhatsApp supports emojis, *, newlines etc.
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
      step: "MENU", // MENU | WAIT_COUNTRY | CONFIRM_COUNTRY | WAIT_PLAN | CONFIRM_PLAN | WAIT_QTY | WAIT_MOBILE | WAIT_EMAIL
      country: null,
      destinationId: null,
      countryIso: null,
      products: [],
      currency: "USD",
      suggestedDestination: null,
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

// -----------------------------------------------------
// PRODUCT CARD FORMATTER (Option B style)
// -----------------------------------------------------
function formatProductCards(countryName, flag, products, currencyCode) {
  const lines = [];

  lines.push(
    `${flag ? flag + " " : ""}*${countryName} – Available Plans*`
  );
  lines.push("────────────────────────────");

  const top = products.slice(0, 5);

  const colorIcons = ["🟩", "🟦", "🟨", "🟪", "🟥"];

  top.forEach((p, idx) => {
    const label = idx + 1;
    const name =
      p.productName || p.productDisplayName || "Travel eSIM Plan";
    const data =
      p.productDataAllowance ||
      p.productData ||
      p.dataAllowance ||
      "Data bundle";
    const validity =
      p.productValidity || p.validityDays || p.validity || "";
    const rawPrice =
      p.productPrice != null ? p.productPrice : p.price != null ? p.price : null;
    const priceStr =
      rawPrice != null ? formatPrice(rawPrice, currencyCode) : "";

    const icon = colorIcons[idx % colorIcons.length];

    lines.push("");
    lines.push(`${icon} *PLAN ${label}*`);
    lines.push(`🌐 ${name}`);
    lines.push(`📶 ${data}`);
    if (validity) lines.push(`📅 ${validity} days`);
    if (priceStr) lines.push(`💵 ${priceStr}`);
    lines.push(`Reply with *${label}* to choose this plan.`);
    lines.push("────────────────────────────");
  });

  return lines.join("\n");
}

// -----------------------------------------------------
// WHATSAPP WEBHOOK (Twilio)
// -----------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.WaId || req.body.From || "unknown";
  const body = cleanText(req.body.Body || "");
  const lower = body.toLowerCase();
  const session = getSession(from);

  console.log("📲 Incoming WhatsApp:", {
    from,
    body,
    step: session.step,
  });

  // ------------- GLOBAL COMMANDS -------------
  if (["menu", "main"].includes(lower)) {
    resetSession(from);
    const msg = `👋 Welcome to SimClaire eSIMs 🌍

1️⃣ Browse eSIM plans  
2️⃣ Help & FAQ  
3️⃣ Contact support  

Reply with 1, 2, or 3.`;
    return res.send(twiml(msg));
  }

  if (["restart", "reset", "start over"].includes(lower)) {
    resetSession(from);
    const msg = `✅ Session reset.

👋 Welcome to SimClaire eSIMs 🌍

1️⃣ Browse eSIM plans  
2️⃣ Help & FAQ  
3️⃣ Contact support  

Reply with 1, 2, or 3.`;
    return res.send(twiml(msg));
  }

  try {
    // ------------- MENU -------------
    if (session.step === "MENU") {
      if (
        ["hi", "hello", "hey"].includes(lower) ||
        !["1", "2", "3"].includes(lower)
      ) {
        const msg = `👋 Welcome to SimClaire eSIMs 🌍  

I can help you instantly buy travel eSIMs.

1️⃣ Browse eSIM plans  
2️⃣ Help & FAQ  
3️⃣ Contact support  

Reply with 1, 2, or 3.`;
        return res.send(twiml(msg));
      }

      if (lower === "1") {
        session.step = "WAIT_COUNTRY";
        const msg = `🌍 Great! Let's find you a plan.

Please type the country you're travelling to.  
For example: Italy, USA, Japan, United Kingdom.`;
        return res.send(twiml(msg));
      }

      if (lower === "2") {
        const msg = `ℹ️ Help & FAQ  

* You’ll receive your eSIM details by email.  
* Scan or enter the activation code on your device.  
* Most eSIMs activate when you arrive at your destination.  

Type menu to go back.`;
        return res.send(twiml(msg));
      }

      if (lower === "3") {
        const msg = `📞 Support  

Email: support@simclaire.com  

Type menu to go back.`;
        return res.send(twiml(msg));
      }

      const msg = `❓ I didn't understand that.

Reply with:  
1️⃣ Browse eSIM plans  
2️⃣ Help & FAQ  
3️⃣ Contact support`;
      return res.send(twiml(msg));
    }

    // ------------- CONFIRM COUNTRY SUGGESTION -------------
    if (session.step === "CONFIRM_COUNTRY") {
      if (["yes", "y"].includes(lower) && session.suggestedDestination) {
        const chosen = session.suggestedDestination;
        session.suggestedDestination = null;

        // Continue as if they typed that country
        session.country = chosen.destinationName;
        session.destinationId = chosen.destinationID;
        session.countryIso = chosen.isoCode;
        const flag = getFlag(chosen);

        // Fetch products
        let productData;
        try {
          productData = await esimRequest(
            "get",
            `/products?destinationid=${encodeURIComponent(
              chosen.destinationID
            )}`
          );
        } catch (err) {
          console.error("❌ products error:", err.message);
          const msg = `⚠️ ${flag} We couldn't fetch plans for ${chosen.destinationName} right now.  

Please try again in a few minutes or type menu to go back.`;
          return res.send(twiml(msg));
        }

        const allProducts = Array.isArray(productData)
          ? productData
          : productData.data || [];

        const type1 = allProducts.filter(
          (p) => !p.productType || String(p.productType) === "1"
        );

        if (!type1.length) {
          const msg = `⚠️ ${flag} We currently don't have instant eSIMs available for ${chosen.destinationName}.  

You can try another destination or type menu to go back.`;
          session.step = "WAIT_COUNTRY";
          return res.send(twiml(msg));
        }

        session.products = type1;
        session.currency = detectCurrencyForDestination(chosen, type1);
        session.step = "WAIT_PLAN";

        const cards = formatProductCards(
          chosen.destinationName,
          flag,
          type1,
          session.currency
        );

        return res.send(twiml(cards));
      }

      if (["no", "n"].includes(lower)) {
        session.suggestedDestination = null;
        session.step = "WAIT_COUNTRY";
        const msg = `No problem.  

Please type the country name again, for example: Spain, USA, Japan.`;
        return res.send(twiml(msg));
      }

      const msg = `Please reply *YES* to confirm or *NO* to type the country again.`;
      return res.send(twiml(msg));
    }

    // ------------- COUNTRY SELECTION -------------
    if (session.step === "WAIT_COUNTRY") {
      let destList;
      try {
        const destData = await esimRequest("get", "/destinations");
        destList = Array.isArray(destData)
          ? destData
          : destData.data || [];
      } catch (err) {
        console.error("❌ destinations error:", err.message);
        const msg = `⚠️ We couldn't load destination list right now.  

Please try again shortly or type menu to go back.`;
        return res.send(twiml(msg));
      }

      if (!destList.length) {
        const msg = `⚠️ Destination list is currently empty.  

Please try again later or type menu to go back.`;
        return res.send(twiml(msg));
      }

      const input = lower;

      // 1) Exact match first
      let exactMatch = destList.find((d) => {
        const name = (d.destinationName || "").toLowerCase();
        const iso = (d.isoCode || "").toLowerCase();
        return name === input || iso === input;
      });

      if (exactMatch) {
        session.country = exactMatch.destinationName;
        session.destinationId = exactMatch.destinationID;
        session.countryIso = exactMatch.isoCode;
        const flag = getFlag(exactMatch);

        // Fetch products
        let productData;
        try {
          productData = await esimRequest(
            "get",
            `/products?destinationid=${encodeURIComponent(
              exactMatch.destinationID
            )}`
          );
        } catch (err) {
          console.error("❌ products error:", err.message);
          const msg = `⚠️ ${flag} We couldn't fetch plans for ${exactMatch.destinationName} right now.  

Please try again later or type menu to go back.`;
          return res.send(twiml(msg));
        }

        const allProducts = Array.isArray(productData)
          ? productData
          : productData.data || [];

        const type1 = allProducts.filter(
          (p) => !p.productType || String(p.productType) === "1"
        );

        if (!type1.length) {
          const msg = `⚠️ ${flag} We currently don't have instant eSIMs for ${exactMatch.destinationName}.  

You can try another country or type menu to go back.`;
          return res.send(twiml(msg));
        }

        session.products = type1;
        session.currency = detectCurrencyForDestination(
          exactMatch,
          type1
        );
        session.step = "WAIT_PLAN";

        const cards = formatProductCards(
          exactMatch.destinationName,
          flag,
          type1,
          session.currency
        );

        return res.send(twiml(cards));
      }

      // 2) Fuzzy match -> suggestion ("Did you mean…?")
      const candidates = destList.filter((d) => {
        const name = (d.destinationName || "").toLowerCase();
        return name.startsWith(input) || name.includes(input);
      });

      if (candidates.length === 1) {
        const candidate = candidates[0];
        const flag = getFlag(candidate);
        session.suggestedDestination = candidate;
        session.step = "CONFIRM_COUNTRY";

        const msg = `Did you mean: ${flag} ${candidate.destinationName}?  

Reply YES to confirm or NO to type another country.`;
        return res.send(twiml(msg));
      }

      // 3) No match
      const msg = `❌ I couldn't find that destination.  

Please type the country name again (e.g. Spain, USA, Japan),  
or type menu to go back.`;
      return res.send(twiml(msg));
    }

    // ------------- PLAN SELECTION (choose plan number) -------------
    if (session.step === "WAIT_PLAN") {
      const choice = parseInt(lower, 10);

      if (
        Number.isNaN(choice) ||
        choice < 1 ||
        choice > session.products.length
      ) {
        const msg = `❌ Invalid choice.  

Please reply with a number between 1 and ${session.products.length},  
or type menu to go back.`;
        return res.send(twiml(msg));
      }

      const product = session.products[choice - 1];
      session.selectedProduct = product;
      session.step = "CONFIRM_PLAN";

      const name =
        product.productName || product.productDisplayName || "Plan";
      const data =
        product.productDataAllowance ||
        product.productData ||
        product.dataAllowance ||
        "Data bundle";
      const validity =
        product.productValidity ||
        product.validityDays ||
        product.validity ||
        "";
      const rawPrice =
        product.productPrice != null
          ? product.productPrice
          : product.price != null
          ? product.price
          : null;
      const priceStr =
        rawPrice != null
          ? formatPrice(rawPrice, session.currency)
          : "";

      const msg = `✅ You selected:  

${name}  
📶 ${data}${validity ? `\n📅 ${validity} days` : ""}${
        priceStr ? `\n💵 ${priceStr}` : ""
      }

Do you want to continue?  
1️⃣ Yes  
2️⃣ No (show plans again)`;
      return res.send(twiml(msg));
    }

    // ------------- CONFIRM PLAN -------------
    if (session.step === "CONFIRM_PLAN") {
      if (lower === "1" || lower === "yes") {
        session.step = "WAIT_QTY";
        const msg = `📦 Great!  

How many eSIMs would you like?  
Reply with a number between 1 and 10.`;
        return res.send(twiml(msg));
      }

      if (lower === "2" || lower === "no") {
        // show products again
        session.step = "WAIT_PLAN";
        const dest = {
          destinationName: session.country,
          isoCode: session.countryIso,
        };
        const flag = getFlag(dest);
        const cards = formatProductCards(
          session.country,
          flag,
          session.products,
          session.currency
        );
        return res.send(twiml(cards));
      }

      const msg = `Please reply:  
1️⃣ Yes – continue  
2️⃣ No – see plans again`;
      return res.send(twiml(msg));
    }

    // ------------- QUANTITY -------------
    if (session.step === "WAIT_QTY") {
      const qty = parseInt(lower, 10);

      if (Number.isNaN(qty) || qty < 1 || qty > 10) {
        const msg = `❌ Please reply with a number between *1* and *10*.`;
        return res.send(twiml(msg));
      }

      session.quantity = qty;
      session.step = "WAIT_MOBILE";

      const msg = `📱 Great — ${qty} eSIM(s).  

Please send your mobile number including country code.  
Example: *+44 7123 456789*`;
      return res.send(twiml(msg));
    }

    // ------------- MOBILE NUMBER -------------
    if (session.step === "WAIT_MOBILE") {
      const mobile = body.replace(/\s+/g, "");
      if (!/^\+?\d{6,15}$/.test(mobile)) {
        const msg = `❌ That doesn't look like a valid number.  

Please send your mobile number including country code.  
Example: *+44 7123 456789*`;
        return res.send(twiml(msg));
      }

      session.mobile = mobile;
      session.step = "WAIT_EMAIL";

      const msg = `📧 Almost done!  

Please send your *email address* so we can send your eSIM details.`;
      return res.send(twiml(msg));
    }

    // ------------- EMAIL + PURCHASE -------------
    if (session.step === "WAIT_EMAIL") {
      const email = body.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        const msg = `❌ That doesn't look like a valid email.  

Please send a valid email address, for example: *name@example.com*`;
        return res.send(twiml(msg));
      }

      session.email = email;

      const product = session.selectedProduct;
      if (!product) {
        const msg = `⚠️ Something went wrong with your selected plan.  

Please type *menu* to start again.`;
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
        const purchaseRes = await esimRequest(
          "post",
          "/purchaseesim",
          { data: payload }
        );

        const esimInfo = Array.isArray(purchaseRes.esims)
          ? purchaseRes.esims[0]
          : purchaseRes.esims?.[0];

        let msg;
        if (esimInfo?.activationcode) {
          msg = `🎉 Your eSIM order is complete!  

Destination: *${session.country}*  
Quantity: *${session.quantity}*  

Your activation code (LPA):  
\`\`\`
${esimInfo.activationcode}
\`\`\`

We’ve also emailed full details to *${session.email}*.  

If you need installation help, type help.`;
        } else {
          msg = `✅ Your order has been received.  

We couldn't automatically retrieve the activation code,  
but our team will email full eSIM details to *${session.email}* shortly.  

If you don't see it, check spam or type *support*.`;
        }

        resetSession(from);
        return res.send(twiml(msg));
      } catch (err) {
        console.error("❌ Purchase error:", err.message);
        const msg = `⚠️ There was an issue processing your order.  

No payment will be taken. Please try again later or type *support* for help.`;
        return res.send(twiml(msg));
      }
    }

    // ------------- FALLBACK -------------
    const fallback = `😅 I got a bit lost.  

Type *menu* to go back to the main menu,  
or *restart* to start again.`;
    return res.send(twiml(fallback));
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    const msg = `⚠️ Something went wrong on our side.  

Please try again in a moment or type *menu* to restart.`;
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