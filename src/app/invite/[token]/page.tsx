import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import { Brand } from "@/components/brand";
import { AcceptInviteForm } from "./accept-form";
import { signInForInvitation } from "@/app/actions";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) notFound();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const invitation = await db.invitation.findUnique({ where: { tokenHash }, include: { company: true } });
  if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) notFound();
  const session = await auth();
  if (!session?.user) return <main className="center-page"><div className="center-card"><Brand /><span className="eyebrow">POZVÁNKA DO TÍMU</span><h1>Pridajte sa k<br />{invitation.company.name}.</h1><p className="muted">Prihláste sa Google účtom s adresou <strong>{invitation.email}</strong>. Po prihlásení sa vrátite k pozvánke.</p><form action={signInForInvitation.bind(null, token)}><button className="button button-primary button-full">Pokračovať cez Google</button></form></div></main>;
  return <main className="center-page"><div className="center-card"><Brand /><span className="eyebrow">POZVÁNKA DO TÍMU</span><h1>Pridajte sa k<br />{invitation.company.name}.</h1><p className="muted">Pozvánka je určená pre adresu <strong>{invitation.email}</strong>. Prihlásení ste ako <strong>{session.user.email}</strong>.</p><AcceptInviteForm token={token} emailMatches={session.user.email?.toLowerCase() === invitation.email} /></div></main>;
}
