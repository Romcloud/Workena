import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Role } from "@prisma/client";
import { redirect } from "next/navigation";

export async function getMembership() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return db.membership.findUnique({
    where: { userId: session.user.id },
    include: {
      company: true,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  });
}

export async function requireMembership() {
  const membership = await getMembership();
  if (!membership) redirect("/company/new");
  return membership;
}

export async function requireRole(roles: Role[]) {
  const membership = await requireMembership();
  if (!roles.includes(membership.role)) redirect("/dashboard");
  return membership;
}

export function canManage(role: Role) {
  return role === Role.OWNER || role === Role.MANAGER;
}
