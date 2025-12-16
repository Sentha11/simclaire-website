// =====================================================
// server.js – SimClaire Backend (STABLE WHATSAPP FIX)
// Destination → Plans Listing (No Loop)
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const twilio = require("twilio");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();
const whatsappState = {};

// =====================================================
// MIDDLEWARE
// =====================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =====================================================
// PROXY (Render / QuotaGuard safe)
// =====================================================
let proxyAgent = null;
if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 Using QuotaGuard proxy");
}

// =====================================================
// ESIM CONFIG
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

let esimToken = null;
let esimExpiresAt = 0;

// =====================================================
// ESIM AUTH
// =====================================================
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

// =====================================================
// ESIM REQUEST WRAPPER
// =====================================================
async function esimRequest(method, path) {
  const token = await getEsimToken();
  const res = await axios({
    method,
    url: `${ESIM_BASE_URL}${path}`,
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent: proxyAgent,
    proxy: false,
  });
  return res.data;
}

// =====================================================
// DESTINATION ID RESOLVER
// =====================================================
async function getDestinationIdByName(countryName) {
  const destinations = await esimRequest("get", "/destinations");
  const match = destinations.find(
    d => d.name.toLowerCase() === countryName.toLowerCase()
  );
  return match ? match.id : null;
}

// =====================================================
// GET PLANS BY DESTINATION
// =====================================================
async function getPlansForDestination(destinationId) {
  const products = await esimRequest(
    "get",
    `/products?destinationId=${destinationId}`
  );

  return products
    .filter(p => p.price && p.dataAmount)
    .sort((a, b) => a.price - b.price);
}

// =====================================================
// WHATSAPP WEBHOOK — FIXED FLOW (NO LOOP)
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.From;
  const body = req.body.Body?.trim().toLowerCase() || "";

  if (!whatsappState[from]) {
    whatsappState[from] = { step: "start" };
  }

  const state = whatsappState[from];

  // STEP 1 — GREETING
  if (["hi", "hello", "hey"].includes(body)) {
    state.step = "menu";
    return res.send(`
      <Response>
        <Message>👋 Welcome to SimClaire!
Reply with:
1) Browse Plans
2) FAQ
3) Support</Message>
      </Response>
    `);
  }

  // STEP 2 — MENU
  if (state.step === "menu" && body === "1") {
    state.step = "awaiting_destination";
    return res.send(`
      <Response>
        <Message>🌍 Please type your destination
Example: United Kingdom</Message>
      </Response>
    `);
  }

  // STEP 3 — DESTINATION → PLANS
  if (state.step === "awaiting_destination") {
    const destinationId = await getDestinationIdByName(body);

    if (!destinationId) {
      return res.send(`
        <Response>
          <Message>❌ Destination not found.
Please try again.</Message>
        </Response>
      `);
    }

    const plans = await getPlansForDestination(destinationId);

    if (!plans.length) {
      return res.send(`
        <Response>
          <Message>⚠️ No plans available for this destination.</Message>
        </Response>
      `);
    }

    state.step = "awaiting_plan";
    state.destinationId = destinationId;
    state.plans = plans.slice(0, 5);

    const list = state.plans
      .map(
        (p, i) =>
          `${i + 1}) ${p.dataAmount}GB / ${p.validityDays} days – £${p.price}`
      )
      .join("\n");

    return res.send(`
      <Response>
        <Message>📱 Available Plans:
${list}

Reply with plan number</Message>
      </Response>
    `);
  }

  // FALLBACK
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
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🔥 SimClaire backend running on port ${PORT}`)
);