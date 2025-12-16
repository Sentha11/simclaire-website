const faqs = [
  { q: "Do I get a real phone number?", a: "Yes — a dedicated physical number." },
  { q: "Is this a roaming number?", a: "No. Your number stays the same." },
  { q: "Can I recharge?", a: "Yes — monthly or yearly." },
];

export default function FAQBlock() {
  return (
    <div className="faq">
      {faqs.map((f) => (
        <details className="faq__item lift" key={f.q}>
          <summary className="faq__q">{f.q}</summary>
          <div className="faq__a muted">{f.a}</div>
        </details>
      ))}
    </div>
  );
}