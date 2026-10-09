import { ArrowRight, CheckCircle2, Clock3, ShieldCheck } from "lucide-react";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { signInWithGoogle } from "@/app/actions";
import Link from "next/link";

export default async function HomePage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <main className="landing">
      <nav className="landing-nav">
        <Link href="/" className="brand"><span className="brand-mark">w</span> workena</Link>
        <form action={signInWithGoogle}><button className="button button-outline">Prihlásiť sa</button></form>
      </nav>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><span className="eyebrow-dot" /> Poriadok v pracovnom dni</span>
          <h1>Odpracované.<br /><span>Bez zbytočného papiera.</span></h1>
          <p>Jednoduchá evidencia práce pre ľudí v teréne aj celý tím v kancelárii. Záznamy, hodiny a fotografie na jednom bezpečnom mieste.</p>
          <form action={signInWithGoogle}>
            <button className="button button-primary button-large">Pokračovať cez Google <ArrowRight size={18} /></button>
          </form>
          <div className="trust-note"><ShieldCheck size={16} /> Súkromné priestory pre každú firmu</div>
        </div>
        <div className="hero-visual" aria-label="Ukážka prehľadu odpracovaných hodín">
          <div className="visual-orb orb-one" /><div className="visual-orb orb-two" />
          <div className="preview-card">
            <div className="preview-heading"><div><span className="muted-label">TÝŽDENNÝ PREHĽAD</span><h2>Tento týždeň</h2></div><span className="avatar avatar-green">MK</span></div>
            <div className="hours-total"><strong>32,5</strong><span>hodín celkom</span><div className="progress"><i /></div></div>
            <div className="preview-days">
              {[["Po", 5], ["Ut", 7], ["St", 6], ["Št", 8], ["Pi", 6.5]].map(([day, hours]) => (
                <div className="day-column" key={day}><span className="day-bar" style={{ height: `${Number(hours) * 8}px` }} /><span>{day}</span></div>
              ))}
            </div>
            <div className="preview-entry"><span className="entry-icon"><Clock3 size={17} /></span><div><strong>Montáž rozvodov</strong><small>Bratislava · dnes, 08:00</small></div><span className="entry-hours">6,5 h</span></div>
          </div>
          <div className="floating-note"><CheckCircle2 size={16} /> Záznam uložený</div>
        </div>
      </section>
      <section className="landing-benefits">
        <div><span className="benefit-icon"><Clock3 size={19} /></span><strong>Rýchle záznamy</strong><p>Prácu zapíšete aj z mobilu priamo z pracoviska.</p></div>
        <div><span className="benefit-icon"><ShieldCheck size={19} /></span><strong>Firemné súkromie</strong><p>Každá firma má svoje oddelené a chránené údaje.</p></div>
        <div><span className="benefit-icon"><CheckCircle2 size={19} /></span><strong>Jasný prehľad</strong><p>Vedúci nájde potrebné záznamy podľa ľudí aj práce.</p></div>
      </section>
      <footer className="landing-footer">© {new Date().getFullYear()} Workena <span>Navrhnutá pre skutočnú prácu.</span></footer>
    </main>
  );
}
