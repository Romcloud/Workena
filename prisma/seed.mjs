import { PrismaClient, Role, EntryStatus } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (process.env.SEED_DEMO_DATA !== "true" || process.env.NODE_ENV === "production") {
  throw new Error("Demo seed is disabled. Set SEED_DEMO_DATA=true in a non-production environment.");
}
if (!databaseUrl) throw new Error("DATABASE_URL must point to a local development database.");

let databaseHost;
try {
  databaseHost = new URL(databaseUrl).hostname;
} catch {
  throw new Error("DATABASE_URL is not a valid PostgreSQL URL.");
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseHost)) {
  throw new Error("Demo seed only runs against localhost to protect real data.");
}

const prisma = new PrismaClient();
const companyId = "workena-demo-company";
const ownerId = "workena-demo-owner";
const employeeId = "workena-demo-employee";
const now = new Date();

try {
  await prisma.company.upsert({
    where: { id: companyId },
    update: { name: "Ukážková firma Workena", emailDomain: null, enforceEmailDomain: false },
    create: { id: companyId, name: "Ukážková firma Workena" },
  });
  await prisma.user.upsert({
    where: { id: ownerId },
    update: { name: "Demo Vlastník", email: "vlastnik@demo.invalid" },
    create: { id: ownerId, name: "Demo Vlastník", email: "vlastnik@demo.invalid" },
  });
  await prisma.user.upsert({
    where: { id: employeeId },
    update: { name: "Demo Zamestnanec", email: "zamestnanec@demo.invalid" },
    create: { id: employeeId, name: "Demo Zamestnanec", email: "zamestnanec@demo.invalid" },
  });
  await prisma.membership.upsert({
    where: { userId: ownerId },
    update: { companyId, role: Role.OWNER },
    create: { companyId, userId: ownerId, role: Role.OWNER },
  });
  await prisma.membership.upsert({
    where: { userId: employeeId },
    update: { companyId, role: Role.EMPLOYEE },
    create: { companyId, userId: employeeId, role: Role.EMPLOYEE },
  });

  const entries = [
    {
      id: "workena-demo-entry-pending",
      daysAgo: 0,
      hours: "7.50",
      workType: "Montáž elektroinštalácie",
      workplace: "Bratislava — Ružinov",
      status: EntryStatus.PENDING,
    },
    {
      id: "workena-demo-entry-approved",
      daysAgo: 1,
      hours: "6.00",
      workType: "Kontrola rozvodov",
      workplace: "Bratislava — Petržalka",
      status: EntryStatus.APPROVED,
      reviewedById: ownerId,
    },
    {
      id: "workena-demo-entry-rejected",
      daysAgo: 2,
      hours: "4.50",
      workType: "Príprava pracoviska",
      workplace: "Trnava",
      status: EntryStatus.REJECTED,
      reviewedById: ownerId,
      reviewNote: "Doplňte prosím presný rozsah vykonanej práce.",
    },
  ];

  for (const { daysAgo, ...entry } of entries) {
    const workedAt = new Date(now);
    workedAt.setDate(workedAt.getDate() - daysAgo);
    workedAt.setHours(8, 0, 0, 0);
    await prisma.workEntry.upsert({
      where: { id: entry.id },
      update: {
        ...entry,
        companyId,
        userId: employeeId,
        workedAt,
        reviewedAt: entry.reviewedById ? workedAt : null,
      },
      create: {
        ...entry,
        companyId,
        userId: employeeId,
        workedAt,
        reviewedAt: entry.reviewedById ? workedAt : null,
      },
    });
  }

  console.info("Local Workena demo data is ready.");
} finally {
  await prisma.$disconnect();
}
