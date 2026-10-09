"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="center-page"><section className="center-card"><span className="eyebrow">CHYBA</span><h1>Stránku sa nepodarilo načítať.</h1><p className="muted">Skúste stránku obnoviť. Ak problém pretrváva, kontaktujte správcu aplikácie.</p><button className="button button-primary" onClick={reset}>Skúsiť znova</button></section></main>;
}
