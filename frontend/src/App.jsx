import { useEffect, useState } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

function App() {
  const [step, setStep] = useState(1);

  const [destinations, setDestinations] = useState([]);
  const [filteredDestinations, setFilteredDestinations] = useState([]);
  const [search, setSearch] = useState("");
  const [loadingDest, setLoadingDest] = useState(false);
  const [destError, setDestError] = useState("");

  // LOAD DESTINATIONS
  useEffect(() => {
    async function loadDestinations() {
      try {
        setLoadingDest(true);
        setDestError("");

        const res = await fetch(
          `${BACKEND_URL}/api/esim/destinations`
        );

        if (!res.ok) {
          throw new Error("Failed to fetch destinations");
        }

        const data = await res.json();
        setDestinations(data);
        setFilteredDestinations(data);
      } catch (e) {
        setDestError("Could not load destinations.");
      } finally {
        setLoadingDest(false);
      }
    }

    loadDestinations();
  }, []);

  // SEARCH FILTER
  function handleSearch(e) {
    const q = e.target.value.toLowerCase();
    setSearch(e.target.value);

    setFilteredDestinations(
      destinations.filter((d) =>
        d.destinationName.toLowerCase().includes(q)
      )
    );
  }

  return (
    <div className="min-h-screen bg-bg font-sans text-dark">
      {/* HEADER */}
      <header className="bg-dark text-white px-6 py-4">
        <h1 className="text-xl font-semibold">
          SimClaire – eSIM Portal
        </h1>
      </header>

      <main className="max-w-3xl mx-auto p-6">
        <p className="text-sm text-muted mb-4">
          Step {step} of 3
        </p>

        {/* STEP 1 */}
        {step === 1 && (
          <div>
            <h2 className="text-2xl font-bold mb-4">
              Choose your destination
            </h2>

            {loadingDest && (
              <p className="text-muted">Loading destinations…</p>
            )}

            {destError && (
              <p className="text-red-600">{destError}</p>
            )}

            <input
              type="text"
              placeholder="Search country…"
              value={search}
              onChange={handleSearch}
              className="w-full p-3 border rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
            />

            <div className="border rounded-lg max-h-80 overflow-y-auto shadow-card">
              {filteredDestinations.map((d) => (
                <button
                  key={d.destinationID}
                  onClick={() => setStep(2)}
                  className="w-full text-left px-4 py-3 border-b hover:bg-bg transition"
                >
                  {d.destinationName}
                </button>
              ))}

              {filteredDestinations.length === 0 && (
                <p className="p-4 text-muted">
                  No destinations found.
                </p>
              )}
            </div>
          </div>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <div>
            <h2 className="text-2xl font-bold mb-4">
              Plans (Coming next)
            </h2>

            <button
              onClick={() => setStep(1)}
              className="mt-4 text-primary hover:underline"
            >
              ← Back to destinations
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
