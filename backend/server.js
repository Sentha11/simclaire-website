// =====================================================
// server.js – SimClaire Backend (PRODUCTION READY)
// eSIM API + WhatsApp + Stripe + SendGrid + QuotaGuard
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

const app = express();
const whatsappState = {};

// =====================================================
// MIDDLEWARE
// =====================================================
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// =====================================================
// QUOTAGUARD PROXY
// =====================================================
let proxyAgent = null;
if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 QuotaGuard HTTP proxy active");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 QuotaGuard SOCKS proxy active");
}

// =====================================================
// ESIM API CONFIG
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

let esimToken = null;
let tokenExpiry = 0;

// =====================================================
// ESIM AUTH
// =====================================================
async function getEsimToken() {
  if (esimToken && Date.now() < tokenExpiry) return esimToken;

  const res = await axios.post(
    `${ESIM_BASE_URL}/api/esim/authenticate`,
    {
      userName: ESIM_USERNAME,
      password: ESIM_PASSWORD,
    },
    { httpsAgent: proxyAgent, proxy: false }
  );

  esimToken = res.data.token;
  tokenExpiry = Date.now() + 9 * 60 * 1000;
  console.log("🔐 eSIM token refreshed");
  return esimToken;
}

// =====================================================
// ESIM REQUEST WRAPPER
// =====================================================
async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();

  const res = await axios({
    method,
    url: `${ESIM_BASE_URL}${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    httpsAgent: proxyAgent,
    proxy: false,
    ...options,
  });

  return res.data;
}

// =====================================================
// TWILIO CLIENT
// =====================================================
const twilioClient = twilio(
  process.env.TWILIO_API_KEY,
  process.env.TWILIO_API_SECRET,
  { accountSid: process.env.TWILIO_ACCOUNT_SID }
);

// =====================================================
// SENDGRID
// =====================================================
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// =====================================================
// WHATSAPP WEBHOOK (NO LOOP VERSION)
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.From;
  const body = (req.body.Body || "").trim().toLowerCase();

  if (!whatsappState[from]) {
    whatsappState[from] = { step: "start" };
  }

  const state = whatsappState[from];

  // ===== GREETING =====
  if (["hi", "hello", "hey"].includes(body)) {
    whatsappState[from] = { step: "menu" };

    return res.send(`
<Response>
  <Message>
👋 Welcome to SimClaire!
Reply with:
1️⃣ Browse Plans
2️⃣ FAQ
3️⃣ Support
  </Message>
</Response>
`);
  }

  // ===== MENU =====
  if (state.step === "menu" && body === "1") {
    state.step = "destination";
    return res.send(`
<Response>
  <Message>
🌍 Please type your destination country
Example: United Kingdom
  </Message>
</Response>
`);
  }

  // ===== DESTINATION =====
  if (state.step === "destination") {
    try {
      const destinations = await esimRequest(
        "get",
        "/api/esim/destinations"
      );

      const match = destinations.data.find(
        d => d.destinationName.toLowerCase() === body
      );

      if (!match) {
        return res.send(`
<Response>
  <Message>
❌ Destination not found.
Please try again.
  </Message>
</Response>
`);
      }

      const products = await esimRequest(
        "get",
        "/api/esim/products",
        { params: { destinationID: match.destinationID } }
      );

      if (!products.data.length) {
        return res.send(`
<Response>
  <Message>
⚠️ No plans available for ${match.destinationName}.
  </Message>
</Response>
`);
      }

      let reply = `📱 *Plans for ${match.destinationName}*\n\n`;
      products.data.forEach((p, i) => {
        reply += `${i + 1}. ${p.productName}\n`;
        reply += `💰 ${p.productPrice} ${p.productCurrency}\n`;
        reply += `📦 ${p.productDataAllowance}\n`;
        reply += `⏳ ${p.productValidity} days\n\n`;
      });

      state.step = "menu"; // prevent loop

      return res.send(`
<Response>
  <Message>${reply}</Message>
</Response>
`);
    } catch (err) {
      console.error("❌ Destination error:", err.response?.data || err);
      whatsappState[from] = { step: "start" };

      return res.send(`
<Response>
  <Message>
⚠️ Something went wrong.
Reply "hi" to restart.
  </Message>
</Response>
`);
    }
  }

  // ===== FALLBACK =====
  return res.send(`
<Response>
  <Message>Reply "hi" to begin.</Message>
</Response>
`);
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get("/", (_, res) => res.send("SimClaire backend live ✅"));

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🔥 SimClaire backend running on port ${PORT}`)
);