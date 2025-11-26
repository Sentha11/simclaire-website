import { useEffect, useState } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

function App() {
  const [destinations, setDestinations] = useState([]);
  const [filteredDestinations, setFilteredDestinations] = useState([]);
  const [loadingDest, setLoadingDest] = useState(false);
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
        setLoadingDest(true);
        setDestError("");
        const res = await fetch('${BACKEND_URL}/api/esim/destinations');
        const data = await res.json();
        setDestinations(data);
        setFilteredDestinations(data);
      } catch (err) {
        setDestError("Failed to load destinations.");
      } finally {
        setLoadingDest(false);
      }
    }
    loadDestinations();
  }, []);

  function handleSearch(e) {
    const q = e.target.value.toLowerCase();
    setSearch(e.target.value);
    setFilteredDestinations(
      destinations.filter((d) =>
        d.destinationName.toLowerCase().includes(q)
      )
    );
  }

  async function loadPlans(dest) {
    setSelectedDestination(dest);
    setSelectedPlan(null);
    setPlans([]);
    setPlansError("");

    try {
      setLoadingPlans(true);
      const res = await fetch('
        ${BACKEND_URL}/api/esim/products?destinationid=${dest.destinationID}'
      );
      const data = await res.json();
      const type1 = data.filter((p) => String(p.productType) === "1");
      if (!type1.length) {
        setPlansError("No instant eSIM plans available.");
      }
      setPlans(type1);
    } catch (err) {
      setPlansError("Failed to load plans.");
    } finally {
      setLoadingPlans(false);
    }
  }

  function resetAll() {
    setSelectedDestination(null);
    setPlans([]);
    setSelectedPlan(null);
    setQuantity(1);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="bg-white border-b p-4 font-semibold text-lg">
        SimClaire – eSIM Portal
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-6">
        {!selectedDestination && (
          <div className="bg-white border rounded-lg p-4 space-y-3">
            <h2 className="text-sm font-semibold">Choose destination</h2>

            <input
              value={search}
              onChange={handleSearch}
              placeholder="Search country…"
              className="w-full border rounded px-3 py-2 text-sm"
            />

            {destError && (
              <p className="text-xs text-red-500">{destError}</p>
            )}

            {loadingDest && (
              <p className="text-xs text-slate-500">Loading…</p>
            )}

            <div className="max-h-72 overflow-auto divide-y border rounded">
              {filteredDestinations.map((d) => (
                <button
                  key={d.destinationID}
                  onClick={() => loadPlans(d)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100"
                >
                  {d.destinationName}
                </button>
              ))}
            </div>
          </div>
        )}

        {selectedDestination && !selectedPlan && (
          <div className="bg-white border rounded-lg p-4 space-y-3">
            <div className="flex justify-between">
              <h2 className="text-sm font-semibold">
                Plans for {selectedDestination.destinationName}
              </h2>
              <button
                onClick={resetAll}
                className="text-xs underline text-slate-500"
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

            <div className="space-y-3">
              {plans.map((p) => (
                <button
                  key={p.productSku}
                  onClick={() => setSelectedPlan(p)}
                  className="w-full text-left border rounded p-3 text-sm hover:border-sky-500"
                >
                  <div className="font-medium">
                    {p.productDataAllowance} –{" "}
                    {p.productValidity} days
                  </div>
                  <div className="text-xs text-slate-600">
                    £{p.productPrice} • SKU: {p.productSku}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {selectedPlan && (
          <div className="bg-white border rounded-lg p-4 space-y-3">
            <h2 className="text-sm font-semibold">Review your plan</h2>

            <p className="text-sm">
              <strong>Destination:</strong>{" "}
              {selectedDestination.destinationName}
            </p>

            <p className="text-sm">
              <strong>Plan:</strong>{" "}
              {selectedPlan.productDataAllowance},{" "}
              {selectedPlan.productValidity} days
            </p>

            <p className="text-sm">
              <strong>Price:</strong> £{selectedPlan.productPrice}
            </p>

            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">Quantity</span>
              <input
                type="number"
                min="1"
                max="10"
                value={quantity}
                onChange={(e) =>
                  setQuantity(Math.max(1, Number(e.target.value)))
                }
                className="w-20 border rounded px-2 py-1 text-sm"
              />
            </div>

            <button className="w-full bg-sky-600 hover:bg-sky-700 text-white py-2 rounded text-sm font-medium">
              Continue via WhatsApp
            </button>

            <button
              onClick={() => alert("Stripe checkout will be added later.")}
              className="w-full border py-2 rounded text-sm text-slate-700"
            >
              (Future) Pay Online
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
