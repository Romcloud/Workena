import { AppShell } from "@/components/app-shell";
import { requireMembership } from "@/lib/tenant";

export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const membership = await requireMembership();
  return <AppShell companyName={membership.company.name} name={membership.user.name} email={membership.user.email} role={membership.role}>{children}</AppShell>;
}
