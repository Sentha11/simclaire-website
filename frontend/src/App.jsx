import { useEffect, useState } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

function App() {
  const [destinations, setDestinations] = useState([]);
  const [filteredDestinations, setFilteredDestinations] = useState([]);
  const [loadingDestinations, setLoadingDestinations] = useState(false);
  const [destError, setDestError] = useState("");

  const [selectedDestination, setSelectedDestination] = useState(null);
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [plansError, setPlansError] = useState("");

  const [selectedPlan, setSelectedPlan] = useState(null);
  const [quantity, setQuantity] = useState(1);

  const [search, setSearch] = useState("");

  useEffect(() => {
    async function loadDestinations() {
      try {
        setLoadingDestinations(true);
        setDestError("");
        const res = await fetch(${BACKEND_URL}/api/esim/destinations);
        if (!res.ok) throw new Error("Failed to load destinations");
        const data = await res.json();
        setDestinations(data || []);
        setFilteredDestinations(data || []);
      } catch (err) {
        console.error(err);
        setDestError("Could not load destinations. Please try again later.");
      } finally {
        setLoadingDestinations(false);
      }
    }
    loadDestinations();
  }, []);

  function handleSearchChange(e) {
    const value = e.target.value;
    setSearch(value);
    const q = value.toLowerCase();
    setFilteredDestinations(
      destinations.filter((d) => {
        const name = (d.destinationName || "").toLowerCase();
        const iso = (d.isoCode || "").toLowerCase();
        return name.includes(q) || iso.includes(q);
      })
    );
  }

  async function handleSelectDestination(dest) {
    setSelectedDestination(dest);
    setSelectedPlan(null);
    setPlans([]);
    setPlansError("");
    try {
      setLoadingPlans(true);
      const res = await fetch(
        `${BACKEND_URL}/api/esim/products?destinationid=${encodeURIComponent(
          dest.destinationID
        )}`
      );
      if (!res.ok) throw new Error("Failed to load plans");
      const data = await res.json();
      // Filter productType = 1 (no KYC)
      const type1Plans = (data || []).filter(
        (p) => String(p.productType) === "1"
      );
      setPlans(type1Plans);
      if (!type1Plans.length) {
        setPlansError("No instant eSIM plans available for this destination yet.");
      }
    } catch (err) {
      console.error(err);
      setPlansError("Could not load plans. Please try again.");
    } finally {
      setLoadingPlans(false);
    }
  }

  function resetAll() {
    setSelectedDestination(null);
    setSelectedPlan(null);
    setPlans([]);
    setQuantity(1);
    setPlansError("");
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="font-semibold text-lg tracking-tight">
            SimClaire
          </div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">
            eSIM Portal (Beta)
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Intro */}
        <section className="space-y-2">
          <h1 className="text-2xl font-semibold">
            Simple travel eSIMs, no hassle.
          </h1>
          <p className="text-sm text-slate-600 max-w-xl">
            Choose where you&apos;re travelling, pick a plan, and we&apos;ll
            handle the rest. This is a minimalist flow built to mirror what
            we&apos;re doing on WhatsApp.
          </p>
        </section>

        {/* Stepper */}
        <section className="flex flex-wrap gap-3 text-xs text-slate-600">
          <StepChip active={!selectedDestination}>
            1. Choose destination
          </StepChip>
          <StepChip active={!!selectedDestination && !selectedPlan}>
            2. Pick plan
          </StepChip>
          <StepChip active={!!selectedPlan}>
            3. Review & next steps
          </StepChip>
        </section>

        {/* Destination selector */}
        {!selectedDestination && (
          <section className="bg-white rounded-xl shadow-sm border p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-sm">Where are you travelling?</h2>
              {loadingDestinations && (
                <span className="text-[11px] text-slate-500">Loading…</span>
              )}
            </div>

            <input
              type="text"
              placeholder="Search country or ISO code (e.g., Italy, US, GB)…"
              value={search}
              onChange={handleSearchChange}
              className="w-full text-sm border rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
            />

            {destError && (
              <p className="text-xs text-red-500">{destError}</p>
            )}

            <div className="max-h-72 overflow-auto border rounded-lg divide-y bg-slate-50">
              {filteredDestinations.map((d) => (
                <button
                  key={d.destinationID}
                  onClick={() => handleSelectDestination(d)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-white flex items-center justify-between"
                >
                  <span>
                    {d.destinationName}{" "}
                    <span className="text-[11px] text-slate-500 uppercase">
                      {d.isoCode}
                    </span>
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {d.continent}
                  </span>
                </button>
              ))}

              {!loadingDestinations &&
                !destError &&
                filteredDestinations.length === 0 && (
                  <div className="px-3 py-2 text-xs text-slate-500">
                    No destinations match your search.
                  </div>
                )}
            </div>
          </section>
        )}

        {/* Plan selector */}
        {selectedDestination && !selectedPlan && (
          <section className="bg-white rounded-xl shadow-sm border p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold text-sm">
                  Plans for {selectedDestination.destinationName}
                </h2>
                <p className="text-[11px] text-slate-500">
                  Only instant eSIMs (no-KYC, productType=1) are shown here.
                </p>
              </div>
              <button
                onClick={resetAll}
                className="text-[11px] text-slate-500 hover:text-slate-700 underline"
              >
                Change destination
              </button>
            </div>

            {loadingPlans && (
              <p className="text-xs text-slate-500">Loading plans…</p>
            )}

            {plansError && (
              <p className="text-xs text-red-500">{plansError}</p>
            )}

            {!loadingPlans && !plansError && plans.length === 0 && (
              <p className="text-xs text-slate-500">
                No plans found for this destination.
              </p>
            )}

            <div className="grid gap-3 md:grid-cols-2">
              {plans.map((p) => (
                <button
                  key={p.productSku}
                  onClick={() => setSelectedPlan(p)}
                  className="border rounded-lg p-3 text-left text-sm hover:border-sky-500 hover:shadow-sm transition"
                >
                  <div className="font-medium">
                    {p.productDataAllowance || p.productName}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {p.productValidity
                      ? ${p.productValidity} days
                      : ""}
                  </div>
                  <div className="mt-2 text-sm font-semibold">
                    {p.productPrice != null ? £${p.productPrice} : "Price TBA"}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    SKU: {p.productSku}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Review & next steps */}
        {selectedDestination && selectedPlan && (
          <section className="bg-white rounded-xl shadow-sm border p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-sm">Review your selection</h2>
              <button
                onClick={() => setSelectedPlan(null)}
                className="text-[11px] text-slate-500 hover:text-slate-700 underline"
              >
                Change plan
              </button>
            </div>

            <div className="text-sm space-y-1">
              <p>
                <span className="font-medium">Destination:</span>{" "}
                {selectedDestination.destinationName}
              </p>
              <p>
                <span className="font-medium">Plan:</span>{" "}
                {selectedPlan.productDataAllowance || selectedPlan.productName}{" "}
                {selectedPlan.productValidity
                  ? • ${selectedPlan.productValidity} days
                  : ""}
              </p>
              <p>
                <span className="font-medium">Price:</span>{" "}
                {selectedPlan.productPrice != null
                  ? £${selectedPlan.productPrice}
                  : "TBA"}
              </p>
            </div>

            <div className="flex items-center gap-3 text-sm">
              <label className="text-sm font-medium">Quantity</label>
              <input
                type="number"
                min={1}
                max={10}
                value={quantity}
                onChange={(e) =>
                  setQuantity(
                    Math.min(10, Math.max(1, Number(e.target.value) || 1))
                  )
                }
                className="w-20 border rounded-lg px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
              />
            </div>

            <div className="text-sm text-slate-600 bg-slate-50 border rounded-lg p-3">
              <p className="font-medium mb-1">What happens next?</p>
              <p className="text-[13px]">
                In this phase, we&apos;re mirroring the WhatsApp flow:
                you&apos;ll confirm your plan here, and the actual purchase /
                activation will be handled by the backend + WhatsApp assistant.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="px-4 py-2 text-sm font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700"
              >
                Continue via WhatsApp
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm font-medium rounded-lg border text-slate-700 hover:bg-slate-50"
                onClick={() => {
                  // Placeholder for future Stripe integration
                  alert(
                    "Stripe checkout integration will be added here in the next phase."
                  );
                }}
              >
                (Future) Pay Online
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function StepChip({ active, children }) {
  return (
    <div
      className={`px-3 py-1 rounded-full border text-[11px] ${
        active
          ? "border-sky-500 text-sky-700 bg-sky-50"
          : "border-slate-200 text-slate-500 bg-white"
      }`}
    >
      {children}
    </div>
  );
}

export default App;
