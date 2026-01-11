import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Plans from "./pages/Plans";

export default function App() {
  return (
    <>
      {/* HEADER */}
      <header className="header">
        <h1>SimClaire</h1>
        <nav className="nav">
          <a href="#how" className="nav_link">How It Works</a>
          <a href="#faq" className="nav_link">FAQ</a>
          <a href="#support" className="nav_link">Support</a>
          <a href="/plans" className="btn btn--primary">Browse Plans</a>
        </nav>
      </header>

      {/* HERO */}
      <section className="hero">
        <h2>Your own dedicated travel number</h2>
        <p>Recharge monthly or yearly. Not a roaming number.</p>

        <div className="hero_buttons">
          <button className="btn">Browse Plans</button>
          <button className="btn btn_primary">
            Buy Holiday eSIM – £9.99
          </button>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="how">
        <h3>How It Works</h3>

        <ol className="steps">
          <li>
            <strong>Choose a plan</strong>
            <p>Select a monthly or yearly plan.</p>
          </li>

          <li>
            <strong>Get your number</strong>
            <p>You receive a real, dedicated phone number.</p>
          </li>

          <li>
            <strong>Install eSIM</strong>
            <p>Scan the QR code and install in minutes.</p>
          </li>

          <li>
            <strong>Manage & recharge</strong>
            <p>Use your account to top up or renew.</p>
          </li>
        </ol>
      </section>
    </>
  );

}


