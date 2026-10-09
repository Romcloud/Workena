"use server";

import { auth, signIn, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getStorageClient, getStorageConfig } from "@/lib/storage";
import { companySchema, entrySchema, formString, normalizedEmail } from "@/lib/validation";
import { requireMembership, requireRole } from "@/lib/tenant";
import { Role } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export type ActionState = { error?: string; inviteUrl?: string; success?: string };

export async function signInWithGoogle() {
  await signIn("google", { redirectTo: "/dashboard" });
}

export async function signInForInvitation(token: string) {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) redirect("/");
  await signIn("google", { redirectTo: `/invite/${token}` });
}

export async function signOutUser() {
  await signOut({ redirectTo: "/" });
}

export async function createCompany(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return { error: "Najprv sa prihláste." };
  if (await db.membership.findUnique({ where: { userId: session.user.id }, select: { id: true } })) {
    return { error: "K firme už máte priradený účet." };
  }

  const parsed = companySchema.safeParse({
    name: formString(formData, "name"),
    emailDomain: formString(formData, "emailDomain"),
    enforceEmailDomain: formData.get("enforceEmailDomain") === "on",
  });
  if (!parsed.success) return { error: "Skontrolujte názov firmy a zadanú doménu." };
  if (parsed.data.enforceEmailDomain && !parsed.data.emailDomain) {
    return { error: "Na obmedzenie prístupu najprv zadajte firemnú doménu." };
  }
  const emailDomain = parsed.data.emailDomain;
  if (parsed.data.enforceEmailDomain && emailDomain !== session.user.email.split("@")[1]?.toLowerCase()) {
    return { error: "Doména musí zodpovedať e-mailu vlastníka." };
  }

  await db.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
        name: parsed.data.name,
        emailDomain,
        enforceEmailDomain: parsed.data.enforceEmailDomain,
      },
    });
    await tx.membership.create({
      data: { companyId: company.id, userId: session.user.id, role: Role.OWNER },
    });
  });
  redirect("/dashboard");
}

export async function updateCompanySettings(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const membership = await requireRole([Role.OWNER]);
  const parsed = companySchema.safeParse({
    name: formString(formData, "name"),
    emailDomain: formString(formData, "emailDomain"),
    enforceEmailDomain: formData.get("enforceEmailDomain") === "on",
  });
  if (!parsed.success) return { error: "Skontrolujte názov firmy a zadanú doménu." };
  if (parsed.data.enforceEmailDomain && !parsed.data.emailDomain) {
    return { error: "Na obmedzenie prístupu najprv zadajte firemnú doménu." };
  }
  if (
    parsed.data.enforceEmailDomain &&
    parsed.data.emailDomain !== membership.user.email.split("@")[1]?.toLowerCase()
  ) {
    return { error: "Doména musí zodpovedať e-mailu vlastníka." };
  }
  await db.company.update({
    where: { id: membership.companyId },
    data: {
      name: parsed.data.name,
      emailDomain: parsed.data.emailDomain,
      enforceEmailDomain: parsed.data.enforceEmailDomain,
    },
  });
  revalidatePath("/team");
  revalidatePath("/dashboard");
  return { success: "Nastavenia firmy boli uložené." };
}

export async function createWorkEntry(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const membership = await requireMembership();
  const parsed = entrySchema.safeParse({
    workedAt: formString(formData, "workedAt"),
    hours: formString(formData, "hours"),
    workType: formString(formData, "workType"),
    workplace: formString(formData, "workplace"),
    note: formString(formData, "note"),
  });
  if (!parsed.success) return { error: "Skontrolujte vyplnené údaje. Hodiny musia byť medzi 0 a 24." };
  await db.workEntry.create({
    data: {
      companyId: membership.companyId,
      userId: membership.userId,
      workedAt: parsed.data.workedAt,
      hours: parsed.data.hours,
      workType: parsed.data.workType,
      workplace: parsed.data.workplace,
      note: parsed.data.note || null,
    },
  });
  revalidatePath("/dashboard");
  redirect("/dashboard?created=1");
}

export async function updateWorkEntry(
  entryId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const membership = await requireMembership();
  const entry = await db.workEntry.findFirst({
    where: { id: entryId, companyId: membership.companyId },
    select: { id: true, userId: true, status: true },
  });
  if (!entry || entry.userId !== membership.userId || !["PENDING", "REJECTED"].includes(entry.status)) {
    return { error: "Záznam sa nedá upraviť alebo naň nemáte oprávnenie." };
  }
  const parsed = entrySchema.safeParse({
    workedAt: formString(formData, "workedAt"),
    hours: formString(formData, "hours"),
    workType: formString(formData, "workType"),
    workplace: formString(formData, "workplace"),
    note: formString(formData, "note"),
  });
  if (!parsed.success) return { error: "Skontrolujte vyplnené údaje. Hodiny musia byť medzi 0 a 24." };
  const updated = await db.workEntry.updateMany({
    where: {
      id: entry.id,
      companyId: membership.companyId,
      userId: membership.userId,
      status: { in: ["PENDING", "REJECTED"] },
    },
    data: {
      workedAt: parsed.data.workedAt,
      hours: parsed.data.hours,
      workType: parsed.data.workType,
      workplace: parsed.data.workplace,
      note: parsed.data.note || null,
      status: "PENDING",
      reviewedAt: null,
      reviewedById: null,
      reviewNote: null,
    },
  });
  if (updated.count !== 1) return { error: "Záznam sa medzitým zmenil. Obnovte stránku a skúste to znova." };
  revalidatePath("/dashboard");
  revalidatePath(`/entries/${entry.id}`);
  redirect("/dashboard?updated=1");
}

export async function deleteWorkEntry(formData: FormData) {
  const membership = await requireMembership();
  const entryId = formString(formData, "entryId");
  if (!entryId) redirect("/dashboard?error=delete");
  const entry = await db.workEntry.findFirst({
    where: { id: entryId, companyId: membership.companyId, userId: membership.userId, status: "PENDING" },
    include: { attachments: { select: { objectKey: true } } },
  });
  if (!entry) redirect("/dashboard?error=delete");
  if (entry.attachments.length) {
    try {
      const { bucket } = getStorageConfig();
      const client = getStorageClient();
      await Promise.all(entry.attachments.map(({ objectKey }) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))));
    } catch {
      redirect("/dashboard?error=storage");
    }
  }
  const result = await db.workEntry.deleteMany({
    where: { id: entry.id, companyId: membership.companyId, userId: membership.userId, status: "PENDING" },
  });
  if (result.count !== 1) redirect("/dashboard?error=delete");
  revalidatePath("/dashboard");
  redirect("/dashboard?deleted=1");
}

export async function createInvitation(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const membership = await requireRole([Role.OWNER, Role.MANAGER]);
  const email = normalizedEmail(formString(formData, "email"));
  const roleInput = formString(formData, "role");
  const role = roleInput === "MANAGER" ? Role.MANAGER : Role.EMPLOYEE;
  if (!zEmail(email)) return { error: "Zadajte platnú e-mailovú adresu." };
  if (role === Role.MANAGER && membership.role !== Role.OWNER) {
    return { error: "Vedúceho môže pozvať iba vlastník firmy." };
  }
  if (membership.company.enforceEmailDomain && email.split("@")[1] !== membership.company.emailDomain) {
    return { error: "E-mailová adresa nepatrí do povolenej firemnej domény." };
  }
  if (await db.membership.findFirst({ where: { companyId: membership.companyId, user: { email } } })) {
    return { error: "Tento používateľ je už členom firmy." };
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.invitation.create({
    data: {
      companyId: membership.companyId,
      email,
      role,
      tokenHash,
      createdById: membership.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  revalidatePath("/team");
  return { error: undefined, inviteUrl: `${process.env.AUTH_URL ?? "http://localhost:3000"}/invite/${token}` } as ActionState;
}

export async function acceptInvitation(token: string): Promise<ActionState> {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return { error: "Prihláste sa e-mailovou adresou, na ktorú bola pozvánka odoslaná." };
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return { error: "Pozvánka je neplatná alebo expirovaná." };
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const invitation = await db.invitation.findUnique({ where: { tokenHash }, include: { company: true } });
  if (
    !invitation ||
    invitation.acceptedAt ||
    invitation.expiresAt <= new Date() ||
    invitation.email !== normalizedEmail(session.user.email)
  ) {
    return { error: "Pozvánka je neplatná, expirovaná alebo patrí inej e-mailovej adrese." };
  }
  if (
    invitation.company.enforceEmailDomain &&
    normalizedEmail(session.user.email).split("@")[1] !== invitation.company.emailDomain
  ) {
    return { error: "Vaša e-mailová doména nemá povolený prístup do tejto firmy." };
  }
  try {
    const accepted = await db.$transaction(async (tx) => {
      const existingMembership = await tx.membership.findUnique({ where: { userId: session.user.id } });
      if (existingMembership) return "already-member";
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1) return "unavailable";
      await tx.membership.create({
        data: { companyId: invitation.companyId, userId: session.user.id, role: invitation.role },
      });
      return "accepted";
    });
    if (accepted === "already-member") return { error: "Tento účet už patrí do firmy." };
    if (accepted !== "accepted") return { error: "Pozvánka už bola použitá alebo expirovala." };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "P2002") {
      return { error: "Tento účet už patrí do inej firmy." };
    }
    throw error;
  }
  redirect("/dashboard");
}

function zEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function approveWorkEntry(formData: FormData) {
  const membership = await requireRole([Role.OWNER, Role.MANAGER]);
  const entryId = formString(formData, "entryId");
  if (!entryId) return;
  await db.workEntry.updateMany({
    where: { id: entryId, companyId: membership.companyId, status: "PENDING" },
    data: { status: "APPROVED", reviewedById: membership.userId, reviewedAt: new Date(), reviewNote: null },
  });
  revalidatePath("/dashboard");
  revalidatePath(`/entries/${entryId}`);
}

export async function rejectWorkEntry(formData: FormData) {
  const membership = await requireRole([Role.OWNER, Role.MANAGER]);
  const entryId = formString(formData, "entryId");
  if (!entryId) return;
  const reviewNote = formString(formData, "reviewNote").trim();
  if (reviewNote.length < 2 || reviewNote.length > 1000) redirect("/dashboard?error=review");
  await db.workEntry.updateMany({
    where: { id: entryId, companyId: membership.companyId, status: "PENDING" },
    data: {
      status: "REJECTED",
      reviewedById: membership.userId,
      reviewedAt: new Date(),
      reviewNote,
    },
  });
  revalidatePath("/dashboard");
  revalidatePath(`/entries/${entryId}`);
}
