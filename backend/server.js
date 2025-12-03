// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

// ------------------------------------
// 🔐 QuotaGuard STATIC Proxy (Stable)
// ------------------------------------

let proxyAgent = null;

if (process.env.QUOTAGUARD_URL) {
  try {
  proxyAgent = new HttpsProxyAgent (process.env.QUOTAGUARD_URL);
  console.log("🔐 QuotaGuard STATIC proxy enabled!");
  console.log(" QUOTAGUARD_URL =", process.env.QUOTAGUARD_URL);
} catch (err) {
  console.error("⚠️ Failed to create proxy agent:", err.message);
}
} else {
  console.warn(" ⚠️ QUOTAGUARD_URL not set - calls will go direct (no proxy).");
}

// ------------------------------------
const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -----------------------------
// ENV
// -----------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL;
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  console.warn ("⚠️ missing esim api environment variables");
}
// -----------------------------
// Token cache
// -----------------------------
let esimToken = null;
let esimTokenExpiresAt = 0;

// gets esim function
async function getEsimToken() {
  const now = Date.now();

  if (esimToken && now < esimTokenExpiresAt) return esimToken;
}
  const url = `${ESIM_BASE_URL}/authenticate`;
  console.log("GetEsimToken ->", url);
  console.log("Using proxy:", !!proxyAgent);

  try {
  const res = await axios.post(
    url,
    {
      userName: ESIM_USERNAME,
      password: ESIM_PASSWORD
    },
    {
      httpsAgent: proxyAgent || undefined,
      proxy: false,
    }
  );

  esimToken = res.data.token;
  const ttlSeconds = res.data.expirySeconds || 600;
  esimTokenExpiresAt = now + ttlSeconds * 1000;

  console.log("🔐 eSIM token refreshed");
  return esimToken;
}catch(err) {
  console.error(
    " getEsimToken error:",
    err.code,
    err.response?.status,
    err.response?.data || err.message
  );
  throw err;
}

// -----------------------------
// FLAG EMOJI
// -----------------------------
function flagEmoji(code) {
  if (!code) return "";
  return code
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// -----------------------------
// UNIVERSAL eSIM REQUEST
// -----------------------------
async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const url =  `${ESIM_BASE_URL}${path}`;

  console.log("🔗 esimRequest →", method.toUpperCase(), url);

  const Config = {
    method,
    url,
    httpsAgent: proxyAgent || undefined,
    proxy: false,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  };

  try {
    const res = await axios(axiosConfig);
    return res.data;
  } catch (err) {
    console.error(
      " esimrequest error:",
      err.code,
      err.response?.status,
      err.response?.data || err.message
    );

    // retry on 401
    if (err.response && err.response.status === 401) {
      esimToken = null;
      const newToken = await getEsimToken();
      Config.headers.Authorization = `Bearer ${newToken}`;
      const retry = await axios(Config);
      return retry.data;
    }
    throw err;
  }
}
/*async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  const url = `${ESIM_BASE_URL}${path}`;
  console.log("esimRequest ->", method.toUpperCase(), url);
  console.log("Using proxy:", !!proxyAgent);


  try {
    const res = await axios({
      method,
      url,
      //httpsAgent: proxyAgent || undefined,
      //proxy: false,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...options
    });

    if (proxyAgent) {
      axiosConfig.httpsAgent = proxyAgent;
      axiosConfig.proxy = false;
    }

    return res.data;
  } catch (err) {
    // Retry on expired token
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
          ...(options.headers || {})
        },
        ...options
      });

      return retry.data;
    }

    console.error("❌ eSIM API Request Error:", err.response?.data || err.message);
    throw err;
  }
}
*/
// -----------------------------
// STATUS ENDPOINT
// -----------------------------
app.get("/api/status", (req, res) => {
  res.json({ status: "OK", message: "Backend is running" });
});

// -----------------------------
// TEST AUTH
// -----------------------------
app.get("/api/test-auth", async (req, res) => {
  try {
    const token = await getEsimToken();
    res.json({ ok: true, token });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -----------------------------
// DESTINATIONS
// -----------------------------
app.get("/api/esim/destinations", async (req, res) => {
  try {
    const data = await esimRequest("get", "/destinations");
    res.json(data);
  } catch {
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
  } catch {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// -----------------------------
// PURCHASE
// -----------------------------
app.post("/api/esim/purchase", async (req, res) => {
  const { sku, quantity, mobileno, emailid } = req.body;

  if (!sku || !quantity || !mobileno || !emailid)
    return res.status(400).json({ error: "Missing fields" });

  try {
    const payload = {
      items: [
        {
          type: "1",
          sku,
          quantity,
          mobileno,
          emailid
        }
      ]
    };

    const result = await esimRequest("post", "/purchaseesim", { data: payload });
    res.json(result);
 } catch (err) {
    res.status(500).json({ error: "Failed to purchase eSIM" });
  }
});

// ======================================================
// WHATSAPP BOT
// ======================================================
function twiml(msg) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${msg}</Message></Response>`;
}

const sessions = {};

function getSession(id) {
  if (!sessions[id])
    sessions[id] = {
      step: "START",

      products: []
    };
  return sessions[id];
}

app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.WaId || req.body.From;
  const text = (req.body.Body || "").trim().toLowerCase();
  const s = getSession(from);

  console.log("📩 Incoming:", text);

  try {
    // Start
    if (s.step === "START") {
      s.step = "WAIT_COUNTRY";
      return res
        .set("Content-Type", "text/xml")
        .send(twiml("👋 Welcome to SimClaire!\n\nWhere are you travelling?"));
    }

    // Country
    if (s.step === "WAIT_COUNTRY") {
      const data = await esimRequest("get", "/destinations");
      const list = data.data;

      const match = list.find(
        (d) =>
          d.destinationName.toLowerCase() === text ||
          d.isoCode.toLowerCase() === text ||
          d.destinationName.toLowerCase().includes(text)
      );

      if (!match)
        return res
          .set("Content-Type", "text/xml")
          .send(twiml("Couldn't find that country — try again."));

      s.country = match.destinationName;
      s.countryIso = match.isoCode;
      s.destinationId = match.destinationID;

      const emoji = flagEmoji(match.isoCode);

      const productsRes = await esimRequest(
        "get",
        `/products?destinationid=${match.destinationID}`
      );

      const type1 = productsRes.data.filter((p) => String(p.productType) === "1");

      if (!type1.length)
        return res
          .set("Content-Type", "text/xml")
          .send(
            twiml(
              `${emoji} No instant eSIMs available for ${match.destinationName}.`
            )
          );

      s.products = type1.slice(0, 5);
      s.step = "WAIT_PLAN";

      let listText = s.products
        .map((p, i) => {
          let price = p.productPrice ? `£${p.productPrice}` : "";
          let validity = p.productValidity ? `${p.productValidity} days` : "";
          return `${i + 1}) ${p.productDataAllowance} ${validity} ${price}`;
        })
        .join("\n");

      return res
        .set("Content-Type", "text/xml")
        .send(
          twiml(
            `${emoji} Great — you're travelling to ${match.destinationName}!\n\nHere are the plans:\n${listText}\n\nReply with 1,2,3…`
          )
        );
    }
  } catch (err) {
    console.error("❌ WhatsApp webhook error:", err);
    return res
      .set("Content-Type", "text/xml")
      .send(twiml("Something went wrong — try again."));
  }
});

// -----------------------------
// START SERVER
// -----------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🔥 Backend running on port ${PORT}`));