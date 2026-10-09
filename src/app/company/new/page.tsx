import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { CompanyForm } from "@/components/company-form";
import { Brand } from "@/components/brand";

export default async function NewCompanyPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (await db.membership.findUnique({ where: { userId: session.user.id }, select: { id: true } })) redirect("/dashboard");
  return (
    <main className="center-page">
      <div className="center-card">
        <Brand />
        <span className="eyebrow">ZAČNIME ODZAČIATKU</span>
        <h1>Vytvorte priestor<br />pre svoju firmu.</h1>
        <p className="muted">Založením firemného priestoru sa stanete jeho vlastníkom. Členov môžete pozvať hneď potom.</p>
        <CompanyForm />
      </div>
    </main>
  );
}
