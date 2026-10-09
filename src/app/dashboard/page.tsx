import { Activity, ArrowDownRight, ArrowUpRight, CalendarDays, ClipboardList, Clock3, MapPin, Plus, Search } from "lucide-react";
import Link from "next/link";
import { Prisma, Role } from "@prisma/client";
import { requireMembership } from "@/lib/tenant";
import { db } from "@/lib/db";
import { approveWorkEntry, rejectWorkEntry } from "@/app/actions";
import { APP_TIME_ZONE, localDayBoundary, nextLocalDayBoundary } from "@/lib/dates";

type Query = {
  q?: string | string[];
  employee?: string | string[];
  from?: string | string[];
  to?: string | string[];
  workplace?: string | string[];
  workType?: string | string[];
  created?: string | string[];
  updated?: string | string[];
  deleted?: string | string[];
  error?: string | string[];
};

function single(value?: string | string[]) {
  return typeof value === "string" ? value : "";
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Query> }) {
  const membership = await requireMembership();
  const params = await searchParams;
  const manager = membership.role !== Role.EMPLOYEE;
  const query = single(params.q).trim().slice(0, 100);
  const employee = single(params.employee);
  const fromValue = single(params.from);
  const toValue = single(params.to);
  const workplace = single(params.workplace);
  const workType = single(params.workType);
  const from = localDayBoundary(fromValue);
  const to = nextLocalDayBoundary(toValue);
  const dateFilter = from || to ? { gte: from, lt: to } : undefined;
  const filters: Prisma.WorkEntryWhereInput[] = [];
  if (query) filters.push({ OR: [{ workType: { contains: query, mode: "insensitive" } }, { workplace: { contains: query, mode: "insensitive" } }] });
  if (workplace.trim()) filters.push({ workplace: { contains: workplace.trim().slice(0, 100), mode: "insensitive" } });
  if (workType.trim()) filters.push({ workType: { contains: workType.trim().slice(0, 100), mode: "insensitive" } });
  const where: Prisma.WorkEntryWhereInput = {
    companyId: membership.companyId,
    ...(!manager ? { userId: membership.userId } : {}),
    ...(manager && employee ? { userId: employee } : {}),
    ...(dateFilter ? { workedAt: dateFilter } : {}),
    ...(filters.length ? { AND: filters } : {}),
  };
  const [entries, totalHours, weekHours, members] = await Promise.all([
    db.workEntry.findMany({
      where,
      include: {
        author: { select: { name: true, email: true } },
        attachments: { select: { id: true, fileName: true } },
      },
      orderBy: { workedAt: "desc" },
      take: 100,
    }),
    db.workEntry.aggregate({
      where: { companyId: membership.companyId, ...(!manager ? { userId: membership.userId } : {}) },
      _sum: { hours: true },
      _count: true,
    }),
    db.workEntry.aggregate({
      where: {
        companyId: membership.companyId,
        ...(!manager ? { userId: membership.userId } : {}),
        workedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      _sum: { hours: true },
    }),
    manager ? db.membership.findMany({ where: { companyId: membership.companyId }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { user: { name: "asc" } } }) : Promise.resolve([]),
  ]);
  const total = Number(totalHours._sum.hours ?? 0);
  const week = Number(weekHours._sum.hours ?? 0);
  const greeting = membership.user.name?.split(" ")[0] ?? "kolega";
  return (
    <div className="content-page">
      <div className="dashboard-title-row">
        <div><span className="eyebrow">{manager ? "VEDÚCI · PREHĽAD FIRMY" : "OSOBNÝ PREHĽAD"}</span><h1>{manager ? "Dobrý deň" : "Ahoj"}, {greeting}<span className="greeting-period">.</span></h1><p>{manager ? "Tu je prehľad práce a záznamov vášho tímu." : "Majte svoje odpracované hodiny vždy pod kontrolou."}</p></div>
        {!manager && <Link href="/entries/new" className="button button-primary"><Plus size={17} /> Nový záznam</Link>}
      </div>
      {single(params.created) && <div className="notice notice-success">Záznam bol úspešne uložený.</div>}
      {single(params.updated) && <div className="notice notice-success">Záznam bol upravený.</div>}
      {single(params.deleted) && <div className="notice notice-success">Záznam bol odstránený.</div>}
      {single(params.error) === "delete" && <div className="notice notice-error">Záznam sa nepodarilo odstrániť alebo naň nemáte oprávnenie.</div>}
      {single(params.error) === "storage" && <div className="notice notice-error">Fotografie sa nepodarilo bezpečne odstrániť. Záznam zostal zachovaný.</div>}
      {single(params.error) === "review" && <div className="notice notice-error">Pri vrátení záznamu napíšte, čo treba opraviť.</div>}
      <section className="stats-grid">
        <div className="stat-card"><span className="stat-icon stat-purple"><Clock3 size={19} /></span><span className="stat-label">{manager ? "Odpracované hodiny spolu" : "Odpracované hodiny celkom"}</span><strong>{total.toLocaleString("sk-SK", { maximumFractionDigits: 2 })}<small> h</small></strong><span className="stat-foot"><Activity size={13} /> Všetky evidované záznamy</span></div>
        <div className="stat-card"><span className="stat-icon stat-green"><CalendarDays size={19} /></span><span className="stat-label">Posledných 7 dní</span><strong>{week.toLocaleString("sk-SK", { maximumFractionDigits: 2 })}<small> h</small></strong><span className="stat-foot"><ArrowUpRight size={13} /> Súčet za posledný týždeň</span></div>
        <div className="stat-card"><span className="stat-icon stat-amber"><Activity size={19} /></span><span className="stat-label">{manager ? "Záznamy vo firme" : "Moje pracovné záznamy"}</span><strong>{totalHours._count}<small> záznamov</small></strong><span className="stat-foot"><ArrowDownRight size={13} /> Evidované v systéme</span></div>
      </section>
      <section className="records-section">
        <div className="section-title-row"><div><h2>{manager ? "Záznamy tímu" : "Moje záznamy"}</h2><p>{manager ? "Záznamy sú viditeľné len členom vašej firmy." : "Vaše odpracované dni na jednom mieste."}</p></div>{manager && <span className="count-pill">{entries.length} záznamov</span>}</div>
        {manager && <form className="filter-bar" method="get">
          <label className="search-field"><Search size={17} /><input name="q" defaultValue={query} placeholder="Hľadať prácu alebo miesto…" /></label>
          <select name="employee" defaultValue={employee}><option value="">Všetci zamestnanci</option>{members.map(({ user }) => <option key={user.id} value={user.id}>{user.name ?? user.email}</option>)}</select>
          <input type="date" name="from" aria-label="Dátum od" defaultValue={fromValue} /><input type="date" name="to" aria-label="Dátum do" defaultValue={toValue} />
          <input name="workplace" aria-label="Miesto práce" defaultValue={workplace} placeholder="Miesto" />
          <input name="workType" aria-label="Druh práce" defaultValue={workType} placeholder="Druh práce" />
          <button className="button button-outline button-small">Filtrovať</button>
        </form>}
        <div className="record-list">
          {entries.length === 0 ? <div className="empty-state"><span className="empty-icon"><ClipboardList size={20} /></span><strong>Zatiaľ tu nie sú žiadne záznamy</strong><p>{manager ? "Keď tím pridá záznamy, zobrazia sa tu." : "Pridajte svoj prvý pracovný záznam a majte odpracovaný čas pod kontrolou."}</p>{!manager && <Link className="button button-primary" href="/entries/new"><Plus size={16} /> Pridať prvý záznam</Link>}</div> :
            entries.map((entry) => <article className="record-card" key={entry.id}>
              <div className="record-date"><strong>{entry.workedAt.toLocaleDateString("sk-SK", { timeZone: APP_TIME_ZONE, day: "2-digit" })}</strong><span>{entry.workedAt.toLocaleDateString("sk-SK", { timeZone: APP_TIME_ZONE, month: "short" }).replace(".", "")}</span><small>{entry.workedAt.toLocaleDateString("sk-SK", { timeZone: APP_TIME_ZONE, weekday: "short" }).replace(".", "")}</small></div>
              <div className="record-main"><div className="record-heading"><h3>{entry.workType}</h3><span className={`status-pill status-${entry.status.toLowerCase()}`}>{entry.status === "PENDING" ? "Čaká na schválenie" : entry.status === "APPROVED" ? "Schválené" : "Vrátené"}</span></div><div className="record-meta"><span><MapPin size={14} />{entry.workplace}</span><span><Clock3 size={14} />{entry.workedAt.toLocaleTimeString("sk-SK", { timeZone: APP_TIME_ZONE, hour: "2-digit", minute: "2-digit" })}</span>{manager && <span className="record-person">{entry.author.name ?? entry.author.email}</span>}</div>
                {entry.note && <p className="record-note">{entry.note}</p>}
                {entry.attachments.length > 0 && <div className="attachment-list">{entry.attachments.map((file) => <a href={`/api/attachments/${file.id}`} key={file.id} target="_blank" rel="noreferrer">Fotografia</a>)}</div>}
              </div>
              <div className="record-end"><strong>{Number(entry.hours).toLocaleString("sk-SK")}<small> h</small></strong><Link href={`/entries/${entry.id}`} className="text-link">Detail</Link>{manager && entry.status === "PENDING" && <><form action={approveWorkEntry}><input type="hidden" name="entryId" value={entry.id} /><button className="text-link approval-button">Schváliť</button></form><form action={rejectWorkEntry} className="review-form"><input type="hidden" name="entryId" value={entry.id} /><textarea name="reviewNote" rows={2} minLength={2} maxLength={1000} aria-label={`Dôvod vrátenia záznamu: ${entry.workType}`} placeholder="Čo treba opraviť?" required /><button className="text-link approval-button">Vrátiť na opravu</button></form></>}</div>
            </article>)}
        </div>
      </section>
    </div>
  );
}
