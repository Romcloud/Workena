import { PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getStorageClient, getStorageConfig, uploadMaxBytes } from "@/lib/storage";
import { getMembership } from "@/lib/tenant";

const allowedTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

function hasValidSignature(type: string, bytes: Uint8Array) {
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
  return type === "image/webp" && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
}

export async function POST(request: Request, { params }: { params: Promise<{ entryId: string }> }) {
  const session = await auth();
  const origin = request.headers.get("origin");
  const expectedOrigin = process.env.AUTH_URL ? new URL(process.env.AUTH_URL).origin : new URL(request.url).origin;
  if (!session?.user?.id || origin !== expectedOrigin) return NextResponse.json({ error: "Požiadavku sa nepodarilo autorizovať." }, { status: 403 });

  const { entryId } = await params;
  const membership = await getMembership();
  if (!membership) return NextResponse.json({ error: "Nemáte prístup." }, { status: 403 });
  const entry = await db.workEntry.findFirst({
    where: {
      id: entryId,
      companyId: membership.companyId,
      ...(membership.role === "EMPLOYEE" ? { userId: session.user.id } : {}),
    },
    select: { id: true },
  });
  if (!entry) return NextResponse.json({ error: "Záznam sa nenašiel." }, { status: 404 });
  const attachmentCount = await db.attachment.count({ where: { entryId: entry.id, companyId: membership.companyId } });
  if (attachmentCount >= 10) return NextResponse.json({ error: "K záznamu možno pridať najviac 10 fotografií." }, { status: 400 });

  const maxBytes = uploadMaxBytes();
  const contentLength = Number(request.headers.get("content-length"));
  if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > maxBytes + 100_000) {
    return NextResponse.json({ error: "Súbor prekračuje povolenú veľkosť." }, { status: 413 });
  }

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "Súbor sa nepodarilo načítať." }, { status: 400 });
  }
  if (!(file instanceof File) || !allowedTypes.has(file.type) || file.size > maxBytes || file.size === 0) {
    const maxMegabytes = Math.floor(maxBytes / 1024 / 1024);
    return NextResponse.json({ error: `Povolené sú JPG, PNG alebo WebP fotografie do ${maxMegabytes} MB.` }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasValidSignature(file.type, bytes)) return NextResponse.json({ error: "Obsah súboru nezodpovedá typu obrázka." }, { status: 400 });

  try {
    const config = getStorageConfig();
    const extension = allowedTypes.get(file.type)!;
    const objectKey = `${membership.companyId}/${entry.id}/${randomUUID()}.${extension}`;
    await getStorageClient().send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: bytes,
      ContentType: file.type,
      ContentLength: bytes.byteLength,
      ServerSideEncryption: "AES256",
    }));
    await db.attachment.create({
      data: {
        companyId: membership.companyId,
        entryId: entry.id,
        objectKey,
        fileName: file.name.replace(/[^\w.-]/g, "_").slice(0, 150) || `fotografia.${extension}`,
        mimeType: file.type,
        sizeBytes: bytes.byteLength,
      },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Fotografiu sa nepodarilo uložiť. Skontrolujte nastavenie úložiska." }, { status: 503 });
  }
}
