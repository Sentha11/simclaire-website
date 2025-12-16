export default function Footer() {
  return (
    <footer className="footer" id="footer">
      <div className="container footer__inner">
        <div>
          <h3 className="footer__title">Support</h3>
          <p className="muted">💬 Live chat available on website</p>
          <p className="muted">📱 WhatsApp: +1 (437) 925-9578</p>
          <p className="muted">📧 support@simclaire.com</p>
        </div>

        <div className="footer__small muted">
          © {new Date().getFullYear()} SimClaire. All rights reserved.
        </div>
      </div>
    </footer>
  );
}