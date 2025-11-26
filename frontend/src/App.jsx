import { useEffect, useState } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

function App() {
  const [step, setStep] = useState(1);

  // Destination state
  const [destinations, setDestinations] = useState([]);
  const [filteredDestinations, setFilteredDestinations] = useState([]);
  const [search, setSearch] = useState("");
  const [loadingDest, setLoadingDest] = useState(false);
  const [destError, setDestError] = useState("");

  // ---------------------------------------------
  // LOAD DESTINATIONS FROM BACKEND
  // ---------------------------------------------
  useEffect(() => {
    async function loadDestinations() {
      try {
        setLoadingDest(true);
        setDestError("");

        // SAFE backtick usage:
        const url = ${BACKEND_URL}/api/esim/destinations;

        const res = await fetch(url);
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

  // ---------------------------------------------
  // SEARCH FILTER
  // ---------------------------------------------
  function handleSearch(e) {
    const q = e.target.value.toLowerCase();
    setSearch(e.target.value);

    const filtered = destinations.filter((d) =>
      d.destinationName.toLowerCase().includes(q)
    );

    setFilteredDestinations(filtered);
  }

  // ---------------------------------------------
  // RENDER UI
  // ---------------------------------------------
  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif" }}>
      <h1>SimClaire – eSIM Portal</h1>
      <p style={{ color: "#666" }}>Step {step} / 3</p>

      {/* STEP 1: DESTINATION PICKER */}
      {step === 1 && (
        <div style={{ marginTop: "20px" }}>
          <h2>Choose your destination</h2>

          {loadingDest && <p>Loading destinations…</p>}
          {destError && <p style={{ color: "red" }}>{destError}</p>}

          <input
            type="text"
            placeholder="Search country…"
            value={search}
            onChange={handleSearch}
            style={{
              width: "100%",
              padding: "10px",
              marginTop: "10px",
              marginBottom: "20px",
              borderRadius: "5px",
              border: "1px solid #ccc"
            }}
          />

          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: "5px",
              maxHeight: "300px",
              overflowY: "auto"
            }}
          >
            {filteredDestinations.map((d) => (
              <button
                key={d.destinationID}
                onClick={() => setStep(2)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px",
                  background: "white",
                  borderBottom: "1px solid #eee"
                }}
              >
                {d.destinationName}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* STEP 2 Placeholder */}
      {step === 2 && (
        <div style={{ marginTop: "20px" }}>
          <h2>Plans (coming next)</h2>
          <button onClick={() => setStep(1)}>Back</button>
        </div>
      )}
    </div>
  );
}

export default App;
