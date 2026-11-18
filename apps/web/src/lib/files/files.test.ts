// 機能 005 の画面の部品：入力の検査・表記・上げる順・専用ページの入口と区画（R-005-13・25・26・28・30・31・35・36）
import { describe, expect, it } from "vitest";
import { fakeClient } from "../../../tests/fakeClient";
import { buildStoragePath, canEditFiles, formatKind, formatSize, safeObjectName, sortFiles, validateFileName } from "./format";
import { PORTAL_BUILDING_COLUMNS, homeFor, portalSections, registerPortalSection, sharedFilesSection, type PortalSection } from "./portal";
import { listFiles, signUrls } from "./repo";
import { uploadFileFlow, type UploadDeps } from "./upload";
import type { FileRowData } from "./types";

const T = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("R-005-31 名前の検査（DB の check と同じ決まり）", () => {
  it("R-005-31 空・空白だけはエラー、255 字までは通る、256 字はエラー", () => {
    expect(validateFileName("")).toBeTruthy();
    expect(validateFileName("   ")).toBeTruthy();
    expect(validateFileName("契約書.pdf")).toBeNull();
    expect(validateFileName("あ".repeat(255))).toBeNull();
    expect(validateFileName("あ".repeat(256))).toBeTruthy();
  });
});

describe("R-005-36 大きさと種類の表記", () => {
  it("R-005-36 大きさを短く出す", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(900)).toBe("900 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1572864)).toBe("1.5 MB");
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
  it("R-005-36 種類を日本語の短い名前で出す（分からなければ拡張子）", () => {
    expect(formatKind("application/pdf", "a.pdf")).toBe("PDF");
    expect(formatKind("image/jpeg", "a.jpg")).toBe("画像");
    expect(formatKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx")).toBe("Excel");
    expect(formatKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBe("Word");
    expect(formatKind("text/csv", "a.csv")).toBe("CSV");
    expect(formatKind("application/octet-stream", "図面.dwg")).toBe("DWG");
    expect(formatKind("", "noext")).toBe("ファイル");
  });
});

describe("R-005-30 一覧の並び", () => {
  const f = (id: string, created_at: string): FileRowData => ({
    id, tenant_id: T, building_id: B, request_id: null, quote_id: null, name: id, mime: "application/pdf", size: 1, storage_path: `${T}/files/${id}/x.pdf`,
    shared_external: false, created_at, deleted_at: null,
  });
  it("R-005-30 新しい順に並べる（元の配列は変えない）", () => {
    const rows = [f("a", "2026-11-01T00:00:00Z"), f("c", "2026-11-03T00:00:00Z"), f("b", "2026-11-02T00:00:00Z")];
    expect(sortFiles(rows).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
  it("R-005-30 一覧は今の会社・選んだ建物で、消していない行だけを取る", async () => {
    const { client, calls } = fakeClient({ tables: { files: { data: [] } } });
    await listFiles(client, T, B);
    const chain = calls.find((c) => c.kind === "from" && c.name === "files")!.chain!;
    expect(chain).toContainEqual(["eq", ["tenant_id", T]]);
    expect(chain).toContainEqual(["eq", ["building_id", B]]);
    expect(chain).toContainEqual(["is", ["deleted_at", null]]);
  });
});

describe("R-005-13 置き場所のパス", () => {
  it("R-005-13 置き場所の名前は ASCII だけにし、拡張子は残す（日本語の名前は画面に出す名前として行に持つ）", () => {
    expect(safeObjectName("契約書.pdf")).toBe("file.pdf");
    expect(safeObjectName("plan v2 (final).PDF")).toBe("plan_v2_final_.PDF");
    expect(safeObjectName("")).toBe("file");
    expect(safeObjectName("あ".repeat(10))).toBe("file");
    expect(safeObjectName("a".repeat(300) + ".pdf").length).toBeLessThanOrEqual(100);
    expect(safeObjectName("../../etc/passwd")).not.toContain("/");
  });
  it("R-005-13 パスは <tenant>/files/<uuid>/<名前>（DB の check と同じ形）", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const p = buildStoragePath(T, id, "図面 1.pdf");
    expect(p.startsWith(`${T}/files/${id}/`)).toBe(true);
    expect(p).toBe(`${T}/files/${id}/_1.pdf`);
    expect(p.length).toBeGreaterThan(`${T}/files/`.length);
  });
});

describe("R-005-13 上げる順：置き場所に上げてから行を作る", () => {
  const FILE = { name: "契約書.pdf", type: "application/pdf", size: 1234 };
  function deps(over: Partial<UploadDeps> = {}) {
    const log: string[] = [];
    const d: UploadDeps = {
      newId: () => "33333333-3333-4333-8333-333333333333",
      async upload(path) {
        log.push(`upload:${path}`);
      },
      async removeObject(path) {
        log.push(`remove:${path}`);
      },
      async insertRow(row) {
        log.push(`insert:${row.id}`);
        return { ...row, created_at: "2026-11-16T00:00:00Z", deleted_at: null, request_id: null, quote_id: null, shared_external: false };
      },
      ...over,
    };
    return { d, log };
  }

  it("R-005-13 上げてから行を作る。行の id と置き場所のパスの uuid は同じ", async () => {
    const { d, log } = deps();
    const row = await uploadFileFlow(d, T, B, FILE, FILE.name);
    expect(log).toEqual([`upload:${T}/files/33333333-3333-4333-8333-333333333333/file.pdf`, "insert:33333333-3333-4333-8333-333333333333"]);
    expect(row.name).toBe("契約書.pdf");
    expect(row.size).toBe(1234);
    expect(row.shared_external).toBe(false);
  });

  it("R-005-13 上げられなかったら、行は作らない", async () => {
    const { d, log } = deps({
      async upload() {
        throw new Error("offline");
      },
    });
    await expect(uploadFileFlow(d, T, B, FILE, FILE.name)).rejects.toThrow("offline");
    expect(log.some((l) => l.startsWith("insert"))).toBe(false);
  });

  it("R-005-13 行を作れなかったら、上げたファイルを消そうとして、元のエラーを返す", async () => {
    const { d, log } = deps({
      async insertRow() {
        throw new Error("rls denied");
      },
    });
    await expect(uploadFileFlow(d, T, B, FILE, FILE.name)).rejects.toThrow("rls denied");
    expect(log[log.length - 1]).toBe(`remove:${T}/files/33333333-3333-4333-8333-333333333333/file.pdf`);
  });

  it("R-005-13 消すのが失敗しても、元のエラーを返す（あとは掃除が拾う）", async () => {
    const { d } = deps({
      async insertRow() {
        throw new Error("rls denied");
      },
      async removeObject() {
        throw new Error("remove failed");
      },
    });
    await expect(uploadFileFlow(d, T, B, FILE, FILE.name)).rejects.toThrow("rls denied");
  });

  it("R-005-31 名前が空か長すぎるなら、何も上げない", async () => {
    const { d, log } = deps();
    await expect(uploadFileFlow(d, T, B, FILE, "  ")).rejects.toThrow();
    await expect(uploadFileFlow(d, T, B, FILE, "あ".repeat(256))).rejects.toThrow();
    expect(log).toEqual([]);
  });
});

describe("R-005-35 操作の出し分け（見せ方だけ。判定は DB）", () => {
  it("R-005-35 master.edit を持つ人にだけ、上げる・共有・消すを出す", () => {
    expect(canEditFiles(["master.edit", "field.record"])).toBe(true);
    expect(canEditFiles(["field.record"])).toBe(false);
    expect(canEditFiles([])).toBe(false);
    expect(canEditFiles(null)).toBe(false);
  });
});

describe("R-005-9 画面から URL を取る", () => {
  it("R-005-9 sign-file-urls に ID をまとめて渡し、URL と見つからなかった ID を受け取る", async () => {
    const { client, calls } = fakeClient({ invoke: { "sign-file-urls": { data: { urls: { a: "https://x.test/a" }, not_found: ["b"], failed: [] } } } });
    const r = await signUrls(client, ["a", "b"]);
    expect(r.urls).toEqual({ a: "https://x.test/a" });
    expect(r.notFound).toEqual(["b"]);
    const call = calls.find((c) => c.kind === "invoke")!;
    expect(call.name).toBe("sign-file-urls");
    expect((call.args as { body: { ids: string[] } }).body.ids).toEqual(["a", "b"]);
  });
  it("R-005-9 関数がエラーを返したら、例外にする", async () => {
    const { client } = fakeClient({ invoke: { "sign-file-urls": { error: { message: "x" } } } });
    await expect(signUrls(client, ["a"])).rejects.toBeTruthy();
  });
});

describe("R-005-26 入口：外部の人は専用ページへ", () => {
  it("R-005-26 外部の人のホームは /portal/、社内の人は /（そのまま）", () => {
    expect(homeFor("external")).toBe("/portal/");
    expect(homeFor("admin")).toBeNull();
    expect(homeFor("member")).toBeNull();
    expect(homeFor("staff")).toBeNull();
    expect(homeFor(undefined)).toBeNull();
  });
});

describe("R-005-25 専用ページが取る範囲", () => {
  it("R-005-25 建物は id・名前・住所だけを取り、位置・取引先・カルテの列を取らない", () => {
    expect(PORTAL_BUILDING_COLUMNS).toBe("id, name, address");
    expect(PORTAL_BUILDING_COLUMNS).not.toMatch(/lat|lng|client|owner|profile|key/);
  });
});

describe("R-005-28 区画の登録簿", () => {
  it("R-005-28 初めは共有されたファイルの区画がある", () => {
    expect(portalSections().map((s) => s.id)).toContain("shared-files");
  });
  it("R-005-28 後の機能（見積・報告書・作業）が区画を1つ足せば、同じページの並びに入る。同じ id は置き換える", () => {
    const quotes: PortalSection = { id: "quotes", title: "見積", async load() { return [{ key: "q1", label: "見積 1" }]; } };
    registerPortalSection(quotes);
    expect(portalSections().map((s) => s.id)).toEqual(["shared-files", "quotes"]);
    registerPortalSection({ ...quotes, title: "見積（新）" });
    expect(portalSections().filter((s) => s.id === "quotes")).toHaveLength(1);
    expect(portalSections().find((s) => s.id === "quotes")?.title).toBe("見積（新）");
  });
  it("R-005-28 区画は、建物の ID だけで中身を取る（共有されたファイルは、その建物の、消していない共有の行だけ）", async () => {
    const rows = [{ id: "f1", name: "契約書.pdf", mime: "application/pdf", size: 2048 }];
    const { client, calls } = fakeClient({ tables: { files: { data: rows } } });
    const items = await sharedFilesSection.load(client, B);
    expect(items).toEqual([{ key: "f1", label: "契約書.pdf", detail: "PDF・2.0 KB", fileId: "f1" }]);
    const chain = calls.find((c) => c.kind === "from" && c.name === "files")!.chain!;
    expect(chain).toContainEqual(["eq", ["building_id", B]]);
    expect(chain).toContainEqual(["eq", ["shared_external", true]]);
    expect(chain).toContainEqual(["is", ["deleted_at", null]]);
    const select = chain.find(([m]) => m === "select")!;
    expect(String(select[1][0])).not.toMatch(/storage_path/); // 置き場所のパスは画面に持ってこない
  });
});
