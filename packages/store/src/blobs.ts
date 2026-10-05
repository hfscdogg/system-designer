import { sha256Hex } from "@sd/core";

/**
 * Write-once evidence storage. A key can be written once; rewriting the same
 * bytes is an idempotent no-op, different bytes are an error (PRD §16.2).
 */
export interface BlobStore {
  putImmutable(key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; sha256: string }>;
  get(key: string): Promise<Uint8Array>;
}

export class BlobConflictError extends Error {}

export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();

  async putImmutable(key: string, bytes: Uint8Array, _contentType?: string) {
    const sha256 = sha256Hex(bytes);
    const existing = this.objects.get(key);
    if (existing && sha256Hex(existing) !== sha256) throw new BlobConflictError(`blob ${key} already exists with different content`);
    if (!existing) this.objects.set(key, new Uint8Array(bytes));
    return { key, sha256 };
  }

  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) throw new Error(`blob ${key} not found`);
    return v;
  }
}

interface GcsBucketLike {
  file(name: string): {
    save(data: Uint8Array, opts: Record<string, unknown>): Promise<unknown>;
    download(): Promise<[Uint8Array]>;
  };
}

/** GCS-backed store. Use a bucket with object versioning and a retention policy. */
export class GcsBlobStore implements BlobStore {
  private readonly bucket: GcsBucketLike;

  constructor(bucket: GcsBucketLike) {
    this.bucket = bucket;
  }

  async putImmutable(key: string, bytes: Uint8Array, contentType: string) {
    const sha256 = sha256Hex(bytes);
    try {
      await this.bucket.file(key).save(bytes, {
        contentType,
        resumable: false,
        metadata: { metadata: { sha256 } },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 412) throw err;
      const existing = await this.get(key);
      if (sha256Hex(existing) !== sha256) throw new BlobConflictError(`blob ${key} already exists with different content`);
    }
    return { key, sha256 };
  }

  async get(key: string) {
    const [data] = await this.bucket.file(key).download();
    return data;
  }
}
