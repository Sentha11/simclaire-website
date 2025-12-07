// =====================================================
// server.js – SimClaire Backend (ESIM + WhatsApp + Stripe + Admin API)
// FINAL VERSION — Twilio Init + Stripe + eSIM + Proxy + Purchase Flow
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const twilio = require("twilio");

const app = express();

// =====================================================
// BASE URL + AXIOS DEFAULTS
// =====================================================
const APP_BASE_URL =
  process.env.APP_BASE_URL ||
  "https://simclaire-website-backend.onrender.com";

axios.defaults.baseURL = APP_BASE_URL;

// =====================================================
// MIDDLEWARE ORDER
// =====================================================
app.use(cors());

// =====================================================
// TWILIO CLIENT INIT (GLOBAL)
// =====================================================
let twilioClient = null;

if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log("📞 Twilio client enabled");
} else {
  console.warn("⚠️ Twilio disabled (missing SID or AUTH TOKEN)");
}

// =====================================================
// WHATSAPP / TWILIO URLENCODED HANDLER
// =====================================================
app.use(express.urlencoded({ extended: false }));

// =====================================================
// STRIPE INIT — RAW BODY FOR WEBHOOKS (REQUIRED)
// =====================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
} else {
  console.warn("⚠️ Stripe disabled (missing STRIPE_SECRET_KEY)");
}

// =====================================================
// STRIPE WEBHOOK — PAYMENT COMPLETED
// =====================================================
if (stripe && process.env.STRIPE_WEBHOOK_SECRET) {
  app.post(
    "/webhook/stripe",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const sig = req.headers["stripe-signature"];
      let event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error("❌ Stripe webhook signature error:", err.message);
        return res.status(400).send("Webhook Error");
      }

      // -------------------------------------------------
      // PAYMENT SUCCESS — PURCHASE PRODUCT + SEND WHATSAPP
      // -------------------------------------------------
      if (event.type === "checkout.session.completed") {
        const sessionObj = event.data.object;
        const meta = sessionObj.metadata || {};

        const amount = (sessionObj.amount_total / 100).toFixed(2);
        const currency = (sessionObj.currency || "GBP").toUpperCase();
        let symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";

        let purchaseResult = null;

        // PURCHASE ESIM
        try {
          const sku = meta.productSku;
          const qty = parseInt(meta.quantity || "1", 10) || 1;
          const type = meta.productType;

          if (!sku) console.error("❌ Missing productSku in metadata");
          else if (!type) console.error("❌ Missing productType in metadata");
          else {
            purchaseResult = await purchaseEsim({
              sku,
              quantity: qty,
              type: String(type),
            });
            console.log("✅ purchaseEsim response:", purchaseResult);
          }
        } catch (err) {
          console.error("❌ Error calling purchaseEsim:", err.response?.data || err.message);
        }

        // BUILD WHATSAPP MESSAGE
        try {
          let msg = `
🎉 Payment Successful!

${meta.flagEmoji || "📶"} ${meta.country || ""} — ${meta.planName || ""}
💾 ${meta.data || ""}
💵 ${symbol}${amount} Paid

🧾 Stripe Receipt: ${sessionObj.id}
📧 ${sessionObj.customer_details?.email || meta.email || ""}
`;

          if (purchaseResult?.transactionId)
            msg += `\n🆔 eSIM Transaction ID: ${purchaseResult.transactionId}`;

          if (purchaseResult?.activationCode)
            msg += `\n🔐 Activation Code: ${purchaseResult.activationCode}`;

          if (purchaseResult?.statusmsg)
            msg += `\n📣 Status: ${purchaseResult.statusmsg}`;

          msg += `\n\nYour official eSIM email with QR will arrive shortly.`;

          // SEND WHATSAPP CONFIRMATION
          if (twilioClient && meta.whatsappTo && process.env.TWILIO_WHATSAPP_FROM) {
            await twilioClient.messages.create({
              from: process.env.TWILIO_WHATSAPP_FROM,
              to: meta.whatsappTo,
              body: msg.trim(),
            });
            console.log("✅ WhatsApp confirmation sent");
          } else {
            console.log(
              "ℹ️ Skipping WhatsApp send (missing meta.whatsappTo or Twilio config)"
            );
          }
        } catch (err) {
          console.error("❌ Error sending WhatsApp:", err);
        }
      }

      res.json({ received: true });
    }
  );
} else {
  console.warn("⚠️ Stripe webhook disabled (missing STRIPE_WEBHOOK_SECRET)");
}

// =====================================================
// JSON PARSER FOR NORMAL ROUTES
// =====================================================
app.use(express.json());

// =====================================================
// QUOTAGUARD STATIC IP PROXY
// =====================================================
let proxyAgent = null;
if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled");
}

// =====================================================
// ESIM API AUTH + WRAPPER
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

let esimToken = null;
let esimExpiresAt = 0;

async function getEsimToken() {
  if (esimToken && Date.now() < esimExpiresAt) return esimToken;

  const res = await axios.post(
    `${ESIM_BASE_URL}/authenticate`,
    { userName: ESIM_USERNAME, password: ESIM_PASSWORD },
    { httpsAgent: proxyAgent, proxy: false }
  );

  esimToken = res.data.token;
  esimExpiresAt = Date.now() + (res.data.expirySeconds || 600) * 1000;

  return esimToken;
}

async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();

  try {
    const result = await axios({
      method,
      url: `${ESIM_BASE_URL}${path}`,
      httpsAgent: proxyAgent,
      proxy: false,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...options,
    });

    return result.data;
  } catch (err) {
    console.error("❌ ESIM request error:", err.response?.data || err);
    throw err;
  }
}

// PURCHASE ESIM
async function purchaseEsim({ sku, quantity, type }) {
  const body = { items: [{ sku, quantity, type }] };

  console.log("➡️ Calling /purchaseesim with:", body);
  return await esimRequest("post", "/purchaseesim", { data: body });
}

// =====================================================
// Twilio XML SAFE RESPONSE
// =====================================================
function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function twiml(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
    msg || ""
  )}</Message></Response>`;
}

// =====================================================
// SESSION SYSTEM
// =====================================================
const sessions = {};

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = {
      started: false,
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

// =====================================================
// TEST ESIM ENDPOINT
// =====================================================
app.get("/test-esim", async (req, res) => {
  try {
    const token = await getEsimToken();
    const data = await esimRequest("get", "/destinations");

    return res.json({
      ok: true,
      token: token ? "VALID" : "MISSING",
      destinations: Array.isArray(data?.data) ? data.data.slice(0, 5) : data,
    });
  } catch (err) {
    return res.json({
      ok: false,
      error: err.response?.data || err.message,
    });
  }
});

// =====================================================
// DEBUG — GET PRODUCTS
// =====================================================
app.get("/debug/products", async (req, res) => {
  try {
    const id = req.query.destinationid;
    if (!id) return res.json({ error: "destinationid is required" });

    const data = await esimRequest("get", `/products?destinationid=${id}`);
    const products = Array.isArray(data?.data) ? data.data : data;

    return res.json({
      ok: true,
      count: Array.isArray(products) ? products.length : 0,
      products,
    });
  } catch (err) {
    return res.json({
      ok: false,
      error: err.response?.data || err.message,
    });
  }
});
  // =====================================================
// STRIPE CHECKOUT SESSION ROUTE
// =====================================================
app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
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
      metadata,
    } = req.body;

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      success_url: `${APP_BASE_URL}/success`,
      cancel_url: `${APP_BASE_URL}/cancel`,
      line_items: [
        {
          quantity,
          price_data: {
            currency: currency || "gbp",
            unit_amount: Math.round(price * 100),
            product_data: { name: planName },
          },
        },
      ],
      metadata: {
        planName,
        productSku,
        productType: String(productType),
        data,
        validity,
        quantity,
        email,
        mobile,
        country,
        whatsappTo: metadata?.whatsappTo || "",
        flagEmoji: metadata?.flagEmoji || "",
      },
    });

    return res.json({ id: checkout.id, url: checkout.url });
  } catch (err) {
    console.error("❌ Stripe checkout error:", err.message);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

// =====================================================
// SUCCESS / CANCEL PAGES
// =====================================================
app.get("/success", (req, res) =>
  res.send("<h1>Payment Successful ✔️</h1>You may now return to WhatsApp.")
);

app.get("/cancel", (req, res) =>
  res.send("<h1>Payment Cancelled ❌</h1>You may retry from WhatsApp.")
);

// =====================================================
// WHATSAPP WEBHOOK — FULL FLOW (MENU → COUNTRY → PLAN → QTY → MOBILE → EMAIL → STRIPE)
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const from = req.body.WaId || req.body.From?.replace("whatsapp:", "");
    const rawBody = req.body.Body || "";
    const text = rawBody.trim().toLowerCase();
    const session = getSession(from);

    // -------------------------------------------------
    // AUTO SHOW MENU ON FIRST MESSAGE
    // -------------------------------------------------
    if (!session.started) {
      session.started = true;
      session.step = "MENU";
      return res.send(
        twiml(
          "👋 Welcome to SimClaire!\n\n1) Browse plans\n2) FAQ\n3) Support\n\nReply with a number:"
        )
      );
    }

    // -------------------------------------------------
    // USER REQUESTS MENU EXPLICITLY
    // -------------------------------------------------
    if (["menu", "main"].includes(text)) {
      resetSession(from);
      const fresh = getSession(from);
      fresh.started = true;
      fresh.step = "MENU";
      return res.send(
        twiml(
          "👋 Main Menu:\n\n1) Browse plans\n2) FAQ\n3) Support\n\nReply with a number:"
        )
      );
    }

    // -------------------------------------------------
    // MENU HANDLER
    // -------------------------------------------------
    if (session.step === "MENU") {
      if (text === "1") {
        session.step = "COUNTRY";
        return res.send(
          twiml(
            "🌍 Enter your travel destination.\n\nExample: United Kingdom, USA, Japan, Italy"
          )
        );
      }

      if (text === "2") {
        return res.send(
          twiml(
            "ℹ️ FAQ:\n\n• eSIM activates instantly\n• Works in 190+ countries\n• No roaming fees\n• QR delivered by email\n\nType menu to go back."
          )
        );
      }

      if (text === "3") {
        return res.send(
          twiml("📞 Support: support@simclaire.com\n\nType menu to go back.")
        );
      }

      return res.send(
        twiml("❌ Invalid option.\nReply 1, 2, or 3.\nType menu to restart.")
      );
    }

    // -------------------------------------------------
    // COUNTRY SELECTION
    // -------------------------------------------------
    if (session.step === "COUNTRY") {
      const destRes = await esimRequest("get", "/destinations");
      const list = destRes.data || destRes || [];

      const match = list.find((d) =>
        (d.destinationName || "").toLowerCase().includes(text)
      );

      if (!match) {
        return res.send(
          twiml(
            "❌ Destination not found.\nTry another country or type menu to restart."
          )
        );
      }

      session.country = match.destinationName;
      session.destinationId = match.destinationID;

      const productsRes = await esimRequest(
        "get",
        `/products?destinationid=${match.destinationID}`
      );
      const products = productsRes.data || productsRes || [];
      session.products = products;

      if (!products || products.length === 0) {
        return res.send(
          twiml(
            `😕 We don’t have any plans available for *${session.country}* yet.\nType *menu* to choose another country.`
          )
        );
      }

      session.step = "PLAN";

      let msg = `📡 Plans for *${session.country}*:\n\n`;
      products.slice(0, 5).forEach((p, i) => {
        msg += `${i + 1}) ${p.productName}\n`;
        msg += `💾 ${p.productDataAllowance}\n`;
        msg += `📅 ${p.validity} days\n`;
        msg += `💵 £${p.productPrice}\n\n`;
      });

      msg += "Reply with a number (1–5) to choose a plan.";
      return res.send(twiml(msg));
    }

    // -------------------------------------------------
    // PLAN SELECTION
    // -------------------------------------------------
    if (session.step === "PLAN") {
      const choice = parseInt(text, 10);
      if (isNaN(choice) || choice < 1 || choice > session.products.length) {
        return res.send(twiml("❌ Invalid option. Reply with a valid plan number."));
      }

      session.selectedProduct = session.products[choice - 1];
      session.step = "QTY";
      return res.send(
        twiml("📦 How many eSIMs would you like? (1–10)")
      );
    }

    // -------------------------------------------------
    // QUANTITY
    // -------------------------------------------------
    if (session.step === "QTY") {
      const qty = parseInt(text, 10);
      if (isNaN(qty) || qty < 1 || qty > 10) {
        return res.send(twiml("❌ Enter a number between 1 and 10."));
      }

      session.quantity = qty;
      session.step = "MOBILE";
      return res.send(
        twiml("📱 Enter your mobile number (e.g., +447900123456)")
      );
    }

    // -------------------------------------------------
    // MOBILE
    // -------------------------------------------------
    if (session.step === "MOBILE") {
      const rawNumber = rawBody.trim();
      if (!/^\+?\d{7,15}$/.test(rawNumber)) {
        return res.send(twiml("❌ Invalid number. Try again with full country code."));
      }

      session.mobile = rawNumber;
      session.step = "EMAIL";
      return res.send(twiml("📧 Enter your email address:"));
    }

    // -------------------------------------------------
    // EMAIL → STRIPE CHECKOUT LINK
    // -------------------------------------------------
    if (session.step === "EMAIL") {
      const email = rawBody.trim();
      if (!email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
        return res.send(twiml("❌ Invalid email format. Try again."));
      }

      session.email = email;
      const p = session.selectedProduct;

      try {
        const response = await axios.post(
          "/api/payments/create-checkout-session",
          {
            email,
            quantity: session.quantity,
            price: p.productPrice,
            currency: "gbp",
            planName: p.productName,
            productSku: p.productSku || p.productSKU,
            productType: p.productType,
            data: p.productDataAllowance,
            validity: p.validity,
            country: session.country,
            mobile: session.mobile,
            metadata: {
              country: session.country,
              planName: p.productName,
              data: p.productDataAllowance,
              productSku: p.productSku || p.productSKU,
              productType: p.productType,
              flagEmoji: "📶",
              whatsappTo: `whatsapp:${from}`,
            },
          }
        );

        resetSession(from);

        return res.send(
          twiml(
            `💳 *Secure Payment Link*\n\nComplete your purchase here:\n${response.data.url}\n\nYour eSIM will be delivered instantly after payment.`
          )
        );
      } catch (err) {
        console.error("❌ Stripe error:", err.message);
        return res.send(
          twiml("⚠️ Payment error. Please type menu and try again.")
        );
      }
    }

    // -------------------------------------------------
    // FALLBACK
    // -------------------------------------------------
    return res.send(
      twiml("😅 I got lost. Type menu to restart the flow.")
    );
  } catch (err) {
    console.error("❌ WhatsApp Webhook Error:", err);
    return res.send(
      twiml("⚠️ Something went wrong. Please type menu to restart.")
    );
  }
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🔥 SimClaire backend running on port ${PORT}`);
});