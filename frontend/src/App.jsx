import { useState } from "react";

function App() {
  const [search, setSearch] = useState("");
  const [step, setStep] = useState(1);

  // Fake static destinations for now
  const demoDestinations = [
    { id: 1, name: "United States" },
    { id: 2, name: "United Kingdom" },
    { id: 3, name: "France" },
    { id: 4, name: "Japan" }
  ];

  const filtered = demoDestinations.filter((d) =>
    d.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif" }}>
      <h1>SimClaire – eSIM Portal</h1>

      {/* Step Indicator */}
      <p style={{ color: "#666" }}>Step {step} / 3</p>

      {/* Step 1: Choose Destination */}
      {step === 1 && (
        <div style={{ marginTop: "20px" }}>
          <h2>Choose your destination</h2>

          <input
            type="text"
            placeholder="Search country…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%",
              padding: "10px",
              marginTop: "10px",
              marginBottom: "20px",
              borderRadius: "5px",
              border: "1px solid #ccc"
            }}
          />

          <div style={{ border: "1px solid #ddd", borderRadius: "5px" }}>
            {filtered.map((d) => (
              <button
                key={d.id}
                onClick={() => setStep(2)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px",
                  borderBottom: "1px solid #eee",
                  background: "#fff"
                }}
              >
                {d.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2 Placeholder */}
      {step === 2 && (
        <div style={{ marginTop: "20px" }}>
          <h2>Plans (placeholder)</h2>
          <button onClick={() => setStep(1)}>Back</button>
        </div>
      )}
    </div>
  );
}

export default App;
