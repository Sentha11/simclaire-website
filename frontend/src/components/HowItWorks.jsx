export default function HowItWorks() {
  const items = [
    { n: "01", t: "Choose a plan", d: "Monthly or yearly billing" },
    { n: "02", t: "Get your number", d: "Real dedicated phone number" },
    { n: "03", t: "Install eSIM", d: "Scan QR & activate in minutes" },
    { n: "04", t: "Manage anytime", d: "Top up or renew instantly" },
  ];

  return (
    <div className="grid grid--4">
      {items.map((x) => (
        <div className="card lift" key={x.n}>
          <div className="card__num">{x.n}</div>
          <div className="card__title">{x.t}</div>
          <div className="card__desc muted">{x.d}</div>
        </div>
      ))}
    </div>
  );
}