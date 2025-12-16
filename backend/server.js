require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const twilio = require("twilio");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =====================================================
// QUOTAGUARD PROXY SETUP (CRITICAL)
// =====================================================
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 QuotaGuard HTTP proxy enabled");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 QuotaGuard SOCKS proxy enabled");
} else {
  console.warn("⚠️ QuotaGuard NOT configured");
}

// =====================================================
// AXIOS INSTANCE (FORCED THROUGH PROXY)
// =====================================================
const esimAxios = axios.create({
  httpsAgent: proxyAgent,
  proxy: false, // IMPORTANT: disables axios default proxy handling
  timeout: 30000,
});

// =====================================================
// TWILIO
// =====================================================
const twilioClient = twilio(
  process.env.TWILIO_API_KEY,
  process.env.TWILIO_API_SECRET,
  { accountSid: process.env.TWILIO_ACCOUNT_SID }
);

// =====================================================
// ESIM AUTH (JWT)
// =====================================================
const ESIM_BASE = process.env.ESIM_BASE_URL;
let esimToken = null;
let tokenExpiry = 0;

async function getEsimToken() {
  if (esimToken && Date.now() < tokenExpiry) return esimToken;

  const res = await esimAxios.post(`${ESIM_BASE}/api/esim/authenticate`, {
    userName: process.env.ESIM_USERNAME,
    password: process.env.ESIM_PASSWORD,
  });

  esimToken = res.data.token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;

  console.log("🔐 eSIM token refreshed");
  return esimToken;
}

async function esimGet(path) {
  const token = await getEsimToken();
  const res = await esimAxios.get(`${ESIM_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

// =====================================================
// DATA HELPERS (FIXED)
// =====================================================
async function getDestinations() {
  const res = await esimGet("/api/esim/destinations");
  return Array.isArray(res.data) ? res.data : [];
}

async function getDestinationIdByName(name) {
  const destinations = await getDestinations();
  const match = destinations.find(
    d => d.destinationName.toLowerCase() === name.toLowerCase()
  );
  return match ? match.destinationID : null;
}

async function getProductsByDestinationId(destinationId) {
  const res = await esimGet(
    `/api/esim/products?destinationId=${destinationId}`
  );
  return Array.isArray(res.data) ? res.data : [];
}

// =====================================================
// WHATSAPP STATE
// =====================================================
const state = {};

// =====================================================
// WHATSAPP WEBHOOK
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = req.body.From;
  const msg = req.body.Body?.trim();

  if (!state[from]) state[from] = { step: "menu" };

  // HI
  if (/^hi|hello$/i.test(msg)) {
    state[from].step = "menu";
    return res.send(`
<Response>
<Message>
👋 Welcome to SimClaire!
Reply:
1️⃣ Browse Plans
2️⃣ FAQ
3️⃣ Support
</Message>
</Response>
`);
  }

  // MENU
  if (state[from].step === "menu" && msg === "1") {
    state[from].step = "destination";
    return res.send(`
<Response>
<Message>
🌍 Please type your destination
Example: United Kingdom
</Message>
</Response>
`);
  }

  // DESTINATION → PLANS
  if (state[from].step === "destination") {
    const destinationId = await getDestinationIdByName(msg);

    if (!destinationId) {
      return res.send(`
<Response>
<Message>❌ Destination not found. Please try again.</Message>
</Response>
`);
    }

    state[from].destinationId = destinationId;
    state[from].step = "plans";

    const products = await getProductsByDestinationId(destinationId);

    if (!products.length) {
      return res.send(`
<Response>
<Message>⚠️ No plans available for this destination.</Message>
</Response>
`);
    }

    const list = products
      .slice(0, 5)
      .map(
        (p, i) =>
          `${i + 1}. ${p.productName}\n💾 ${p.productDataAllowance}\n⏳ ${p.productValidity} days\n💰 ${p.productCurrency}${p.productPrice}`
      )
      .join("\n\n");

    return res.send(`
<Response>
<Message>
📱 Available Plans:
${list}
</Message>
</Response>
`);
  }

  return res.send(`
<Response>
<Message>Type "hi" to start again.</Message>
</Response>
`);
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get("/", (_, res) => res.send("SimClaire Backend OK"));

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 SimClaire backend running on port ${PORT}`)
);