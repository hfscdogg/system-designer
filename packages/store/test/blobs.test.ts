import { describe, expect, it } from "vitest";
import { BlobConflictError, GcsBlobStore, MemoryBlobStore } from "../src/index.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("write-once blobs", () => {
  it("memory store: same bytes is a no-op, different bytes is an error", async () => {
    const s = new MemoryBlobStore();
    await s.putImmutable("k", bytes("a"), "text/plain");
    await expect(s.putImmutable("k", bytes("a"), "text/plain")).resolves.toMatchObject({ key: "k" });
    await expect(s.putImmutable("k", bytes("b"), "text/plain")).rejects.toBeInstanceOf(BlobConflictError);
  });

  it("GCS store: creates with ifGenerationMatch=0 and checks content on 412", async () => {
    const objects = new Map<string, Uint8Array>();
    const saves: Array<Record<string, unknown>> = [];
    const bucket = {
      file: (name: string) => ({
        async save(data: Uint8Array, opts: Record<string, unknown>) {
          saves.push(opts);
          if (objects.has(name)) throw Object.assign(new Error("precondition failed"), { code: 412 });
          objects.set(name, data);
        },
        async download(): Promise<[Uint8Array]> {
          return [objects.get(name)!];
        },
      }),
    };
    const s = new GcsBlobStore(bucket);
    await s.putImmutable("k", bytes("a"), "text/plain");
    await s.putImmutable("k", bytes("a"), "text/plain");
    await expect(s.putImmutable("k", bytes("b"), "text/plain")).rejects.toBeInstanceOf(BlobConflictError);
    expect(saves[0]).toMatchObject({ preconditionOpts: { ifGenerationMatch: 0 } });
  });
});
