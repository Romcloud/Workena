import { ArrowLeft, Camera, Clock3, MapPin, Pencil, Trash2 } from "lucide-react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireMembership } from "@/lib/tenant";
import { Role } from "@prisma/client";
import { deleteWorkEntry } from "@/app/actions";
import { PhotoUploader } from "@/components/photo-uploader";
import { APP_TIME_ZONE } from "@/lib/dates";
import Link from "next/link";
import Image from "next/image";

export default async function EntryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const membership = await requireMembership();
  const manager = membership.role !== Role.EMPLOYEE;
  const entry = await db.workEntry.findFirst({
    where: { id, companyId: membership.companyId, ...(!manager ? { userId: membership.userId } : {}) },
    include: {
      author: { select: { name: true, email: true } },
      reviewer: { select: { name: true, email: true } },
      attachments: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!entry) notFound();
  const editable = entry.userId === membership.userId && ["PENDING", "REJECTED"].includes(entry.status);
  return (
    <div className="narrow-page">
      <Link href="/dashboard" className="back-link"><ArrowLeft size={16} /> Späť na prehľad</Link>
      <div className="page-heading"><span className="eyebrow">PRACOVNÝ ZÁZNAM</span><h1>{entry.workType}</h1><p>{entry.author.name ?? entry.author.email} · {entry.workedAt.toLocaleDateString("sk-SK", { timeZone: APP_TIME_ZONE, dateStyle: "long" })}</p></div>
      <section className="panel detail-panel"><div className="detail-stats"><div><span>Odpracované</span><strong>{Number(entry.hours).toLocaleString("sk-SK")} h</strong></div><div><span>Miesto práce</span><strong><MapPin size={16} /> {entry.workplace}</strong></div><div><span>Čas</span><strong><Clock3 size={16} /> {entry.workedAt.toLocaleTimeString("sk-SK", { timeZone: APP_TIME_ZONE, hour: "2-digit", minute: "2-digit" })}</strong></div></div>
        <div className="detail-note"><span className={`status-pill status-${entry.status.toLowerCase()}`}>{entry.status === "PENDING" ? "Čaká na schválenie" : entry.status === "APPROVED" ? "Schválené" : "Vrátené na opravu"}</span>{entry.reviewedAt && <p>Skontroloval {entry.reviewer?.name ?? entry.reviewer?.email ?? "vedúci tímu"} · {entry.reviewedAt.toLocaleDateString("sk-SK", { timeZone: APP_TIME_ZONE, dateStyle: "medium" })}</p>}{entry.reviewNote && <p><strong>Poznámka vedúceho:</strong> {entry.reviewNote}</p>}{entry.status === "REJECTED" && editable && <p>Upravte záznam a odošlite ho znova na schválenie.</p>}</div>
        {entry.note && <div className="detail-note"><span className="eyebrow">POZNÁMKA</span><p>{entry.note}</p></div>}
        <div className="photo-section"><div className="section-title-row"><div><h2><Camera size={18} /> Fotografie</h2><p>Fotografie sú prístupné iba členom tejto firmy.</p></div></div>
          {entry.attachments.length ? <div className="photo-grid">{entry.attachments.map((file) => <a href={`/api/attachments/${file.id}`} key={file.id} target="_blank" rel="noreferrer"><Image src={`/api/attachments/${file.id}`} width={320} height={180} unoptimized alt={file.fileName} /><span>{file.fileName}</span></a>)}</div> : <p className="muted">K záznamu zatiaľ nie sú pridané fotografie.</p>}
          {editable && <PhotoUploader entryId={entry.id} />}
        </div>
        {editable && <div className="detail-actions"><Link href={`/entries/${entry.id}/edit`} className="button button-outline"><Pencil size={15} /> {entry.status === "REJECTED" ? "Opraviť a odoslať znova" : "Upraviť"}</Link>{entry.status === "PENDING" && <form action={deleteWorkEntry}><input type="hidden" name="entryId" value={entry.id} /><button className="button button-danger"><Trash2 size={15} /> Odstrániť</button></form>}</div>}
      </section>
    </div>
  );
}
