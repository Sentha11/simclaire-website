// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -----------------------------
// ENV
// -----------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  console.warn("⚠️ Missing eSIM API environment variables");
}

// -----------------------------
// Token cache
// -----------------------------
let esimToken = null;
let esimTokenExpiresAt = 0;

async function getEsimToken() {
  const now = Date.now();
  if (esimToken && now < esimTokenExpiresAt) {
    return esimToken;
  }

  const url = '${ESIM_BASE_URL}/authenticate';

  const res = await axios.post(url, {
    userName: ESIM_USERNAME,
    password: ESIM_PASSWORD,
  });

  esimToken = res.data.token;
  const ttlSeconds = res.data.expirySeconds || 600;
  esimTokenExpiresAt = now + ttlSeconds * 1000;

  console.log("🔐 eSIM token refreshed");
  return esimToken;
}

async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const url = '${ESIM_BASE_URL}${path}';

  try {
    const res = await axios({
      method,
      url,
      headers: {
        Authorization: 'Bearer ${token'},
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    );

    return res.data;
  } catch (err) {
    // Retry on 401
    if (err.response && err.response.status === 401) {
      esimToken = null;
      const newToken = await getEsimToken();
      return (
        await axios({
          method,
          url,
          headers: {
            Authorization: 'Bearer ${newToken}',
            "Content-Type": "application/json",
            ...(options.headers || {}),
          },
          ...options,
        })
      ).data;
    }

    throw err;
  }
}

// -----------------------------
// Simple health check
// -----------------------------
app.get("/api/status", (req, res) => {
  res.json({ status: "OK", message: "Backend is running" });
});

// -----------------------------
// Destinations
// -----------------------------
app.get("/api/esim/destinations", async (req, res) => {
  try {
    const data = await esimRequest("get", "/destinations");
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch destinations" });
  }
});

// -----------------------------
// Products for destination
// -----------------------------
app.get("/api/esim/products", async (req, res) => {
  const { destinationid } = req.query;
  if (!destinationid) {
    return res.status(400).json({ error: "destinationid is required" });
  }

  try {
    const data = await esimRequest(
      "get",
      '/products?destinationid=${encodeURIComponent(destinationid)}'
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// -----------------------------
// Purchase eSIM (no-KYC productType=1)
// -----------------------------
app.post("/api/esim/purchase", async (req, res) => {
  const { sku, quantity, mobileno, emailid } = req.body;

  if (!sku || !quantity || !mobileno || !emailid) {
    return res.status(400).json({
      error: "sku, quantity, mobileno, and emailid are required",
    });
 }

  try {
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

    const data = await esimRequest("post", "/purchaseesim", { data: payload });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to purchase eSIM" });
  }
});

    // -----------------------------
    // TEST AUTH ENDPOINT
    // -----------------------------
    app.get('/api/test-auth', async (req, res) => {
      try {
        const token = await getEsimToken();
        res.json({ ok: true, token });
      } catch (err) {
        res.status(500).json({
        ok: false,
        error: err.response?.data || err.message,
      });
    }
  });

// ======================================================
// ========== WHATSAPP AUTOMATION SECTION ===============
// ======================================================

// TwiML helper
function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${message}</Message>
</Response>`;
}

// Simple session store
const sessions = {};

function cleanText(t) {
  return (t || "").trim();
}

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      step: "START",
      country: null,
      destinationId: null,
      products: [],
      selectedProduct: null,
      quantity: 1,
      mobile: null,
      email: null,
    };
  }
  return sessions[userId];
}

app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.WaId || req.body.From || "unknown";
  const body = cleanText(req.body.Body);
  const session = getSession(from);

  console.log("📲 Incoming WhatsApp:", { from, body, step: session.step });

  try {
    // Reset
    if (/^(restart|reset|start over)$/i.test(body)) {
      sessions[from] = null;
      return res
        .set("Content-Type", "text/xml")
        .send(
          twiml(
            `Okay, let's start again. 🌍

Where are you travelling?
Reply with the country name.`
          )
        );
    }

    // START
    if (session.step === "START") {
      session.step = "WAIT_COUNTRY";
      return res
        .set("Content-Type", "text/xml")
        .send(
          twiml(
            `👋 Welcome to SimClaire eSIMs!
            
Where are you travelling today?`
          )
        );
    }

    // COUNTRY
    if (session.step === "WAIT_COUNTRY") {
      const countryInput = body.toLowerCase();
      const destinations = await esimRequest("get", "/destinations");

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
        const msg = "I couldn't find that destiantion. PLease reply with a valid country name.";
        res.set("Content-Type", "text/xml");
        return res.send(twiml(msg));
      }

      session.country = matched.destinationName;
      session.destinationId = matched.destinationID;

      const products = await esimRequest(
        "get",
        `/products?destinationid=${encodeURIComponent(
          matched.destinationID
        )}`
      );

      const type1 = products.filter((p) => String(p.productType) === "1");

      if (!type1.length) {
        return res
          .set("Content-Type", "text/xml")
          .send(
            twiml(
              "We don't have instant eSIMs for ${matched.destinationName} right now. Try another country."
            )
          );
      }

      session.products = type1.slice(0, 5);
      session.step = "WAIT_PLAN";

      let plansText = session.products
  .map((p, idx) => {
    const data = p.productDataAllowance || p.productName || "";
    const validity = p.productValidity ? '${p.productValidity} days' : "";
    const price = p.productPrice != null ? '£${p.productPrice}' : "";
    return '${idx + 1}) ${data} ${validity} ${price}';
  })
  .join("\n");

      return res
        .set("Content-Type", "text/xml")
        .send(
          twiml(
            `You're travelling to ${matched.destinationName} 🌍

Here are the plans:

${plansText}

Reply with 1, 2, 3… to choose.`
          )
        );
    }

    // PLAN
    if (session.step === "WAIT_PLAN") {
      const choice = parseInt(body, 10);
      if (
        Number.isNaN(choice) ||
        choice < 1 ||
        choice > session.products.length
      ) {
        return res
          .set("Content-Type", "text/xml")
          .send(
            twiml(
              'Please reply with a number between 1 and ${session.products.length}.'
            )
          );
      }

      session.selectedProduct = session.products[choice - 1];
      session.step = "WAIT_QTY";

      return res
        .set("Content-Type", "text/xml")
        .send(
          twiml(
            `Great choice!

How many eSIMs do you need?`
          )
        );
    }

    // QTY
    if (session.step === "WAIT_QTY") {
      const qty = parseInt(body, 10);
      if (Number.isNaN(qty) || qty < 1 || qty > 10) {
        return res
          .set("Content-Type", "text/xml")
          .send(
            twiml('Please reply with a quantity between 1 and 10.')
          );
      }

      session.quantity = qty;
      session.step = "WAIT_MOBILE";

      return res
        .set("Content-Type", "text/xml")
        .send(
          twiml(
            'Perfect. Send your mobile number (with country code).'
          )
        );
    }

    // MOBILE
    if (session.step === "WAIT_MOBILE") {
      const mobile = body.replace(/\s+/g, "");
      if (!/^\+?\d{6,15}$/.test(mobile)) {
        return res
          .set("Content-Type", "text/xml")
          .send(
            twiml('Please send a valid number including country code.')
          );
      }

      session.mobile = mobile;
      session.step = "WAIT_EMAIL";

      return res
        .set("Content-Type", "text/xml")
        .send(twiml("Great — now send your email address."));
    }

    // EMAIL
    if (session.step === "WAIT_EMAIL") {
      const email = body;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res
          .set("Content-Type", "text/xml")
          .send(twiml("Send a valid email address."));
      }

      session.email = email;
      session.step = "COMPLETE";

      // PURCHASE
      const p = session.selectedProduct;

      const payload = {
        items: [
          {
            type: "1",
            sku: p.productSku,
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

        const esimInfo = purchase.esims?.[0] || null;

        let message = "";

        if (esimInfo?.activationcode) {
          message = `🎉 Your eSIM order is complete!

Activation Code:
${esimInfo.activationcode}

We've also emailed the details to ${session.email}.`;
        } else {
          message = "Your order was received. We will email your eSIM shortly.";
        }

        sessions[from] = null;

        return res
          .set("Content-Type", "text/xml")
          .send(twiml("message"));
      } catch (err) {
        console.error("Purchase error:", err);
        return res
          .set("Content-Type", "text/xml")
          .send(
            twiml(
              "Something went wrong while processing your order. Try again later."
            )
          );
      }
    }

    // FALLBACK
    return res
      .set("Content-Type", "text/xml")
      .send(twiml("I got confused 😅 — reply \"restart\" to start again."));
  } catch (err) {
    console.error("Webhook error:", err);
    return res
      .set("Content-Type", "text/xml")
      .send(twiml("Something went wrong — try again."));
  }
});

// -----------------------------
// START SERVER
// -----------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('🔥 Backend running on port ${PORT}');
});
