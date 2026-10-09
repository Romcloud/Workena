import { S3Client } from "@aws-sdk/client-s3";

export function getStorageConfig() {
  const { S3_BUCKET, S3_REGION } = process.env;
  if (!S3_BUCKET || !S3_REGION) throw new Error("Object storage is not configured.");
  return { bucket: S3_BUCKET, region: S3_REGION };
}

export function getStorageClient() {
  const config = getStorageConfig();
  const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (Boolean(S3_ACCESS_KEY_ID) !== Boolean(S3_SECRET_ACCESS_KEY)) {
    throw new Error("Both object storage access key values must be configured together.");
  }
  return new S3Client({
    region: config.region,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    ...(S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY } }
      : {}),
  });
}

export function uploadMaxBytes() {
  const max = Number(process.env.UPLOAD_MAX_BYTES ?? 8 * 1024 * 1024);
  return Number.isFinite(max) && max > 0 ? Math.min(max, 25 * 1024 * 1024) : 8 * 1024 * 1024;
}
