require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();
app.use(express.json());

let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  proxyAgent = new HttpsProxyAgent(process.env.QUOTAGUARD_URL, {
    tunnel: true,        // REQUIRED for HTTPS over HTTP proxy
    keepAlive: true
  });

  console.log("🚀 Proxy enabled:", process.env.QUOTAGUARD_URL);
} else {
  console.log("⚠️ No proxy enabled");
}

app.get("/api/test-auth", async (req, res) => {
  try {
    const url = "https://uat.esim-api.com/api/esim/authenticate";

    console.log("🔗 Sending request to:", url);
    console.log("🌐 Using proxy:", !!proxyAgent);

    const response = await axios.post(
      url,
      {
        username: process.env.ESIM_USERNAME,
        password: process.env.ESIM_PASSWORD
      },
      {
        httpsAgent: proxyAgent,
        proxy: false        // IMPORTANT!!
      }
    );

    res.json({ ok: true, data: response.data });

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.json({ ok: false, error: err.toString() });
  }
});

app.listen(process.env.PORT || 10000, () =>
  console.log("Backend running!")
);