export default function Section({ id, title, eyebrow, children }) {
  return (
    <section id={id} className="section">
      <div className="container">
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        {title ? <h2 className="h2">{title}</h2> : null}
        <div className="section__body">{children}</div>
      </div>
    </section>
  );
}