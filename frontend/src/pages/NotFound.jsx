import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="section">
      <div className="container">
        <h2 className="h2">Page not found</h2>
        <p className="muted">That route doesn’t exist.</p>
        <Link className="btn btn--primary" to="/">Go home</Link>
      </div>
    </div>
  );
}