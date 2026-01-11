import { useState } from "react";

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
      `${import.meta.env.VITE_BACKEND_URL}/api/web/esim/search?country=${encodeURIComponent(value)}`
    );

    const data = await res.json();

    setPlans(data.sort((a, b) => a.price - b.price));
    setLoading(false);
  }

  async function buy(plan) {
    const res = await fetch(
      `${import.meta.env.VITE_BACKEND_URL}/api/payments/create-checkout-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "care@simclaire.com",
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
    <section className="section">
      <div className="container">
        <h2 className="h2">Choose your destination</h2>
        <p className="lead">
          Find the best eSIM plan for your trip. Instant activation after purchase.
        </p>

        <input
          className="input"
          placeholder="Type a country (e.g. United Kingdom)"
          value={query}
          onChange={(e) => searchPlans(e.target.value)}
          style={{
            padding: "14px",
            borderRadius: "12px",
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text)",
            width: "100%",
            maxWidth: "420px",
            marginBottom: "24px",
          }}
        />

        {loading && <div className="muted">Loading plans…</div>}

        <div className="grid grid--2">
          {plans.map((p, i) => (
            <div key={i} className="plan lift">
              <div className="plan__top">
                <div className="h3">{p.name}</div>
                <div className="muted">
                  {p.data} GB · {p.validity} days
                </div>
              </div>

              <div className="price">£{p.price}</div>

              <button
                className="btn btn--primary btn--full"
                onClick={() => buy(p)}
              >
                Buy eSIM
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}