require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =====================================================
// CONFIG
// =====================================================
const ESIM_BASE_URL = process.env.ESIM_BASE_URL; // https://esim-api.com OR https://uat.esim-api.com
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

// QuotaGuard Static (REQUIRED FOR WHITELISTING)
const httpsAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);

// =====================================================
// AUTH TOKEN CACHE
// =====================================================
let cachedToken = null;
let tokenExpiresAt = 0;

// =====================================================
// GET AUTH TOKEN
// =====================================================
async function getEsimToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const response = await axios.post(
    `${ESIM_BASE_URL}/api/esim/authenticate`,
    {
      userName: ESIM_USERNAME,
      password: ESIM_PASSWORD,
    },
    { httpsAgent }
  );

  cachedToken = response.data.token;
  tokenExpiresAt = Date.now() + 55 * 60 * 1000; // 55 minutes

  return cachedToken;
}

// =====================================================
// GET DESTINATIONS
// =====================================================
async function fetchDestinations() {
  const token = await getEsimToken();

  const response = await axios.get(
    `${ESIM_BASE_URL}/api/esim/destinations`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      httpsAgent,
    }
  );

  return response.data.data;
}

// =====================================================
// GET PRODUCTS (PLANS) BY DESTINATION
// =====================================================
async function fetchProducts(destinationID) {
  const token = await getEsimToken();

  const response = await axios.get(
    `${ESIM_BASE_URL}/api/esim/products`,
    {
      params: { destinationID },
      headers: {
        Authorization: `Bearer ${token}`,
      },
      httpsAgent,
    }
  );

  return response.data.data;
}

// =====================================================
// HEALTH CHECK (DEBUG)
// =====================================================
app.get("/health", async (req, res) => {
  try {
    const destinations = await fetchDestinations();
    res.json({
      ok: true,
      destinationCount: destinations.length,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.response?.data || err.message,
    });
  }
});

// =====================================================
// WHATSAPP WEBHOOK
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  const incomingMsg = (req.body.Body || "").trim().toLowerCase();

  try {
    // START
    if (incomingMsg === "hi" || incomingMsg === "hello") {
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

    // BROWSE PLANS
    if (incomingMsg === "1") {
      return res.send(`
<Response>
  <Message>
🌍 Please type your destination country
Example: United Kingdom
  </Message>
</Response>
`);
    }

    // DESTINATION → PLANS
    const destinations = await fetchDestinations();

    const destination = destinations.find(
      d => d.destinationName.toLowerCase() === incomingMsg
    );

    if (!destination) {
      return res.send(`
<Response>
  <Message>
❌ Destination not found.
Please try again.
  </Message>
</Response>
`);
    }

    const products = await fetchProducts(destination.destinationID);

    if (!products || products.length === 0) {
      return res.send(`
<Response>
  <Message>
⚠️ No plans available for ${destination.destinationName}.
  </Message>
</Response>
`);
    }

    let reply = `📱 *Plans for ${destination.destinationName}*\n\n`;

    products.forEach(p => {
      reply += `• ${p.productName}\n`;
      reply += `💰 ${p.productPrice} ${p.productCurrency}\n`;
      reply += `📦 ${p.productDataAllowance}\n`;
      reply += `⏳ ${p.productValidity} days\n\n`;
    });

    return res.send(`
<Response>
  <Message>${reply}</Message>
</Response>
`);
  } catch (err) {
    console.error("WhatsApp error:", err.response?.data || err.message);

    return res.send(`
<Response>
  <Message>
⚠️ Something went wrong.
Reply "hi" to restart.
  </Message>
</Response>
`);
  }
});

// =====================================================
// START SERVER
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 SimClaire backend running on port ${PORT}`);
});