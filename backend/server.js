require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const tls = require("tls");

const app = express();
app.use(express.json());
app.use(cors());

// Force TLS 1.2 ONLY (ESIM API rejects TLS 1.3)
tls.DEFAULT_MIN_VERSION = "TLSv1.2";
tls.DEFAULT_MAX_VERSION = "TLSv1.2";

// ------------------- PROXY SETUP -------------------
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  console.log("🔥 QuotaGuard STATIC Proxy Enabled");
  console.log("Proxy URL:", process.env.QUOTAGUARD_URL);

  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL, {
    keepAlive: true,
    timeout: 25000,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2"
  });
} else {
  console.log("⚠ No QUOTAGUARD_URL found — NOT using proxy.");
}
// ----------------------------------------------------

// Helper: test auth
async function getEsimToken() {
  const url = `${process.env.ESIM_BASE_URL}/authenticate`;

  console.log("🔗 Calling ESIM endpoint:", url);
  console.log("🔌 Using proxy:", proxyAgent ? true : false);

  try {
    const response = await axios.post(
      url,
      {
        userName: process.env.ESIM_USERNAME,
        password: process.env.ESIM_PASSWORD
      },
      {
        httpsAgent: proxyAgent,
        proxy: false,        // IMPORTANT FOR QUOTAGUARD
        timeout: 25000
      }
    );

    return {
      ok: true,
      data: response.data
    };

  } catch (err) {
    console.error("❌ ESIM AUTH ERROR:", err.toString());
    return {
      ok: false,
      error: err.toString()
    };
  }
}

// API endpoint for testing
app.get("/api/test-auth", async (req, res) => {
  const result = await getEsimToken();
  res.json(result);
});

// Root
app.get("/", (req, res) => {
  res.send("Backend running — SIMCLAIRE API");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});