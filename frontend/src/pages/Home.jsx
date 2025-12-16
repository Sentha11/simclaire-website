import Hero from "../components/Hero";
import Section from "../components/Section";
import HowItWorks from "../components/HowItWorks";
import PlansCards from "../components/PlansCards";
import FAQBlock from "../components/FAQBlock";

export default function Home() {
  return (
    <>
      <Hero />

      <Section id="how" eyebrow="Getting started" title="How it works">
        <HowItWorks />
      </Section>

      <Section id="plans" eyebrow="Pricing" title="Plans">
        <PlansCards />
      </Section>

      <Section id="faq" eyebrow="Answers" title="FAQ">
        <FAQBlock />
      </Section>

      <Section id="support" eyebrow="Help" title="Support">
        <div className="support">
          <div className="support__row">
            <span className="muted">💬 Live chat available on website</span>
          </div>
          <div className="support__row">
            <span className="muted">📱 WhatsApp: +1 (437) 925-9578</span>
          </div>
          <div className="support__row">
            <span className="muted">📧 support@simclaire.com</span>
          </div>
        </div>
      </Section>
    </>
  );
}