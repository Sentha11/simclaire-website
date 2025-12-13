<h1 className="bg-red-500 text-white text-5xl">
  NEW UI CONFIRMED
</h1>
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
  <div className="min-h-screen bg-bg text-text">
    {/* NAVBAR */}
    <header className="bg-dark text-white">
      <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
        <h1 className="text-xl font-semibold">SimClaire</h1>
        <nav className="space-x-6 text-sm">
          <a href="#how" className="hover:text-accent">How it works</a>
          <a href="#faq" className="hover:text-accent">FAQ</a>
          <a href="#support" className="hover:text-accent">Support</a>
        </nav>
      </div>
    </header>

    {/* HERO */}
    <section className="bg-gradient-to-br from-primary to-blue-700 text-white">
      <div className="max-w-6xl mx-auto px-6 py-20 text-center">
        <h2 className="text-4xl md:text-5xl font-bold mb-4">
          Your own dedicated travel number
        </h2>
        <p className="text-lg text-blue-100 max-w-2xl mx-auto mb-8">
          Recharge monthly or yearly. Not a roaming number.
          One number. Full control. Global coverage.
        </p>
        <button
          onClick={() => setStep(1)}
          className="bg-white text-primary font-semibold px-8 py-3 rounded-lg shadow hover:scale-105 transition"
        >
          Browse Plans
        </button>
      </div>
    </section>

    {/* HOW IT WORKS */}
    <section id="how" className="max-w-6xl mx-auto px-6 py-16">
      <h3 className="text-3xl font-bold text-center mb-12">
        How it works
      </h3>

      <div className="grid md:grid-cols-4 gap-6 text-center">
        <div className="bg-card p-6 rounded-lg shadow">
          <p className="text-primary font-bold mb-2">1</p>
          <h4 className="font-semibold mb-1">Choose a plan</h4>
          <p className="text-sm text-muted">
            Select a monthly or yearly plan.
          </p>
        </div>

        <div className="bg-card p-6 rounded-lg shadow">
          <p className="text-primary font-bold mb-2">2</p>
          <h4 className="font-semibold mb-1">Get your number</h4>
          <p className="text-sm text-muted">
            Receive a real, dedicated phone number.
          </p>
        </div>

        <div className="bg-card p-6 rounded-lg shadow">
          <p className="text-primary font-bold mb-2">3</p>
          <h4 className="font-semibold mb-1">Install eSIM</h4>
          <p className="text-sm text-muted">
            Scan the QR code and install in minutes.
          </p>
        </div>

        <div className="bg-card p-6 rounded-lg shadow">
          <p className="text-primary font-bold mb-2">4</p>
          <h4 className="font-semibold mb-1">Manage & recharge</h4>
          <p className="text-sm text-muted">
            Track usage and top up anytime.
          </p>
        </div>
      </div>
    </section>
  </div>
);
}

export default App;
