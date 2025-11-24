
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/status', (req, res) => {
  res.json({ status: "OK", message: "Backend is running" });
});

app.get('/api/products', (req, res) => {
  res.json([
    { id: 1, country: "USA", plan: "5GB", price: 10 },
    { id: 2, country: "USA", plan: "10GB", price: 18 }
  ]);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
