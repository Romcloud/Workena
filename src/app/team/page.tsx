import { UserPlus, Users } from "lucide-react";
import { requireRole } from "@/lib/tenant";
import { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { TeamInviteForm } from "@/components/team-invite-form";
import { CompanySettingsForm } from "@/components/company-settings-form";

export default async function TeamPage() {
  const membership = await requireRole([Role.OWNER, Role.MANAGER]);
  const [members, invitations] = await Promise.all([
    db.membership.findMany({
      where: { companyId: membership.companyId },
      include: { user: { select: { name: true, email: true, image: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.invitation.findMany({
      where: { companyId: membership.companyId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return (
    <div className="content-page">
      <div className="page-heading"><span className="heading-icon"><Users size={20} /></span><div><span className="eyebrow">FIREMNÝ PRIESTOR</span><h1>Tím</h1><p>Spravujte členov a pozývajte spolupracovníkov.</p></div></div>
      <div className="team-layout">
        <section className="panel team-panel"><div className="panel-heading"><div><h2>Členovia tímu</h2><p>{members.length} {members.length === 1 ? "člen" : members.length < 5 ? "členovia" : "členov"}</p></div><span className="soft-icon"><Users size={19} /></span></div>
          <div className="member-list">{members.map((member) => <div className="member-row" key={member.id}><span className="avatar">{member.user.name?.slice(0, 1).toUpperCase() ?? member.user.email.slice(0, 1).toUpperCase()}</span><span className="member-name"><strong>{member.user.name ?? member.user.email.split("@")[0]}</strong><small>{member.user.email}</small></span><span className={`role-pill role-${member.role.toLowerCase()}`}>{member.role === "OWNER" ? "Vlastník" : member.role === "MANAGER" ? "Vedúci" : "Zamestnanec"}</span></div>)}</div>
        </section>
        <section className="panel invite-panel"><div className="panel-heading"><div><h2><UserPlus size={18} /> Pozvať do tímu</h2><p>Nový člen dostane prístup po prihlásení Google účtom.</p></div></div>
          {membership.company.enforceEmailDomain && <div className="domain-notice">Povolená doména: <strong>@{membership.company.emailDomain}</strong></div>}
          <TeamInviteForm canInviteManager={membership.role === Role.OWNER} />
          {invitations.length > 0 && <div className="pending-invites"><strong>Čakajúce pozvánky</strong>{invitations.map((invite) => <div key={invite.id}><span>{invite.email}</span><small>do {invite.expiresAt.toLocaleDateString("sk-SK")}</small></div>)}</div>}
        </section>
      </div>
      {membership.role === Role.OWNER && <section className="panel company-settings"><div className="panel-heading"><div><h2>Nastavenia firmy</h2><p>Spravujte názov priestoru a pravidlá firemných e-mailov.</p></div></div><CompanySettingsForm name={membership.company.name} emailDomain={membership.company.emailDomain} enforceEmailDomain={membership.company.enforceEmailDomain} /></section>}
    </div>
  );
}
