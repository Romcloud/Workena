import { GetObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getStorageClient, getStorageConfig } from "@/lib/storage";
import { getMembership } from "@/lib/tenant";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const membership = await getMembership();
  if (!session?.user?.id || !membership) return NextResponse.json({ error: "Nemáte prístup." }, { status: 403 });
  const { id } = await params;
  const attachment = await db.attachment.findFirst({
    where: {
      id,
      companyId: membership.companyId,
      entry: {
        companyId: membership.companyId,
        ...(membership.role === "EMPLOYEE" ? { userId: session.user.id } : {}),
      },
    },
  });
  if (!attachment) return NextResponse.json({ error: "Súbor sa nenašiel." }, { status: 404 });
  try {
    const { bucket } = getStorageConfig();
    const result = await getStorageClient().send(new GetObjectCommand({ Bucket: bucket, Key: attachment.objectKey }));
    if (!result.Body) return NextResponse.json({ error: "Súbor sa nenašiel." }, { status: 404 });
    return new Response(Buffer.from(await result.Body.transformToByteArray()), {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Length": String(attachment.sizeBytes),
        "Content-Disposition": `inline; filename="${attachment.fileName.replace(/["\\]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Súbor sa momentálne nepodarilo načítať." }, { status: 503 });
  }
}
