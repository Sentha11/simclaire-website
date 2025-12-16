// =====================================================
// server.js – SimClaire Backend (STABLE FIXED VERSION)
// Stripe + eSIM API + WhatsApp + SendGrid + Proxy Support
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
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =====================================================
// PROXY (QuotaGuard)
// =====================================================
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using QuotaGuard proxy");
}

// =====================================================
// ESIM API CONFIG
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
    {
      userName: ESIM_USERNAME,
      password: ESIM_PASSWORD,
    },
    { httpsAgent: proxyAgent, proxy: false }
  );

  esimToken = res.data.token;
  esimExpiresAt = Date.now() + 10 * 60 * 1000;
  return esimToken;
}

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
// ✅ FIXED DESTINATION LOOKUP (THIS WAS THE BUG)
// =====================================================
async function getDestinationIdByName(countryName) {
  const res = await esimRequest("get", "/destinations");

  const destinations =
    Array.isArray(res) ? res :
    Array.isArray(res.data) ? res.data :
    Array.isArray(res.destinations) ? res.destinations :
    [];

  const match = destinations.find(
    d => d.name?.toLowerCase() === countryName.toLowerCase()
  );

  return match ? match.id : null;
}

// =====================================================
// TWILIO INIT (API KEY MODE)
// =====================================================
let twilioClient = null;

if (
  process.env.TWILIO_API_KEY &&
  process.env.TWILIO_API_SECRET &&
  process.env.TWILIO_ACCOUNT_SID
) {
  twilioClient = twilio(
    process.env.TWILIO_API_KEY,
    process.env.TWILIO_API_SECRET,
    { accountSid: process.env.TWILIO_ACCOUNT_SID }
  );
  console.log("📞 Twilio ready");
}

// =====================================================
// SENDGRID
// =====================================================
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("📧 SendGrid ready");
}

// =====================================================
// WHATSAPP WEBHOOK (REPLACED – NO LOOP)
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.From;
  const body = req.body.Body?.trim().toLowerCase() || "";

  if (!whatsappState[from]) {
    whatsappState[from] = { step: "start" };
  }

  const state = whatsappState[from];

  // STEP 0 – GREETING
  if (["hi", "hello", "hey"].includes(body)) {
    state.step = "menu";
    return res.send(`
      <Response>
        <Message>👋 Welcome to SimClaire!
Reply with:
1️⃣ Browse Plans
2️⃣ FAQ
3️⃣ Support</Message>
      </Response>
    `);
  }

  // STEP 1 – MENU
  if (state.step === "menu" && body === "1") {
    state.step = "destination";
    return res.send(`
      <Response>
        <Message>🌍 Please type your destination
Example: United Kingdom</Message>
      </Response>
    `);
  }

  // STEP 2 – DESTINATION → PLANS
  if (state.step === "destination") {
    const destinationId = await getDestinationIdByName(body);

    if (!destinationId) {
      return res.send(`
        <Response>
          <Message>❌ Destination not found.
Please try again.</Message>
        </Response>
      `);
    }

    state.destinationId = destinationId;
    state.step = "plans";

    // (Plans API call would go here)
    return res.send(`
      <Response>
        <Message>📱 Destination saved: ${body}
Plans will be listed next.</Message>
      </Response>
    `);
  }

  return res.send(`
    <Response>
      <Message>Type hi to start again.</Message>
    </Response>
  `);
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get("/", (_, res) => res.send("SimClaire backend running"));

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 SimClaire backend running on port ${PORT}`)
);