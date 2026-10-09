import { ArrowLeft, ClipboardList } from "lucide-react";
import { EntryForm } from "@/components/entry-form";
import { requireMembership } from "@/lib/tenant";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function NewEntryPage() {
  const membership = await requireMembership();
  if (!membership) redirect("/");
  return (
    <div className="narrow-page">
      <Link href="/dashboard" className="back-link"><ArrowLeft size={16} /> Späť na prehľad</Link>
      <div className="page-heading"><span className="heading-icon"><ClipboardList size={20} /></span><div><span className="eyebrow">EVIDENCIA PRÁCE</span><h1>Nový pracovný záznam</h1><p>Zapíšte si odpracovaný čas a podrobnosti o práci.</p></div></div>
      <div className="panel form-panel"><EntryForm /></div>
    </div>
  );
}
