import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'crypto';

const DEFAULT_UPLOAD_TTL_SECONDS = Number(process.env.GCS_UPLOAD_TTL_SECONDS ?? 900);
const DEFAULT_DOWNLOAD_TTL_SECONDS = Number(process.env.GCS_DOWNLOAD_TTL_SECONDS ?? 900);

function buildClient() {
  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) {
    throw new Error('GCS_BUCKET is not configured.');
  }

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  return { storage, bucket, bucketName };
}

export class GcsClient {
  constructor(options = {}) {
    const { bucketOverride } = options;
    this.logger = options.logger ?? console;
    this.bucketInfo = bucketOverride ?? buildClient();
  }

  async ensureLifecyclePolicies() {
    const { bucket } = this.bucketInfo;
    const rules = [];
    const originalsRetention = Number(process.env.GCS_ORIGINAL_RETENTION_DAYS ?? 30);
    const restoredRetention = Number(process.env.GCS_RESTORED_RETENTION_DAYS ?? 90);

    if (Number.isFinite(originalsRetention)) {
      rules.push({ action: { type: 'Delete' }, condition: { age: originalsRetention, matchesPrefix: ['originals/'] } });
    }
    if (Number.isFinite(restoredRetention)) {
      rules.push({ action: { type: 'Delete' }, condition: { age: restoredRetention, matchesPrefix: ['restored/'] } });
    }

    if (rules.length > 0) {
      await bucket.setMetadata({ lifecycle: { rule: rules } });
    }
  }

  async generateUploadUrl({ userId, contentType }) {
    const { bucket } = this.bucketInfo;
    const objectName = `originals/${userId}/${randomUUID()}`;
    const expires = Date.now() + DEFAULT_UPLOAD_TTL_SECONDS * 1000;

    const [url] = await bucket.file(objectName).generateSignedUrl({
      version: 'v4',
      action: 'write',
      expires,
      contentType,
    });

    await bucket.file(objectName).setMetadata({
      metadata: { userId },
      contentType,
      cacheControl: 'private, max-age=0, no-store',
    });

    return {
      url,
      objectName,
      expiresAt: new Date(expires).toISOString(),
    };
  }

  async generateDownloadUrl({ userId, objectName, filename }) {
    const { bucket } = this.bucketInfo;
    const file = bucket.file(objectName);

    await file.setMetadata({ metadata: { userId } });

    const expires = Date.now() + DEFAULT_DOWNLOAD_TTL_SECONDS * 1000;
    const [url] = await file.generateSignedUrl({
      version: 'v4',
      action: 'read',
      expires,
      responseDisposition: `attachment; filename="${filename ?? 'restored.jpg'}"`,
      responseType: 'application/octet-stream',
    });

    return {
      url,
      expiresAt: new Date(expires).toISOString(),
    };
  }
}

export function createGcsClient(options) {
  try {
    return new GcsClient(options);
  } catch (error) {
    console.warn('[gcs] Falling back to mock client:', error.message);
    return {
      async ensureLifecyclePolicies() {},
      async generateUploadUrl() {
        throw new Error('GCS is not configured.');
      },
      async generateDownloadUrl() {
        throw new Error('GCS is not configured.');
      },
    };
  }
}
