import { useNavigate } from "react-router-dom";

export default function Hero() {
  const navigate = useNavigate();

  return (
    <section className="hero">
      <div className="container hero__inner">
        <div className="hero__copy animate-in">
          <div className="pill">Dedicated travel number + eSIM</div>
          <h1 className="h1">Your own dedicated travel number</h1>
          <p className="lead">
            Recharge monthly or yearly. Not a roaming number. Keep one real phone number wherever
            you travel.
          </p>

          <div className="hero__cta">
            <button className="btn btn--primary" onClick={() => navigate("/plans")} type="button">
              Browse plans
            </button>
            <button className="btn btn--ghost" onClick={() => navigate("/faq")} type="button">
              Read FAQ
            </button>
          </div>
        </div>

        <div className="hero__panel animate-in-delay">
          <div className="panel">
            <div className="panel__row">
              <span className="dot" />
              <span className="panel__label">Activate in minutes</span>
            </div>
            <div className="panel__row">
              <span className="dot" />
              <span className="panel__label">One number everywhere</span>
            </div>
            <div className="panel__row">
              <span className="dot" />
              <span className="panel__label">Top up anytime</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}