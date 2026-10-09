import { notFound } from "next/navigation";
import { EntryForm } from "@/components/entry-form";
import { requireMembership } from "@/lib/tenant";
import { db } from "@/lib/db";
import Link from "next/link";

export default async function EditEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const membership = await requireMembership();
  const entry = await db.workEntry.findFirst({
    where: { id, companyId: membership.companyId, userId: membership.userId, status: { in: ["PENDING", "REJECTED"] } },
  });
  if (!entry) notFound();
  return (
    <div className="narrow-page">
      <Link href="/dashboard" className="back-link">← Späť na prehľad</Link>
      <div className="page-heading"><span className="eyebrow">EVIDENCIA PRÁCE</span><h1>{entry.status === "REJECTED" ? "Opraviť záznam" : "Upraviť záznam"}</h1><p>{entry.status === "REJECTED" ? "Po uložení sa opravený záznam znova odošle na schválenie." : "Upravovať môžete vlastné záznamy čakajúce na schválenie."}</p></div>
      <div className="panel form-panel"><EntryForm entry={{ ...entry, hours: Number(entry.hours) }} /></div>
    </div>
  );
}
