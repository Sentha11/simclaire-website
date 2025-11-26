import { useState } from "react";

function App() {
  const [step, setStep] = useState(1);

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif" }}>
      <h1>SimClaire – eSIM Portal</h1>
      <p>Minimal Skeleton Loaded (Step {step})</p>

      <button onClick={() => setStep(1)}>Step 1</button>
      <button onClick={() => setStep(2)}>Step 2</button>
      <button onClick={() => setStep(3)}>Step 3</button>
    </div>
  );
}

export default App;
