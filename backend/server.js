require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { SocksProxyAgent } = require("socks-proxy-agent");

const app = express();
app.use(express.json());

// ----------------------------
// CREATE SOCKS5 PROXY AGENT
// ----------------------------
let proxyAgent = null;

if (process.env.QUOTAGUARD_SOCKS_URL) {
  proxyAgent = new SocksProxyAgent(process.env.QUOTAGUARD_SOCKS_URL);
  console.log("🟢 SOCKS proxy enabled:", process.env.QUOTAGUARD_SOCKS_URL);
} else {
  console.log("🔴 No SOCKS proxy found in environment");
}

// ----------------------------
// TEST AUTH ENDPOINT
// ----------------------------
app.get("/api/test-auth", async (req, res) => {
  try {
    const url = ${process.env.ESIM_BASE_URL}/authenticate;

    console.log("🔗 Requesting:", url);

    const response = await axios.post(
      url,
      {
        userName: process.env.ESIM_USERNAME,
        password: process.env.ESIM_PASSWORD
      },
      {
        httpsAgent: proxyAgent,
        proxy: false // CRITICAL — DO NOT REMOVE
      }
    );

    res.json({ ok: true, data: response.data });

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.json({ ok: false, error: err.toString() });
  }
});

// ----------------------------
// START SERVER
// ----------------------------
app.listen(process.env.PORT || 10000, () =>
  console.log("🚀 Backend running on port 10000")
);