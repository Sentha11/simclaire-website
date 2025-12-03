// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

// -----------------------------------------------------
// QUOTAGUARD STATIC PROXY SETUP
// -----------------------------------------------------
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled!");
  console.log("QUOTAGUARD_URL =", process.env.QUOTAGUARD_URL);
} else {
  console.warn("⚠️ QUOTAGUARD_URL missing — proxy is OFF");
}

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -----------------------------
// ENV VARS
// -----------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  console.warn("⚠️ Missing eSIM API environment variables");
}

// -----------------------------
// TOKEN CACHE
// -----------------------------
let esimToken = null;
let esimTokenExpiresAt = 0;

async function getEsimToken() {
  const now = Date.now();
  if (esimToken && now < esimTokenExpiresAt) return esimToken;

  const url = `${ESIM_BASE_URL}/authenticate`;

  console.log("🚀 Using proxy:", proxyAgent != null);
  console.log("🔗 Requesting:", url);

  const res = await axios.post(
    url,
    {
      userName: ESIM_USERNAME,
      password: ESIM_PASSWORD,
    },
    {
      httpsAgent: proxyAgent,
      proxy: false,
    }
  );

  esimToken = res.data.token;
  const ttlSeconds = res.data.expirySeconds || 600;
  esimTokenExpiresAt = now + ttlSeconds * 1000;

  console.log("🔐 eSIM token refreshed");
  return esimToken;
}

// -----------------------------
// GENERIC API REQUEST WRAPPER
// -----------------------------
async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}${path}`;

  console.log("➡️ eSIM API request:", url);

  try {
    const res = await axios({
      method,
      url,
      httpsAgent: proxyAgent,
      proxy: false,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    return res.data;
  } catch (err) {
    // retry if token expired
    if (err.response && err.response.status === 401) {
      esimToken = null;
      const newToken = await getEsimToken();

      const retry = await axios({
        method,
        url,
        httpsAgent: proxyAgent,
        proxy: false,
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });

      return retry.data;
    }

    console.error("❌ esimRequest error:", err.message);
    throw err;
  }
}

// -----------------------------
// HEALTH CHECK
// -----------------------------
app.get("/api/status", (req, res) => {
  res.json({ status: "OK", message: "Backend running" });
});

// -----------------------------
// TEST AUTH
// -----------------------------
app.get("/api/test-auth", async (req, res) => {
  try {
    const token = await getEsimToken();
    res.json({ ok: true, token });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// -----------------------------
// DESTINATIONS
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
// PRODUCTS
// -----------------------------
app.get("/api/esim/products", async (req, res) => {
  const { destinationid } = req.query;
  if (!destinationid)
    return res.status(400).json({ error: "destinationid is required" });

  try {
    const data = await esimRequest(
      "get",
      `/products?destinationid=${encodeURIComponent(destinationid)}`
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// -----------------------------
// PURCHASE
// -----------------------------
app.post("/api/esim/purchase", async (req, res) => {
  const { sku, quantity, mobileno, emailid } = req.body;

  if (!sku || !quantity || !mobileno || !emailid) {
    return res
      .status(400)
      .json({ error: "sku, quantity, mobileno, and emailid are required" });
  }

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

  try {
    const data = await esimRequest("post", "/purchaseesim", { data: payload });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to purchase eSIM" });
  }
});

// -----------------------------
// START SERVER
// -----------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🔥 Backend running on port ${PORT}`);
});