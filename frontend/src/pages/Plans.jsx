import { useState } from "react";
import "./plans.css";

export default function Plans() {
  const [query, setQuery] = useState("");
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(false);

  async function searchPlans(value) {
    setQuery(value);

    if (value.length < 3) {
      setPlans([]);
      return;
    }

    setLoading(true);

    const res = await fetch(
      `${import.meta.env.VITE_BACKEND_URL}/api/esim/search?country=${encodeURIComponent(value)}`
    );

    const data = await res.json();

    setPlans(
      data.sort((a, b) => a.price - b.price)
    );

    setLoading(false);
  }

  async function buy(plan) {
    const res = await fetch(
      `${import.meta.env.VITE_BACKEND_URL}/api/payments/create-checkout-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "test@simclaire.com",
          quantity: 1,
          price: plan.price,
          planName: plan.name,
          productSku: plan.sku,
          productType: plan.type,
          country: plan.country,
          destinationId: plan.destinationId,
        }),
      }
    );

    const data = await res.json();
    window.location.href = data.url;
  }

  return (
    <div className="plans">
      <h1>Choose your destination</h1>

      <input
        placeholder="Type a country (e.g. United Kingdom)"
        value={query}
        onChange={(e) => searchPlans(e.target.value)}
      />

      {loading && <div className="skeleton">Loading plans…</div>}

      <div className="plans-list">
        {plans.map((p, i) => (
          <div key={i} className="plan">
            <div className="plan-left">
              <strong>{p.name}</strong>
              <span>{p.data}GB</span>
              <span>{p.validity} days</span>
            </div>

            <div className="plan-right">
              <div className="price">£{p.price}</div>
              <button onClick={() => buy(p)}>Buy</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}