// 送り箱と、所属（membership_id）・会社をつなぐ（R-001-32・33）
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openOutbox, type Outbox } from "./outbox";
import { flush, type Sender } from "./sync";
import { createMemberEnqueue } from "./membership";

let box: Outbox;
let n = 0;
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  box = await openOutbox(`member-test-${n++}`);
});

describe("送り箱と所属", () => {
  it("R-001-32 ためた記録に、今の会社と所属が付き、送れるまで件数に出る", async () => {
    const enqueue = createMemberEnqueue(box, { tenantId: "t1", membershipId: "m1" });
    const saved = await enqueue({ kind: "insert", target: "photos", payload: { note: "x" } });
    expect(saved).toMatchObject({ tenantId: "t1", membershipId: "m1" });
    expect(await box.pendingCount("t1")).toBe(1);
  });

  it("R-001-33 サーバーに断られたら、所属つきの端末のエラーが記録される", async () => {
    const enqueue = createMemberEnqueue(box, { tenantId: "t1", membershipId: "m1" });
    await enqueue({ kind: "insert", target: "photos", payload: {} });
    const sender: Sender = { send: async () => ({ ok: false, kind: "server", message: "denied", code: "42501" }) };
    await flush(box, sender, { deviceId: "d1", appVersion: "1" });
    const log = (await box.list()).find((i) => i.target === "client_error_logs")!;
    expect(log.payload).toMatchObject({ membership_id: "m1", device_id: "d1", kind: "sync_failed" });
    expect(log.tenantId).toBe("t1");
  });

  it("R-001-17 会社がまだ選べていない間は、ためない", async () => {
    const enqueue = createMemberEnqueue(box, null);
    await expect(enqueue({ kind: "insert", target: "photos", payload: {} })).rejects.toThrow("会社");
  });
});
