// =====================================================
// server.js – SimClaire Backend (UAT FIXED)
// =====================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const twilio = require("twilio");
const PDFDocument = require("pdfkit");
const sgMail = require("@sendgrid/mail");
const bodyParser = require("body-parser");

const app = express();

// =====================================================
// QUOTAGUARD PROXY
// =====================================================
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🛡 QuotaGuard HTTP proxy active");
} else if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🛡 QuotaGuard SOCKS5 proxy active");
}

// =====================================================
// ESIM CONFIG (UAT)
// =====================================================
const RAW_ESIM_BASE = process.env.ESIM_BASE_URL;
const ESIM_BASE_URL = RAW_ESIM_BASE.replace(/\/$/, "") + "/api/esim";

const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

let esimToken = null;
let esimExpiresAt = 0;

// =====================================================
// AUTHENTICATE (UAT CORRECT)
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
  esimExpiresAt = Date.now() + 9 * 60 * 1000;

  console.log("🔐 eSIM token issued");
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
    httpsAgent: proxyAgent,
    proxy: false,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...options,
  });

  return res.data;
}

// =====================================================
// EXPRESS MIDDLEWARE
// =====================================================
app.use("/webhook/stripe", bodyParser.raw({ type: "application/json" }));
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// =====================================================
// TWILIO
// =====================================================
let twilioClient = null;
if (process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET) {
  twilioClient = twilio(
    process.env.TWILIO_API_KEY,
    process.env.TWILIO_API_SECRET,
    { accountSid: process.env.TWILIO_ACCOUNT_SID }
  );
  console.log("📞 Twilio ready");
}

// =====================================================
// WHATSAPP SESSION ENGINE (STABLE)
// =====================================================
const sessions = {};

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = { step: "MENU", products: [] };
  }
  return sessions[id];
}

function resetSession(id) {
  sessions[id] = { step: "MENU", products: [] };
}

function twiml(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${msg}</Message></Response>`;
}

// =====================================================
// WHATSAPP WEBHOOK
// =====================================================
app.post("/webhook/whatsapp", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const from = (req.body.WaId || req.body.From || "").replace("whatsapp:", "");
  const text = (req.body.Body || "").trim().toLowerCase();
  const session = getSession(from);

  // HI / RESET
  if (["hi", "hello", "menu"].includes(text)) {
    resetSession(from);
    return res.send(
      twiml("👋 Welcome to SimClaire!\n\n1) Browse Plans\n2) FAQ\n3) Support")
    );
  }

  // MENU
  if (session.step === "MENU") {
    if (text === "1") {
      session.step = "COUNTRY";
      return res.send(
        twiml("🌍 Enter your destination country\nExample: United Kingdom")
      );
    }
    return res.send(twiml("Reply 1 to browse plans."));
  }

  // COUNTRY
  if (session.step === "COUNTRY") {
    const destRes = await esimRequest("get", "/destinations");
    const list = destRes.data || [];

    const match = list.find(d =>
      d.destinationName.toLowerCase().includes(text)
    );

    if (!match) {
      return res.send(twiml("❌ Destination not found. Try again."));
    }

    session.destinationId = match.destinationID;
    session.country = match.destinationName;
    session.step = "PLAN";

    const prodRes = await esimRequest(
      "get",
      `/products?destinationID=${match.destinationID}`
    );

    session.products = prodRes.data || [];

    if (!session.products.length) {
      return res.send(twiml("No plans available. Type menu."));
    }

    let msg = `📱 Plans for ${session.country}\n\n`;
    session.products.slice(0, 5).forEach((p, i) => {
      msg += `${i + 1}) ${p.productName}\n💾 ${p.productDataAllowance}\n💵 £${p.productPrice}\n\n`;
    });

    msg += "Reply 1–5 to choose.";
    return res.send(twiml(msg));
  }

  // FALLBACK
  return res.send(twiml("Type menu to restart."));
});

// =====================================================
// HEALTH
// =====================================================
app.get("/", (_, res) => res.send("SimClaire backend running ✅"));

// =====================================================
// START
// =====================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`🔥 SimClaire backend live on port ${PORT}`)
);