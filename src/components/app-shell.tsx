import { ClipboardList, LayoutDashboard, LogOut, Users } from "lucide-react";
import Link from "next/link";
import { Role } from "@prisma/client";
import { signOutUser } from "@/app/actions";

export function AppShell({
  children,
  companyName,
  name,
  email,
  role,
}: {
  children: React.ReactNode;
  companyName: string;
  name: string | null;
  email: string;
  role: Role;
}) {
  const manager = role !== Role.EMPLOYEE;
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Link href="/dashboard" className="brand"><span className="brand-mark">w</span> workena</Link>
        <div className="workspace-switch"><span className="workspace-monogram">{companyName.slice(0, 1).toUpperCase()}</span><span><strong>{companyName}</strong><small>Firemný priestor</small></span><span className="switch-chevron">⌄</span></div>
        <span className="nav-caption">PRACOVNÝ PRIESTOR</span>
        <nav className="side-nav">
          <Link href="/dashboard" className="nav-link active"><LayoutDashboard size={18} /> Prehľad</Link>
          <Link href="/entries/new" className="nav-link"><ClipboardList size={18} /> Nový záznam</Link>
          {manager && <Link href="/team" className="nav-link"><Users size={18} /> Tím</Link>}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-row"><span className="avatar">{name?.slice(0, 1).toUpperCase() ?? email.slice(0, 1).toUpperCase()}</span><span className="profile-name"><strong>{name ?? email.split("@")[0]}</strong><small>{role === "OWNER" ? "Vlastník" : role === "MANAGER" ? "Vedúci" : "Zamestnanec"}</small></span></div>
          <form action={signOutUser}><button className="logout-button" aria-label="Odhlásiť sa"><LogOut size={17} /></button></form>
        </div>
      </aside>
      <div className="main-area">
        <header className="mobile-top"><Link href="/dashboard" className="brand"><span className="brand-mark">w</span> workena</Link><span className="mobile-company">{companyName}</span><form action={signOutUser}><button className="logout-button" aria-label="Odhlásiť sa"><LogOut size={17} /></button></form></header>
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
