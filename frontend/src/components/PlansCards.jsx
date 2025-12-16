const API_BASE = import.meta.env.VITE_API_BASE_URL;

async function startCheckout(plan) {
  // Expect your backend to return: { url: "https://checkout.stripe.com/..." }
  const res = await fetch(`${API_BASE}/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plan, // "monthly" | "yearly"
      // optionally include quantity, email, etc.
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Checkout failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data?.url) throw new Error("Backend did not return checkout url");

  window.location.href = data.url;
}

export default function PlansCards() {
  return (
    <div className="grid grid--2">
      <div className="plan lift">
        <div className="plan__top">
          <h3 className="h3">Monthly</h3>
          <div className="price">$9.99</div>
          <div className="muted">Cancel anytime</div>
        </div>
        <button
          className="btn btn--primary btn--full"
          onClick={() => startCheckout("monthly")}
          type="button"
        >
          Get Monthly
        </button>
      </div>

      <div className="plan plan--featured lift">
        <div className="plan__top">
          <h3 className="h3">Yearly</h3>
          <div className="price">$99</div>
          <div className="muted">Save 15%</div>
        </div>
        <button
          className="btn btn--primary btn--full"
          onClick={() => startCheckout("yearly")}
          type="button"
        >
          Get Yearly
        </button>
      </div>
    </div>
  );
}