// =====================================================
// SimClaire Backend – WhatsApp + eSIM (Unified API) + QuotaGuard
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const twilio = require("twilio");

const app = express();

// -----------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -----------------------------------------------------
// TWILIO
// -----------------------------------------------------
const MessagingResponse = twilio.twiml.MessagingResponse;

// -----------------------------------------------------
// QUOTAGUARD PROXY (STATIC IP)
// -----------------------------------------------------
const proxyAgent = process.env.QUOTAGUARD_URL
  ? new HttpsProxyAgent(process.env.QUOTAGUARD_URL)
  : null;

// -----------------------------------------------------
// ESIM API CONFIG (Unified API)
// -----------------------------------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL; // MUST end with /api/esim
let esimToken = null;
let tokenExpiry = 0;

// -----------------------------------------------------
// AUTH – GET JWT TOKEN
// -----------------------------------------------------
async function getEsimToken() {
  if (esimToken && Date.now() < tokenExpiry) return esimToken;

  const response = await axios.post(
    `${ESIM_BASE_URL}/authenticate`,
    {
      userName: process.env.ESIM_USERNAME,
      password: process.env.ESIM_PASSWORD,
    },
    {
      httpsAgent: proxyAgent,
      timeout: 15000,
    }
  );

  esimToken = response.data?.data?.token;
  tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 mins

  return esimToken;
}

// -----------------------------------------------------
// GET DESTINATION ID BY NAME
// -----------------------------------------------------
async function getDestinationIdByName(destinationName) {
  const token = await getEsimToken();

  const res = await axios.get(`${ESIM_BASE_URL}/destinations`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    httpsAgent: proxyAgent,
  });

  const destinations = res.data?.data || [];

  const match = destinations.find(
    (d) =>
      d.destinationName.toLowerCase() === destinationName.toLowerCase()
  );

  return match || null;
}

// -----------------------------------------------------
// GET PRODUCTS BY DESTINATION ID
// -----------------------------------------------------
async function getProductsByDestination(destinationID) {
  const token = await getEsimToken();

  const res = await axios.get(`${ESIM_BASE_URL}/products`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    params: { destinationID },
    httpsAgent: proxyAgent,
  });

  return res.data?.data || [];
}

// -----------------------------------------------------
// WHATSAPP WEBHOOK
// -----------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();
  const msg = req.body.Body?.trim();
  const from = req.body.From;

  try {
    // ---- START FLOW ----
    if (!msg || msg.toLowerCase() === "hi") {
      twiml.message(
        `👋 Welcome to SimClaire!\n\nReply with:\n1️⃣ Browse Plans\n2️⃣ FAQ\n3️⃣ Support`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ---- MENU ----
    if (msg === "1") {
      twiml.message(
        `🌍 Please type your destination country\nExample: United Kingdom`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ---- DESTINATION INPUT ----
    if (msg.length > 2 && !isNaN(msg) === false) {
      const destination = await getDestinationIdByName(msg);

      if (!destination) {
        twiml.message(`❌ Destination not found. Please try again.`);
        return res.type("text/xml").send(twiml.toString());
      }

      const products = await getProductsByDestination(
        destination.destinationID
      );

      if (!products.length) {
        twiml.message(`⚠️ No plans available for ${destination.destinationName}`);
        return res.type("text/xml").send(twiml.toString());
      }

      let reply = `📱 *Available eSIM Plans for ${destination.destinationName}*\n\n`;

      products.forEach((p, i) => {
        reply += `*${i + 1}.* ${p.productName}\n`;
        reply += `💾 Data: ${p.productDataAllowance}\n`;
        reply += `📅 Validity: ${p.productValidity} days\n`;
        reply += `💰 Price: ${p.productPrice} ${p.productCurrency}\n\n`;
      });

      reply += `Reply *hi* to start again.`;
      twiml.message(reply);
      return res.type("text/xml").send(twiml.toString());
    }

    // ---- FALLBACK ----
    twiml.message(`Type *hi* to start again.`);
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("WHATSAPP ERROR:", err.message);
    twiml.message(`⚠️ Something went wrong. Please try again.`);
    return res.type("text/xml").send(twiml.toString());
  }
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 SimClaire backend running on port ${PORT}`)
);