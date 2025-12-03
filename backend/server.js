require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();
app.use(express.json());

// -----------------------------
// Proxy Setup
// -----------------------------
let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  console.log("🚀 QuotaGuard STATIC proxy enabled!");
  console.log("QUOTAGUARD_URL =", process.env.QUOTAGUARD_URL);

  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL);
} else {
  console.log("⚠️ No QUOTAGUARD_URL found. Proxy disabled.");
}

// -----------------------------
// ESIM Authenticate Function
// -----------------------------
async function getEsimToken() {
  try {
    const url = `${process.env.ESIM_BASE_URL}/authenticate`;

    console.log("🔗 Requesting:", url);
    console.log("🛰 Using proxy?", proxyAgent ? "YES" : "NO");

    const res = await axios.post(
      url,
      {
        userName: process.env.ESIM_USERNAME,
        password: process.env.ESIM_PASSWORD,
      },
      {
        httpsAgent: proxyAgent || undefined,
        timeout: 15000,
      }
    );

    return res.data;
  } catch (err) {
    console.error("❌ Error in getEsimToken:", err.message);
    return { ok: false, error: err.message };
  }
}

// -----------------------------
// Test Route
// -----------------------------
app.get("/api/test-auth", async (req, res) => {
  const data = await getEsimToken();
  res.json(data);
});

// -----------------------------
// Start Server
// -----------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});