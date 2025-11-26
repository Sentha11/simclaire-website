// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

app.use(cors());

// Twilio sends x-www-form-urlencoded for webhooks
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -----------------------------
// Config / Env
// -----------------------------
const ESIM_BASE_URL = process.env.ESIM_BASE_URL; // e.g. https://esim-api.com/api/esim
const ESIM_USERNAME = process.env.ESIM_USERNAME;
const ESIM_PASSWORD = process.env.ESIM_PASSWORD;

if (!ESIM_BASE_URL || !ESIM_USERNAME || !ESIM_PASSWORD) {
  console.warn('⚠️ ESIM environment variables are not fully set.');
}

// -----------------------------
// Simple in-memory session store for WhatsApp
// In production, move to Redis or DB
// -----------------------------
const sessions = {}; // key = whatsapp number, value = state object

// States:
// step: 'START' | 'WAIT_COUNTRY' | 'WAIT_PLAN' | 'WAIT_QTY' | 'WAIT_MOBILE' | 'WAIT_EMAIL' | 'COMPLETE'
// we also store: country, destinationId, products[], selectedProduct, quantity, mobile, email

// -----------------------------
// eSIM API helper: auth + token caching
// -----------------------------
let esimToken = null;
let esimTokenExpiresAt = 0; // timestamp ms

async function getEsimToken() {
  const now = Date.now();
  if (esimToken && now < esimTokenExpiresAt) {
    return esimToken;
  }

  const res = await axios.post(${ESIM_BASE_URL}/authenticate, {
    userName: ESIM_USERNAME,
    password: ESIM_PASSWORD,
  });

  // Doc returns token + expirySeconds (if provided; if not, we just cache for 10 mins)
  const data = res.data;
  esimToken = data.token;
  const ttlSeconds = data.expirySeconds || 600;
  esimTokenExpiresAt = now + ttlSeconds * 1000;

  console.log('✅ eSIM token refreshed');
  return esimToken;
}

async function esimRequest(method, path, options = {}) {
  const token = await getEsimToken();
  try {
    const res = await axios({
      method,
      url: ${ESIM_BASE_URL}${path},
      headers: {
        Authorization: Bearer ${token},
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });
    return res.data;
  } catch (err) {
    // Retry once on 401
    if (err.response && err.response.status === 401) {
      console.warn('Token expired, refreshing…');
      esimToken = null;
      const newToken = await getEsimToken();
      const res2 = await axios({
        method,
        url: ${ESIM_BASE_URL}${path},
        headers: {
          Authorization: Bearer ${newToken},
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        ...options,
      });
      return res2.data;
    }
    console.error('eSIM API error:', err.response?.data || err.message);
    throw err;
  }
}

// -----------------------------
// eSIM API proxy endpoints (optional but handy for testing from Postman)
// -----------------------------

// Health check
app.get('/api/status', (req, res) => {
  res.json({ status: 'OK', message: 'Backend is running' });
});

// Get destinations (countries/regions)
app.get('/api/esim/destinations', async (req, res) => {
  try {
    const data = await esimRequest('get', '/destinations');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch destinations' });
  }
});

// Get products for a destination (we’ll filter productType=1 for WhatsApp use)
app.get('/api/esim/products', async (req, res) => {
  const { destinationid } = req.query;
  if (!destinationid) {
    return res.status(400).json({ error: 'destinationid is required' });
  }
  try {
    const data = await esimRequest('get', /products?destinationid=${encodeURIComponent(destinationid)});
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Purchase eSIM (productType=1, no KYC) – single line item for now
app.post('/api/esim/purchase', async (req, res) => {
  const { sku, quantity, mobileno, emailid } = req.body;
  if (!sku || !quantity || !mobileno || !emailid) {
    return res.status(400).json({ error: 'sku, quantity, mobileno, and emailid are required' });
  }

  try {
    const payload = {
      items: [
        {
          type: '1', // productType 1 (no KYC)
          sku,
          quantity,
          mobileno,
          emailid,
        },
      ],
    };

    const data = await esimRequest('post', '/purchaseesim', { data: payload });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to purchase eSIM' });
  }
});

// -----------------------------
// WhatsApp Webhook (Twilio)
// -----------------------------
//
// Twilio will POST application/x-www-form-urlencoded with fields like:
// From, WaId, Body, ProfileName, etc.
// We reply with TwiML XML: <Response><Message>…</Message></Response>
// -----------------------------

function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${message}</Message>
</Response>`;
}

// Utility: clean text
function cleanText(t) {
  return (t || '').trim();
}

// Utility: get or create session
function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      step: 'START',
      country: null,
      destinationId: null,
      products: [],
      selectedProduct: null,
      quantity: 1,
      mobile: null,
      email: null,
    };
  }
  return sessions[userId];
}

app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.WaId || req.body.From || 'unknown';
  const body = cleanText(req.body.Body);

  const session = getSession(from);

  console.log('📲 Incoming WhatsApp:', { from, body, step: session.step });

  try {
    // Global reset command
    if (/^(restart|reset|start over)$/i.test(body)) {
      sessions[from] = null;
      const msg = `Okay, let's start again. 🌍

Where are you travelling?
Reply with the country name (e.g., "Italy", "USA", "Japan") or type "Global".`;
      res.set('Content-Type', 'text/xml');
      return res.send(twiml(msg));
    }

    // State machine
    if (session.step === 'START') {
      session.step = 'WAIT_COUNTRY';
      const msg = `👋 Welcome to SimClaire eSIMs!

I’ll help you get travel data in a few steps.

🌍 Where are you travelling?
Reply with the country name (e.g., "Italy", "USA", "Japan") or type "Global".`;
      res.set('Content-Type', 'text/xml');
      return res.send(twiml(msg));
    }

    if (session.step === 'WAIT_COUNTRY') {
      // Fetch destinations and match
      const countryInput = body.toLowerCase();

      const destinations = await esimRequest('get', '/destinations');
      // Expecting array with destinationName, isoCode, destinationID etc.
      const matched = destinations.find((d) => {
        const name = (d.destinationName || '').toLowerCase();
        const iso = (d.isoCode || '').toLowerCase();
        return name === countryInput || iso === countryInput || name.includes(countryInput);
      });

      if (!matched) {
        const msg = `I couldn't find that destination.

Please reply with the country name (for example: "Italy", "Spain", "USA") or ISO code like "US", "GB", "FR".`;
        res.set('Content-Type', 'text/xml');
        return res.send(twiml(msg));
      }

      session.country = matched.destinationName;
      session.destinationId = matched.destinationID;

      // Get products for that destination
      const products = await esimRequest(
        'get',
        /products?destinationid=${encodeURIComponent(matched.destinationID)}
      );

      // Filter productType=1 only (no KYC)
      const type1Products = (products || []).filter(
        (p) => String(p.productType) === '1'
      );

      if (!type1Products.length) {
        const msg = `Currently we don't have any instant eSIMs (no-KYC) for ${matched.destinationName}.

You may try another destination.`;
        session.step = 'WAIT_COUNTRY';
        res.set('Content-Type', 'text/xml');
        return res.send(twiml(msg));
      }

      // Save up to top 5 products
      session.products = type1Products.slice(0, 5);
      session.step = 'WAIT_PLAN';

      let plansText = session.products
        .map((p, idx) => {
          const data = p.productDataAllowance || p.productName || '';
          const validity = p.productValidity ? ${p.productValidity} days : '';
          const price = p.productPrice != null ? £${p.productPrice} : '';
          return ${idx + 1}) ${data} ${validity} ${price};
        })
        .join('\n');

      const msg = `Great! You're travelling to ${matched.destinationName} 🇺🇳

Here are some eSIM options:

${plansText}

Reply with 1, 2, 3, ... to choose your plan.`;
      res.set('Content-Type', 'text/xml');
      return res.send(twiml(msg));
    }

    if (session.step === 'WAIT_PLAN') {
      const choice = parseInt(body, 10);
      if (
        Number.isNaN(choice) ||
        choice < 1 ||
        choice > session.products.length
      ) {
        const msg = Please reply with a number between 1 and ${session.products.length} to pick a plan.;
        res.set('Content-Type', 'text/xml');
        return res.send(twiml(msg));
      }

      const product = session.products[choice - 1];
      session.selectedProduct = product;
      session.step = 'WAIT_QTY';

      const data = product.productDataAllowance || product.productName || '';
      const validity = product.productValidity
        ? ${product.productValidity} days
        : '';
      const price = product.productPrice != null ? £${product.productPrice} : '';

      const msg = `✅ You chose:

${data} ${validity} for ${session.country} at ${price}.

How many eSIMs do you need?
Reply with a number (e.g., 1, 2, 3).`;
      res.set('Content-Type', 'text/xml');
      return res.send(twiml(msg));
    }

    if (session.step === 'WAIT_QTY') {
      const qty = parseInt(body, 10);
      if (Number.isNaN(qty) || qty < 1 || qty > 10) {
        const msg = Please reply with a valid quantity between 1 and 10.;
        res.set('Content-Type', 'text/xml');
        return res.send(twiml(msg));
      }
      session.quantity = qty;
      session.step = 'WAIT_MOBILE';

      const msg = `👍 Got it – ${qty} eSIM(s).

Please reply with your mobile number (with country code), for example:
+44 7123 456789`;
      res.set('Content-Type', 'text/xml');
      return res.send(twiml(msg));
    }

    if (session.step === 'WAIT_MOBILE') {
      // Basic validation
      const mobile = body.replace(/\s+/g, '');
      if (!/^\+?\d{6,15}$/.test(mobile)) {
        const msg = `Please send a valid mobile number with country code, for example:
+44 7123 456789`;
        res.set('Content-Type', 'text/xml');
        return res.send(twiml(msg));
      }

      session.mobile = mobile;
      session.step = 'WAIT_EMAIL';

      const msg = 📧 Great. Now please reply with your *email address* so we can send your eSIM details and QR code.;
      res.set('Content-Type', 'text/xml');
      return res.send(twiml(msg));
    }

    if (session.step === 'WAIT_EMAIL') {
      const email = body;
      // Very basic email check
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        const msg = `Please send a valid email address, for example:
name@example.com`;
        res.set('Content-Type', 'text/xml');
        return res.send(twiml(msg));
      }

      session.email = email;
      session.step = 'COMPLETE';

      const product = session.selectedProduct;
      const data = product.productDataAllowance || product.productName || '';
      const validity = product.productValidity
        ? ${product.productValidity} days
        : '';
      const price = product.productPrice != null ? £${product.productPrice} : '';

      // Call purchase API
      try {
        const payload = {
          items: [
            {
              type: '1', // productType 1 (no KYC)
              sku: product.productSku,
              quantity: session.quantity,
              mobileno: session.mobile,
              emailid: session.email,
            },
          ],
        };

        const purchaseRes = await esimRequest('post', '/purchaseesim', {
          data: payload,
        });

        // Expecting purchaseRes.esims[0].activationcode or similar
        const esimInfo = Array.isArray(purchaseRes.esims)
          ? purchaseRes.esims[0]
          : null;

        let msg;
        if (esimInfo && esimInfo.activationcode) {
          msg = `🎉 Your eSIM order is complete!

Destination: ${session.country}
Plan: ${data} ${validity}
Quantity: ${session.quantity}
Total: ${price} x ${session.quantity}

Your activation code (LPA):
${esimInfo.activationcode}

We’ve also emailed full details to:
${session.email}

To install:
1. Go to your device settings and add eSIM / mobile plan.
2. When prompted, choose 'Enter details manually' or 'Use activation code'.
3. Paste the activation code above.

If you need help at any time, just reply "support".`;
        } else {
          console.error('Unexpected purchase response:', purchaseRes);
          msg = `Your order was received, but we couldn't retrieve the eSIM details automatically.

Our team will review and send your eSIM QR and instructions to:
${session.email}

If you have any questions, reply "support".`;
        }

        // Reset session
        sessions[from] = null;

        res.set('Content-Type', 'text/xml');
        return res.send(twiml(msg));
      } catch (err) {
        console.error('Purchase error:', err.response?.data || err.message);
        session.step = 'WAIT_EMAIL'; // allow them to retry or we handle differently
        const msg = `Something went wrong while processing your eSIM order.

You can try again in a few minutes, or reply "support" and we’ll look into it.`;
        res.set('Content-Type', 'text/xml');
        return res.send(twiml(msg));
      }
    }

    // Fallback
    const fallbackMsg = `I got a bit lost. 😅

Reply "restart" to start again, or tell me which country you're travelling to.`;
    res.set('Content-Type', 'text/xml');
    return res.send(twiml(fallbackMsg));
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
    res.set('Content-Type', 'text/xml');
    return res.send(
      twiml(
        'Something went wrong on our side. Please try again in a moment or reply "restart" to start over.'
      )
    );
  }
});

// -----------------------------
// Start server
// -----------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(Backend running on port ${PORT});
});
