// =====================================================
// server.js – SimClaire Backend
// ESIM + WhatsApp + Stripe + QuotaGuard + SendGrid + PDFKit
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const twilio = require("twilio");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const sgMail = require("@sendgrid/mail");

const app = express();

// =====================================================
// BASE URL + AXIOS DEFAULTS
// =====================================================
const APP_BASE_URL =
  process.env.APP_BASE_URL ||
  "https://simclaire-website-backend.onrender.com";

axios.defaults.baseURL = APP_BASE_URL;

// =====================================================
// MIDDLEWARE (order matters)
// =====================================================
app.use(cors());

// For Twilio / WhatsApp form-encoded webhooks
app.use(express.urlencoded({ extended: false }));

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
// STRIPE INIT
// =====================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  console.log("💳 Stripe enabled");
} else {
  console.warn("⚠️ Stripe disabled (missing STRIPE_SECRET_KEY)");
}

// =====================================================
// SENDGRID INIT
// =====================================================
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid enabled");
} else {
  console.warn("⚠️ SendGrid disabled (missing SENDGRID_API_KEY)");
}

const SENDGRID_FROM_EMAIL =
  process.env.SENDGRID_FROM_EMAIL || "care@simclaire.com";
const SENDGRID_FROM_NAME =
  process.env.SENDGRID_FROM_NAME || "SimClaire";

// Local logo file (put logo here: backend/assets/simclaire-logo.png)
const LOGO_PATH = path.join(__dirname, "assets", "simclaire-logo.png");

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

// PURCHASE ESIM WRAPPER
async function purchaseEsim({ sku, quantity, type, destinationId }) {
  const body = {
    items: [
      {
        sku,
        quantity,
        type,
        destinationId,
      },
    ],
  };

  console.log("📦 purchaseEsim payload:", JSON.stringify(body, null, 2));

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
// SESSION SYSTEM (includes double email entry support)
// =====================================================
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
      tempEmail: null, // NEW: for double entry email
    };
  }
  return sessions[id];
}

function resetSession(id) {
  delete sessions[id];
}

// =====================================================
// PDF GENERATION + EMAIL (SendGrid)
// =====================================================
function generateEsimPdfBuffer({ meta, amount, currency, purchaseResult }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];

      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Header / Logo
      if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, { width: 120, align: "left" });
        doc.moveDown();
      } else {
        doc
          .fontSize(22)
          .text("SimClaire", { align: "left", underline: true });
        doc.moveDown();
      }

      doc
        .fontSize(18)
        .text("Your eSIM Order Confirmation", { align: "left" })
        .moveDown();

      doc
        .fontSize(12)
        .text(`Customer: ${meta.email || ""}`)
        .text(`Destination: ${meta.country || ""}`)
        .text(`Plan: ${meta.planName || ""}`)
        .text(`Data: ${meta.data || ""}`)
        .text(`Amount Paid: ${currency}${amount}`)
        .moveDown();

      if (purchaseResult) {
        doc.fontSize(14).text("eSIM Details", { underline: true }).moveDown();
        if (purchaseResult.transactionId) {
          doc
            .fontSize(12)
            .text(`Transaction ID: ${purchaseResult.transactionId}`);
        }
        if (purchaseResult.activationCode) {
          doc.text(`Activation Code: ${purchaseResult.activationCode}`);
        }
        if (purchaseResult.statusmsg) {
          doc.text(`Status: ${purchaseResult.statusmsg}`);
        }
        doc.moveDown();
      }

      doc
        .fontSize(12)
        .text(
          "You’ll receive a separate message with your QR code and detailed installation steps (if not already included above)."
        )
        .moveDown();

      doc
        .fontSize(10)
        .text(
          "If you have any issues, reply to this email or contact care@simclaire.com.",
          { align: "left" }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function sendEsimEmail({ to, meta, amount, currency, purchaseResult }) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn("⚠️ Skipping SendGrid email – not configured");
    return;
  }
  if (!to) {
    console.warn("⚠️ Skipping SendGrid email – missing recipient");
    return;
  }

  const curSymbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";

  const pdfBuffer = await generateEsimPdfBuffer({
    meta,
    amount,
    currency: curSymbol,
    purchaseResult,
  });

  const msg = {
    to,
    from: {
      email: SENDGRID_FROM_EMAIL,
      name: SENDGRID_FROM_NAME,
    },
    subject: `Your eSIM for ${meta.country || "your trip"} – ${
      meta.planName || ""
    }`,
    text: [
      "Thank you for your purchase with SimClaire!",
      "",
      `Destination: ${meta.country || ""}`,
      `Plan: ${meta.planName || ""}`,
      `Data: ${meta.data || ""}`,
      `Amount Paid: ${curSymbol}${amount}`,
      "",
      "Your eSIM details/QR will be attached in the PDF, or sent separately depending on the provider.",
      "",
      "If you have any questions, reply to this email or contact care@simclaire.com.",
    ].join("\n"),
    attachments: [
      {
        content: pdfBuffer.toString("base64"),
        filename: "SimClaire-eSIM.pdf",
        type: "application/pdf",
        disposition: "attachment",
      },
    ],
  };

  await sgMail.send(msg);
  console.log("📧 eSIM email sent via SendGrid to", to);
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

      if (event.type === "checkout.session.completed") {
        const sessionObj = event.data.object;
        const meta = sessionObj.metadata || {};

        const amount = (sessionObj.amount_total / 100).toFixed(2);
        const currencyCode = (sessionObj.currency || "GBP").toUpperCase();
        let symbol = "£";
        if (currencyCode === "USD") symbol = "$";
        if (currencyCode === "EUR") symbol = "€";

        console.log("🎟 Stripe metadata:", meta);

        // ---------------------------------------------
        // 1) PURCHASE ESIM
        // ---------------------------------------------
        let purchaseResult = null;
        try {
          const sku = meta.productSku;
          const qty = parseInt(meta.quantity || "1", 10) || 1;
          const type = meta.productType;
          const destinationId = meta.destinationId;

          if (!sku) {
            console.error("❌ Missing productSku in metadata");
          } else if (!type) {
            console.error("❌ Missing productType in metadata");
          } else if (!destinationId) {
            console.error("❌ Missing destinationId in metadata");
          } else {
            purchaseResult = await purchaseEsim({
              sku,
              quantity: qty,
              type: String(type),
              destinationId: String(destinationId),
            });
            console.log("✅ purchaseEsim response:", purchaseResult);
          }
        } catch (err) {
          console.error(
            "❌ Error calling purchaseEsim:",
            err.response?.data || err.message
          );
        }

        // ---------------------------------------------
        // 2) SEND WHATSAPP CONFIRMATION
        // ---------------------------------------------
        try {
          let msg = `
🎉 Payment Successful!

${meta.flagEmoji || "📶"} ${meta.country || ""} — ${meta.planName || ""}
💾 ${meta.data || ""}
💵 ${symbol}${amount} Paid

🧾 Stripe Receipt: ${sessionObj.id}
📧 ${sessionObj.customer_details?.email || meta.email || ""}
`;

          if (purchaseResult?.transactionId) {
            msg += `\n🆔 eSIM Transaction ID: ${purchaseResult.transactionId}`;
          }

          if (purchaseResult?.activationCode) {
            msg += `\n🔐 Activation Code: ${purchaseResult.activationCode}`;
          }

          if (purchaseResult?.statusmsg) {
            msg += `\n📣 Status: ${purchaseResult.statusmsg}`;
          }

          msg += `\n\nYour official eSIM email with PDF will arrive shortly.`;

          if (
            twilioClient &&
            meta.whatsappTo &&
            process.env.TWILIO_WHATSAPP_FROM
          ) {
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

        // ---------------------------------------------
        // 3) SEND EMAIL WITH PDF (SendGrid)
// ---------------------------------------------
        try {
          const customerEmail =
            sessionObj.customer_details?.email || meta.email;

          await sendEsimEmail({
            to: customerEmail,
            meta,
            amount,
            currency: currencyCode,
            purchaseResult,
          });
        } catch (err) {
          console.error("❌ Error sending SendGrid email:", err);
        }
      }

      res.json({ received: true });
    }
  );
} else {
  console.warn("⚠️ Stripe webhook disabled (missing STRIPE_WEBHOOK_SECRET)");
}

// =====================================================
// PARSE JSON FOR NORMAL API ROUTES
// =====================================================
app.use(express.json());

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
      destinationId,
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
        productType,
        data,
        validity,
        quantity,
        email,
        mobile,
        country,
        destinationId,
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
// TEST ESIM ENDPOINT
// =====================================================
app.get("/test-esim", async (req, res) => {
  try {
    console.log("🔍 Running /test-esim check...");

    const token = await getEsimToken();
    console.log("🔐 Token received:", token ? "YES" : "NO");

    const data = await esimRequest("get", "/destinations");
    console.log("🌍 Destinations:", data?.data?.length || "n/a");

    return res.json({
      ok: true,
      message: "Render → Proxy → eSIM API connection works!",
      destinationsCount: Array.isArray(data?.data)
        ? data.data.length
        : "unknown",
      sample: Array.isArray(data?.data) ? data.data.slice(0, 3) : data,
    });
  } catch (err) {
    console.error("❌ /test-esim ERROR:", err.response?.data || err.message);
    return res.json({
      ok: false,
      error: err.response?.data || err.message,
    });
  }
});

// =====================================================
// DEBUG — GET PRODUCTS FOR A DESTINATION
// =====================================================
app.get("/debug/products", async (req, res) => {
  try {
    const id = req.query.destinationid;
    if (!id) {
      return res.json({ error: "destinationid query parameter is required" });
    }

    console.log("🔍 Fetching products for destination:", id);

    const data = await esimRequest("get", `/products?destinationid=${id}`);
    const products = Array.isArray(data?.data) ? data.data : data;

    return res.json({
      ok: true,
      destinationid: id,
      count: Array.isArray(products) ? products.length : 0,
      products,
    });
  } catch (err) {
    console.error("❌ /debug/products error:", err.response?.data || err.message);
    return res.json({
      ok: false,
      error: err.response?.data || err.message,
    });
  }
});

// =====================================================
// WHATSAPP WEBHOOK — MAIN FLOW
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const from = req.body.WaId || req.body.From?.replace("whatsapp:", "");
    const text = (req.body.Body || "").trim().toLowerCase();
    const session = getSession(from);

    // MENU RESET
    if (["menu", "main"].includes(text)) {
      resetSession(from);
      return res.send(
        twiml(
          "👋 Welcome to SimClaire!\n\n1) Browse plans\n2) FAQ\n3) Support"
        )
      );
    }

    // MENU OPTIONS
    if (session.step === "MENU") {
      if (text === "1") {
        session.step = "COUNTRY";
        return res.send(
          twiml(
            "🌍 Enter your travel destination.\nExample: Italy, USA, Japan, United Kingdom."
          )
        );
      }

      if (text === "2") {
        return res.send(
          twiml("ℹ️ FAQ: Visit https://simclaire.com/faq (coming soon)")
        );
      }

      if (text === "3") {
        return res.send(twiml("📞 Support: care@simclaire.com"));
      }

      // Default menu
      return res.send(
        twiml(
          "👋 Welcome to SimClaire!\n\n1) Browse plans\n2) FAQ\n3) Support"
        )
      );
    }

    // COUNTRY SEARCH
    if (session.step === "COUNTRY") {
      const destRes = await esimRequest("get", "/destinations");
      const list = destRes.data || destRes || [];

      const match = list.find((d) =>
        (d.destinationName || "").toLowerCase().includes(text)
      );

      if (!match) {
        return res.send(
          twiml("❌ No match. Try another country or type menu.")
        );
      }

      session.country = match.destinationName;
      session.destinationId = match.destinationID;
      session.step = "PLAN";

      const prodRes = await esimRequest(
        "get",
        `/products?destinationid=${match.destinationID}`
      );

      const products = prodRes.data || prodRes || [];
      session.products = products;

      if (!products || products.length === 0) {
        return res.send(
          twiml(
            `😕 No plans available for *${session.country}*.\nType *menu* to start over.`
          )
        );
      }

      let msg = `📡 Plans for *${session.country}*:\n\n`;
      products.slice(0, 5).forEach((p, i) => {
        msg += `${i + 1}) ${p.productName}\n💾 ${p.productDataAllowance}\n📅 ${
          p.validity
        } days\n💵 £${p.productPrice}\n\n`;
      });

      msg += "Reply with 1–5 to choose a plan.";
      return res.send(twiml(msg));
    }

    // PLAN SELECT
    if (session.step === "PLAN") {
      const index = parseInt(text);

      if (isNaN(index) || index < 1 || index > session.products.length) {
        return res.send(twiml("❌ Invalid option. Try again."));
      }

      session.selectedProduct = session.products[index - 1];
      session.step = "QTY";

      return res.send(twiml("📦 How many eSIMs? (1–10)"));
    }

    // QUANTITY
    if (session.step === "QTY") {
      const qty = parseInt(text);

      if (isNaN(qty) || qty < 1 || qty > 10) {
        return res.send(twiml("❌ Enter a number 1–10."));
      }

      session.quantity = qty;
      session.step = "MOBILE";

      return res.send(
        twiml("📱 Enter your mobile number (e.g., +447900123456)")
      );
    }

    // MOBILE
    if (session.step === "MOBILE") {
      const num = req.body.Body.trim();

      if (!/^\+?\d{7,15}$/.test(num)) {
        return res.send(twiml("❌ Invalid number. Try again."));
      }

      session.mobile = num;
      session.step = "EMAIL";

      return res.send(twiml("📧 Enter your email address:"));
    }

    // EMAIL — FIRST ENTRY
    if (session.step === "EMAIL") {
      const email = req.body.Body.trim();

      if (!email.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
        return res.send(twiml("❌ Invalid email. Please try again:"));
      }

      session.tempEmail = email;
      session.step = "EMAIL_CONFIRM";

      return res.send(
        twiml(
          "Just to make sure we send your eSIM correctly — please type your email again:"
        )
      );
    }

    // EMAIL — CONFIRMATION ENTRY
    if (session.step === "EMAIL_CONFIRM") {
      const confirm = req.body.Body.trim();

      if (confirm !== session.tempEmail) {
        return res.send(
          twiml("❌ Emails do not match.\n\nPlease enter your email again:")
        );
      }

      session.email = confirm;

      const p = session.selectedProduct;

      try {
        const response = await axios.post(
          "/api/payments/create-checkout-session",
          {
            email: session.email,
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
            destinationId: session.destinationId,
            metadata: {
              country: session.country,
              planName: p.productName,
              data: p.productDataAllowance,
              productSku: p.productSku || p.productSKU,
              productType: p.productType,
              destinationId: session.destinationId,
              flagEmoji: "🇬🇧",
              whatsappTo: `whatsapp:${from}`,
            },
          }
        );

        resetSession(from);

        return res.send(
          twiml(
            `💳 *Secure Payment Link*\n\nComplete your purchase:\n${response.data.url}\n\nYour eSIM will be delivered instantly after payment.`
          )
        );
      } catch (err) {
        console.error("❌ Stripe error:", err.message);
        return res.send(
          twiml("⚠️ Payment error. Please type menu and try again.")
        );
      }
    }

    return res.send(twiml("😅 I got lost. Type menu to restart."));
  } catch (err) {
    console.error("❌ WhatsApp Webhook Error:", err);
    return res.send(twiml("⚠️ Something broke. Type menu to restart."));
  }
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 Backend running on port ${PORT}`));