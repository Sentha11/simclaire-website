import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";

function getInitialTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  // Default to dark
  return "dark";
}

export default function Header() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  return (
    <header className="header">
      <div className="container header__inner">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true" />
          <span className="brand__name">SimClaire</span>
        </div>

        <nav className="nav">
          <NavLink to="/" end className="nav__link">
            Home
          </NavLink>
          <NavLink to="/plans" className="nav__link">
            Plans
          </NavLink>
          <NavLink to="/faq" className="nav__link">
            FAQ
          </NavLink>
          <NavLink to="/support" className="nav__link">
            Support
          </NavLink>

          <button
            className="btn btn--ghost nav__toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            aria-label="Toggle light mode"
            type="button"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </nav>
      </div>
    </header>
  );
}