// 機能 009 の画面の部品：下書きの組み立て・端末にためる・送り直し・版の食い違い・写真の待ち・専用ページの区画・文面（R-009-24〜37）。
// 画面と通信は使わず、偽の口で確かめる。
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { capturePhoto, flushPhotos, openPhotoQueue, type PhotoSender } from "../photos/queue";
import type { ProcessedPhoto } from "../photos/process";
import {
  addDays,
  buildReportDraft,
  filterByReportStatus,
  isLocked,
  progressLabel,
  reportActionMessage,
  reportStatusLabel,
  reportWorkRange,
  reviewActions,
  sortReportItems,
  swapSort,
  templateDeleteMessage,
  validateName,
  WHOLE_ITEM_NAME,
} from "./format";
import { flushReports, openReportQueue, type ReportOutcome, type ReportSender } from "./queue";
import { createReportSender } from "./repo";
import type { ReportDraft, TemplateItemRow } from "./types";

const T = "11111111-1111-4111-8111-111111111111";
const W = "44444444-4444-4444-8444-444444444444";
const TPL = "55555555-5555-4555-8555-555555555555";

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}
const tItem = (id: string, name: string, sort: number, over: Partial<TemplateItemRow> = {}): TemplateItemRow => ({
  id, tenant_id: T, template_id: TPL, area_id: null, name, sort, active: true, deleted_at: null, ...over,
});

describe("R-009-24 端末での下書きの組み立て", () => {
  it("ひな形の使う項目を、並び順どおりに、項目の行として写す（チェックは外れ、メモは空）。報告書のひな形は作業が写した ID", () => {
    const d = buildReportDraft({
      tenantId: T,
      work: { id: W, report_template_id: TPL },
      templateItems: [tItem("t2", "ゴミ置き場", 2, { area_id: "a1" }), tItem("t1", "エントランス", 1)],
      deviceId: "dev-1",
      newId: ids(),
      now: () => "2026-11-20T00:00:00.000Z",
    });
    expect(d.report).toMatchObject({ id: "00000000-0000-4000-8000-000000000001", tenant_id: T, work_id: W, template_id: TPL, remarks: "", device_id: "dev-1" });
    expect(d.items.map((i) => [i.name, i.sort, i.template_item_id, i.area_id])).toEqual([
      ["エントランス", 1, "t1", null],
      ["ゴミ置き場", 2, "t2", "a1"],
    ]);
    expect(d.items.every((i) => i.done === false && i.note === "" && i.report_id === d.report.id && i.tenant_id === T)).toBe(true);
    expect(new Set([d.report.id, ...d.items.map((i) => i.id)]).size).toBe(3); // uuid はすべて別
  });

  it("「使わない」・消した項目は写さない", () => {
    const d = buildReportDraft({
      tenantId: T,
      work: { id: W, report_template_id: TPL },
      templateItems: [tItem("t1", "使う", 1), tItem("t2", "使わない", 2, { active: false }), tItem("t3", "消した", 3, { deleted_at: "2026-11-01T00:00:00Z" })],
      newId: ids(),
    });
    expect(d.items.map((i) => i.name)).toEqual(["使う"]);
  });

  it("ひな形がない・使う項目が1つもないときは、項目「清掃全体」を1つ作る（写真の付け先になる）。ひな形の ID は空のまま", () => {
    const none = buildReportDraft({ tenantId: T, work: { id: W, report_template_id: null }, templateItems: [], newId: ids() });
    expect(none.items).toHaveLength(1);
    expect(none.items[0]).toMatchObject({ name: WHOLE_ITEM_NAME, template_item_id: null, area_id: null, sort: 1 });
    expect(none.report.template_id).toBeNull();
    const off = buildReportDraft({ tenantId: T, work: { id: W, report_template_id: TPL }, templateItems: [tItem("t1", "x", 1, { active: false })], newId: ids() });
    expect(off.items.map((i) => i.name)).toEqual([WHOLE_ITEM_NAME]);
    expect(off.report.template_id).toBe(TPL);
  });
});

describe("R-009-30 状況・固定・進み具合の表記", () => {
  it("状況の表記と、固定の判定", () => {
    expect([reportStatusLabel("draft"), reportStatusLabel("checked"), reportStatusLabel("submitted"), reportStatusLabel(null)]).toEqual(["下書き", "確認済み", "提出", "未作成"]);
    expect([isLocked("draft"), isLocked("checked"), isLocked("submitted"), isLocked(undefined)]).toEqual([false, true, true, false]);
  });
  it("進み具合は、チェック済みの数 / 項目の数", () => {
    expect(progressLabel([{ done: true }, { done: false }, { done: true }])).toBe("2 / 3");
    expect(progressLabel([])).toBe("0 / 0");
  });
  it("項目は並び順で並ぶ", () => {
    expect(sortReportItems([{ sort: 2, name: "b" }, { sort: 1, name: "z" }, { sort: 1, name: "a" }]).map((i) => i.name)).toEqual(["a", "z", "b"]);
  });
});

describe("R-009-31 一覧の範囲と絞り込み", () => {
  it("作業の範囲は、2週間前から明日まで（日本時間の日付）", () => {
    expect(addDays("2026-11-20", -14)).toBe("2026-11-06");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(reportWorkRange("2026-11-20")).toEqual({ from: "2026-11-06", to: "2026-11-21" });
  });
  it("状況で絞る：空はすべて、none は報告書がまだない作業", () => {
    const rows = [{ status: null }, { status: "draft" }, { status: "submitted" }];
    expect(filterByReportStatus(rows, "")).toHaveLength(3);
    expect(filterByReportStatus(rows, "none")).toEqual([{ status: null }]);
    expect(filterByReportStatus(rows, "draft")).toEqual([{ status: "draft" }]);
  });
});

describe("R-009-33 確認・提出のボタンと文面", () => {
  it("押せるボタンは状況で決まる。work.assign がなければ出さない", () => {
    expect(reviewActions("draft", true)).toEqual({ check: true, reopen: false, submit: false });
    expect(reviewActions("checked", true)).toEqual({ check: false, reopen: true, submit: true });
    expect(reviewActions("submitted", true)).toEqual({ check: false, reopen: false, submit: false });
    expect(reviewActions("draft", false)).toEqual({ check: false, reopen: false, submit: false });
  });
  it("RPC の戻りを、日本語の文面にする", () => {
    expect(reportActionMessage("check", { ok: true })).toBe("確認済みにしました");
    expect(reportActionMessage("submit", { ok: true })).toBe("提出しました");
    expect(reportActionMessage("reopen", { ok: true })).toBe("下書きに戻しました");
    expect(reportActionMessage("check", { ok: true, already: true })).toBe("すでにその状況です");
    expect(reportActionMessage("submit", { ok: false, reason: "not_checked" })).toContain("確認してから");
    expect(reportActionMessage("reopen", { ok: false, reason: "submitted" })).toContain("提出済み");
  });
});

describe("R-009-35 ひな形の編集の部品", () => {
  it("名前の検査（空・空白だけ・100 字超は保存しない）", () => {
    expect(validateName("")).toBeTruthy();
    expect(validateName("   ")).toBeTruthy();
    expect(validateName("あ".repeat(101))).toBeTruthy();
    expect(validateName("あ".repeat(100))).toBeNull();
    expect(validateName("共用部")).toBeNull();
  });
  it("項目を1つ上・下に動かす：並び順を振り直し、変わるものだけ返す。端は動かせない", () => {
    const items = [{ id: "a", sort: 1 }, { id: "b", sort: 2 }, { id: "c", sort: 3 }];
    expect(swapSort(items, "b", -1)).toEqual([{ id: "b", sort: 1 }, { id: "a", sort: 2 }]);
    expect(swapSort(items, "b", 1)).toEqual([{ id: "c", sort: 2 }, { id: "b", sort: 3 }]);
    expect(swapSort(items, "a", -1)).toBeNull();
    expect(swapSort(items, "c", 1)).toBeNull();
    // 並び順が同じ・飛んでいても、位置で振り直す
    expect(swapSort([{ id: "x", sort: 5 }, { id: "y", sort: 5 }], "y", -1)).toEqual([{ id: "y", sort: 1 }, { id: "x", sort: 2 }]);
  });
  it("消せなかった・使わないにした理由を、日本語にする（R-009-4・5）", () => {
    expect(templateDeleteMessage("template", { ok: true, deleted: true })).toBe("ひな形を消しました。");
    const m = templateDeleteMessage("template", { ok: true, deactivated: true, blockers: [{ reason: "used_by_works", table: "works", count: 2 }, { reason: "used_by_reports", table: "reports", count: 1 }] });
    expect(m).toContain("「使わない」にしました");
    expect(m).toContain("作業が 2 件");
    expect(m).toContain("報告書が 1 件");
    expect(templateDeleteMessage("item", { ok: true, deactivated: true, blockers: [{ reason: "used_by_report_items", table: "report_items", count: 3 }] })).toContain("報告書の項目が 3 件");
  });
});

// ---- 端末にためる・送り直し ----
const draftOf = (reportId: string, remarks = ""): ReportDraft => {
  const base = { tenant_id: T, report_id: reportId, template_item_id: null, area_id: null, done: false, note: "", client_created_at: "2026-11-20T00:00:00Z", device_id: "d" };
  return {
    report: { id: reportId, tenant_id: T, work_id: W + reportId.slice(-1), template_id: null, remarks, client_created_at: "2026-11-20T00:00:00Z", device_id: "d" },
    items: [{ ...base, id: reportId + "-i1", name: "A", sort: 1 }, { ...base, id: reportId + "-i2", name: "B", sort: 2 }],
  };
};
const R1 = "r1";
const R2 = "r2";
let dbn = 0;
const newQueue = () => openReportQueue(`rq-${++dbn}`);

function sender(log: string[], over: Partial<{ [K in keyof ReportSender]: (...a: Parameters<ReportSender[K]>) => ReportOutcome }> = {}): ReportSender {
  const ok = (): ReportOutcome => ({ ok: true });
  return {
    async insertReport(row) {
      log.push(`report:${row.id}`);
      return (over.insertReport ?? ok)(row);
    },
    async insertItems(rows) {
      log.push(`items:${rows.map((r) => r.id).join("+")}`);
      return (over.insertItems ?? ok)(rows);
    },
    async updateItem(item) {
      log.push(`update-item:${item.id}`);
      return (over.updateItem ?? ok)(item);
    },
    async updateRemarks(id, remarks, v) {
      log.push(`remarks:${id}:${remarks}:v${v}`);
      return (over.updateRemarks ?? (() => ({ ok: true, version: v + 1 })))(id, remarks, v);
    },
  };
}

describe("R-009-25 端末の入れ物", () => {
  it("報告書ごとに1件。保存し直すと中身を置き換え、版の条件と最初にためた時刻は残す", async () => {
    const q = await newQueue();
    const a = await q.save(draftOf(R1, "最初"), { tenantId: T, baseVersion: 3 });
    expect(a).toMatchObject({ id: R1, rev: 1, baseVersion: 3, attempts: 0 });
    const b = await q.save(draftOf(R1, "直した"), { tenantId: T, baseVersion: 9 });
    expect(b.rev).toBe(2);
    expect(b.baseVersion).toBe(3);
    expect(b.queuedAt).toBe(a.queuedAt);
    expect(b.draft.report.remarks).toBe("直した");
    expect(await q.count()).toBe(1);
    await q.save(draftOf(R2), { tenantId: T, baseVersion: 1 });
    expect((await q.list()).map((x) => x.id)).toEqual([R1, R2]);
  });
  it("送れるまで消えない：rev が変わっていたら、消さない", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1), { tenantId: T, baseVersion: 1 });
    expect(await q.remove(R1, 99)).toBe(false);
    expect(await q.count()).toBe(1);
    expect(await q.remove(R1, 1)).toBe(true);
    expect(await q.count()).toBe(0);
  });
});

describe("R-009-26 送る順・二度送らない・電波がないとき", () => {
  it("報告書 → 項目 → 項目のチェックとメモ → 報告書のメモの順に送り、送れたら端末から消す", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1, "気づき"), { tenantId: T, baseVersion: 1 });
    const log: string[] = [];
    const r = await flushReports(q, sender(log));
    expect(r).toEqual({ sent: 1, synced: { [R1]: { version: 2, remarks: "気づき" } }, rejected: 0, remaining: 0, offline: false });
    expect(log).toEqual([`report:${R1}`, `items:${R1}-i1+${R1}-i2`, `update-item:${R1}-i1`, `update-item:${R1}-i2`, `remarks:${R1}:気づき:v1`]);
    expect(await q.count()).toBe(0);
  });
  it("端末で作った uuid のまま送る（既にあれば無視する側が、二重を作らない）。重複でも送れたこととして消す", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1), { tenantId: T, baseVersion: 1 });
    const r = await flushReports(q, sender([], { insertReport: () => ({ ok: true, duplicate: true }), insertItems: () => ({ ok: true, duplicate: true }) }));
    expect(r).toMatchObject({ sent: 1, remaining: 0 });
  });
  it("電波がない・ログインが切れていれば、そこで止めて残す（エラーにしない）。戻ったら、続きから送る", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1), { tenantId: T, baseVersion: 1 });
    await q.save(draftOf(R2), { tenantId: T, baseVersion: 1 });
    const log: string[] = [];
    const r1 = await flushReports(q, sender(log, { insertItems: () => ({ ok: false, kind: "network", message: "offline" }) }));
    expect(r1).toMatchObject({ sent: 0, remaining: 2, offline: true });
    expect(log).toEqual([`report:${R1}`, `items:${R1}-i1+${R1}-i2`]); // 止めたので、2つ目には進まない
    const r2 = await flushReports(q, sender([], { insertReport: () => ({ ok: false, kind: "auth", message: "jwt expired" }) }));
    expect(r2.offline).toBe(true);
    const r3 = await flushReports(q, sender([]));
    expect(r3).toMatchObject({ sent: 2, remaining: 0, offline: false });
  });
  it("通信が例外で失敗しても（fetch の失敗）、電波がないこととして残す", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1), { tenantId: T, baseVersion: 1 });
    const bad: ReportSender = { ...sender([]), insertReport: async () => { throw new TypeError("Failed to fetch"); } };
    const r = await flushReports(q, bad);
    expect(r).toMatchObject({ sent: 0, remaining: 1, offline: true });
  });
  it("同時に2回呼んでも、1つだけ動く（同じ報告書を二度送らない）", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1), { tenantId: T, baseVersion: 1 });
    const log: string[] = [];
    const [a, b] = await Promise.all([flushReports(q, sender(log)), flushReports(q, sender(log))]);
    expect(a).toBe(b);
    expect(log.filter((l) => l.startsWith("report:"))).toHaveLength(1);
  });
  it("動いている間にもう一度呼ばれたら、終わったあとにもう一度動く（途中で電波が戻っても、取りこぼさない）", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1), { tenantId: T, baseVersion: 1 });
    let online = false;
    let calls = 0;
    const s: ReportSender = {
      ...sender([]),
      insertReport: async () => {
        calls++;
        if (calls === 1) {
          // この間に電波が戻り、もう一度呼ばれる
          online = true;
          void flushReports(q, s);
        }
        return online && calls > 1 ? { ok: true } : { ok: false, kind: "network", message: "offline" };
      },
    };
    const r = await flushReports(q, s);
    expect(calls).toBe(2);
    expect(r.sent).toBe(1);
    expect(await q.count()).toBe(0);
  });
  it("送っている間に直されたら、消さずに残し、次は今のサーバーの版を条件にする", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1, "前"), { tenantId: T, baseVersion: 1 });
    const s = sender([], {
      updateRemarks: (_id, _r, v) => {
        void q.save(draftOf(R1, "送っている間に直した"), { tenantId: T, baseVersion: 1 });
        return { ok: true, version: v + 1 };
      },
    });
    const first = await flushReports(q, s);
    expect(first.sent).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    const [left] = await q.list();
    expect(left.draft.report.remarks).toBe("送っている間に直した");
    expect(left.baseVersion).toBe(2);
    expect(left.serverRemarks).toBe("前");
    const log: string[] = [];
    await flushReports(q, sender(log));
    expect(log).toContain(`remarks:${R1}:送っている間に直した:v2`);
    expect(await q.count()).toBe(0);
  });
});

describe("R-009-28 メモがサーバーと同じなら、送らない（版を無駄に上げない）", () => {
  it("サーバーが持つメモと同じなら、メモは送らない。違えば送る。送れたら、次の保存の条件（版・メモ）を返す", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1, "同じ"), { tenantId: T, baseVersion: 3, serverRemarks: "同じ" });
    const log: string[] = [];
    const r = await flushReports(q, sender(log));
    expect(log.some((l) => l.startsWith("remarks:"))).toBe(false);
    expect(r.synced[R1]).toEqual({ version: 3, remarks: "同じ" });
    await q.save(draftOf(R1, "変えた"), { tenantId: T, baseVersion: 3, serverRemarks: "同じ" });
    const log2: string[] = [];
    const r2 = await flushReports(q, sender(log2));
    expect(log2.filter((l) => l.startsWith("remarks:"))).toEqual([`remarks:${R1}:変えた:v3`]);
    expect(r2.synced[R1]).toEqual({ version: 4, remarks: "変えた" });
  });
});

describe("R-009-27 サーバーに断られたもの", () => {
  it("端末に残し、理由を覚え、次の報告書へ進む。あきらめて消せる", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1), { tenantId: T, baseVersion: 1 });
    await q.save(draftOf(R2), { tenantId: T, baseVersion: 1 });
    const r = await flushReports(q, sender([], { insertReport: (row) => (row.id === R1 ? { ok: false, kind: "server", message: "権限がない", code: "42501" } : { ok: true }) }));
    expect(r).toMatchObject({ sent: 1, rejected: 1, remaining: 1, offline: false });
    const [left] = await q.list();
    expect(left).toMatchObject({ id: R1, lastCode: "42501", lastError: "権限がない", attempts: 1 });
    await q.remove(R1);
    expect(await q.count()).toBe(0);
  });
  it("保存し直すと、断られた記録（回数・理由）は消え、また送る", async () => {
    const q = await newQueue();
    await q.save(draftOf(R1), { tenantId: T, baseVersion: 1 });
    await flushReports(q, sender([], { insertReport: () => ({ ok: false, kind: "server", message: "x", code: "42501" }) }));
    const again = await q.save(draftOf(R1, "直した"), { tenantId: T, baseVersion: 1 });
    expect(again).toMatchObject({ attempts: 0, lastError: undefined });
  });
});

// ---- 送る口（Supabase の表）：版の食い違い ----
type Ans = { data?: unknown; error?: { message: string; code?: string } | null };
function scripted(answers: Ans[]) {
  const calls: Array<{ table: string; chain: Array<[string, unknown[]]> }> = [];
  let i = 0;
  const client = {
    from(table: string) {
      const chain: Array<[string, unknown[]]> = [];
      const a = answers[i++] ?? { data: null, error: null };
      calls.push({ table, chain });
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") return (res: (v: unknown) => void) => res({ data: a.data ?? null, error: a.error ?? null });
            return (...args: unknown[]) => {
              chain.push([prop, args]);
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("R-009-28 報告書のメモを送るとき、版を条件にする", () => {
  it("版が合えば直り、版が 1 つ上がる（条件は version = 送る前の版）", async () => {
    const { client, calls } = scripted([{ data: [{ id: R1 }] }]);
    const r = await createReportSender(client).updateRemarks(R1, "メモ", 4);
    expect(r).toEqual({ ok: true, version: 5 });
    expect(calls[0].chain).toContainEqual(["update", [{ remarks: "メモ", version: 5 }]]);
    expect(calls[0].chain).toContainEqual(["eq", ["version", 4]]);
  });
  it("版が食い違い、サーバーのメモが違うときは、「ほかの人が直しています」で断る", async () => {
    const { client } = scripted([{ data: [] }, { data: { remarks: "別の人のメモ", version: 5, status: "draft" } }]);
    const r = await createReportSender(client).updateRemarks(R1, "自分のメモ", 4);
    expect(r).toMatchObject({ ok: false, kind: "server", code: "version" });
    expect((r as { message: string }).message).toContain("ほかの人が直しています");
  });
  it("版が食い違っても、サーバーのメモが自分のものと同じなら、送れたことにする（二度目の送りなど）", async () => {
    const { client } = scripted([{ data: [] }, { data: { remarks: "自分のメモ", version: 5, status: "draft" } }]);
    expect(await createReportSender(client).updateRemarks(R1, "自分のメモ", 4)).toEqual({ ok: true, version: 5 });
  });
  it("確認・提出のあと（下書きでない）は、固定のあととして断る", async () => {
    const { client } = scripted([{ data: [] }, { data: { remarks: "古い", version: 6, status: "submitted" } }]);
    expect(await createReportSender(client).updateRemarks(R1, "自分のメモ", 4)).toMatchObject({ ok: false, kind: "server", code: "locked" });
  });
  it("項目のチェックを直す行が 0 件のとき（固定のあと）も、固定のあととして断る", async () => {
    const { client } = scripted([{ data: [] }]);
    const item = draftOf(R1).items[0];
    expect(await createReportSender(client).updateItem(item)).toMatchObject({ ok: false, code: "locked" });
  });
  it("同じ作業に別の uuid の報告書（reports_work_uq）は、重複ではなく断られたもの。同じ uuid の重複は送れたこと", async () => {
    const dupWork = scripted([{ error: { code: "23505", message: 'duplicate key value violates unique constraint "reports_work_uq"' } }]);
    const r = await createReportSender(dupWork.client).insertReport(draftOf(R1).report);
    expect(r).toMatchObject({ ok: false, kind: "server", code: "23505" });
    expect((r as { message: string }).message).toContain("ほかの端末で作られています");
    const dupId = scripted([{ error: { code: "23505", message: 'duplicate key value violates unique constraint "reports_pkey"' } }]);
    expect(await createReportSender(dupId.client).insertReport(draftOf(R1).report)).toEqual({ ok: true, duplicate: true });
  });
  it("報告書と項目は、既にあれば無視する書き方（onConflict id・ignoreDuplicates）で送る", async () => {
    const { client, calls } = scripted([{}, {}]);
    const s = createReportSender(client);
    await s.insertReport(draftOf(R1).report);
    await s.insertItems(draftOf(R1).items);
    expect(calls[0].chain[0]).toEqual(["upsert", [draftOf(R1).report, { onConflict: "id", ignoreDuplicates: true }]]);
    expect(calls[1].chain[0][1][1]).toEqual({ onConflict: "id", ignoreDuplicates: true });
  });
});

// ---- 写真：報告書の項目の行が先に届くまで待つ ----
const processed: ProcessedPhoto = { photo: new ArrayBuffer(8), thumb: new ArrayBuffer(4), width: 1600, height: 1200, bytes: 8, thumbWidth: 320, thumbHeight: 240 };

describe("R-009-29 報告書の項目つきの写真", () => {
  it("写真の行は、作業・報告書の項目を持つ", async () => {
    const q = await openPhotoQueue(`pq-${++dbn}`);
    const item = await capturePhoto(q, { tenantId: T, membershipId: "m1" }, {
      building_id: "b1", kind: "after", taken_at: "2026-11-20T00:00:00Z", work_id: W, report_item_id: "item-1", processed,
    });
    expect(item.row).toMatchObject({ work_id: W, report_item_id: "item-1", kind: "after" });
    const plain = await capturePhoto(q, { tenantId: T, membershipId: "m1" }, { building_id: "b1", kind: "before", taken_at: "2026-11-20T00:00:00Z", processed });
    expect(plain.row).toMatchObject({ work_id: null, report_item_id: null });
  });
  it("項目の行がサーバーにまだなければ、断られた扱いにせず待つ（残す）。届いたら送る", async () => {
    const q = await openPhotoQueue(`pq-${++dbn}`);
    await capturePhoto(q, { tenantId: T, membershipId: "m1" }, { building_id: "b1", kind: "after", taken_at: "2026-11-20T00:00:00Z", work_id: W, report_item_id: "item-1", processed });
    let itemExists = false;
    const log: string[] = [];
    const s: PhotoSender = {
      async uploadFile(path) {
        log.push(`upload:${path.split("/").pop()}`);
        return { ok: true };
      },
      async insertRow() {
        log.push("insert");
        return { ok: true };
      },
      async ready() {
        return itemExists;
      },
    };
    const r1 = await flushPhotos(q, s);
    expect(r1).toMatchObject({ sent: 0, rejected: 0, waiting: 1, remaining: 1, offline: false });
    expect(log).toEqual([]);
    const [kept] = await q.list();
    expect(kept.attempts).toBe(0);
    itemExists = true;
    const r2 = await flushPhotos(q, s);
    expect(r2).toMatchObject({ sent: 1, waiting: 0, remaining: 0 });
    expect(log).toEqual(["upload:photo.jpg", "upload:thumb.jpg", "insert"]);
  });
  it("確かめられないとき（電波がない）も、待つ。項目のない写真は、確かめずに送る", async () => {
    const q = await openPhotoQueue(`pq-${++dbn}`);
    await capturePhoto(q, { tenantId: T, membershipId: "m1" }, { building_id: "b1", kind: "after", taken_at: "2026-11-20T00:00:00Z", work_id: W, report_item_id: "item-1", processed });
    await capturePhoto(q, { tenantId: T, membershipId: "m1" }, { building_id: "b1", kind: "observation", taken_at: "2026-11-20T00:00:01Z", work_id: W, processed });
    const s: PhotoSender = {
      uploadFile: async () => ({ ok: true }),
      insertRow: async () => ({ ok: true }),
      ready: async () => {
        throw new TypeError("Failed to fetch");
      },
    };
    const r = await flushPhotos(q, s);
    expect(r).toMatchObject({ sent: 1, waiting: 1, remaining: 1 });
    expect((await q.list())[0].row.report_item_id).toBe("item-1");
  });
});

// ---- 専用ページの区画 ----
describe("R-009-36 専用ページの、報告書と写真の区画", () => {
  it("登録すると登録簿に入り、何度登録しても1つずつ", async () => {
    const { portalSections } = await import("../files/portal");
    const { registerReportPortalSections } = await import("./portal");
    registerReportPortalSections();
    registerReportPortalSections();
    expect(portalSections().filter((s) => s.id === "reports")).toHaveLength(1);
    expect(portalSections().filter((s) => s.id === "report-photos")).toHaveLength(1);
  });

  it("報告書の区画は、建物の ID だけで、提出した報告書の日・項目と結果・メモを取る（名前・担当・金額の列は取らない）", async () => {
    const { PORTAL_REPORT_COLUMNS, PORTAL_REPORT_ITEM_COLUMNS, PORTAL_REPORT_WORK_COLUMNS, reportsPortalSection } = await import("./portal");
    const { client, calls } = scripted([
      { data: [{ id: "w1", scheduled_date: "2026-11-18" }, { id: "w2", scheduled_date: "2026-11-20" }] },
      { data: [{ id: "r1", work_id: "w1", remarks: "窓にしみ", submitted_at: "2026-11-19T00:00:00Z" }, { id: "r2", work_id: "w2", remarks: "", submitted_at: "2026-11-21T00:00:00Z" }] },
      { data: [{ id: "i2", report_id: "r1", name: "ゴミ置き場", sort: 2, done: false, note: "" }, { id: "i1", report_id: "r1", name: "エントランス", sort: 1, done: true, note: "拭いた" }, { id: "i3", report_id: "r2", name: "階段", sort: 1, done: true, note: "" }] },
    ]);
    const items = await reportsPortalSection.load(client, "b1");
    expect(items.map((i) => i.label)).toEqual(["2026年11月20日", "2026年11月18日"]); // 作業の日の新しい順
    expect(items[1].detail).toBe("チェック 1 / 2／窓にしみ");
    expect(items[1].children?.map((c) => `${c.label}|${c.detail}`)).toEqual(["済 エントランス|拭いた", "未 ゴミ置き場|"]);
    expect(calls[0].table).toBe("works");
    expect(calls[0].chain).toContainEqual(["eq", ["building_id", "b1"]]);
    expect(calls[1].table).toBe("reports");
    expect(calls[1].chain).toContainEqual(["eq", ["status", "submitted"]]);
    expect(calls[2].table).toBe("report_items");
    expect(PORTAL_REPORT_COLUMNS).toBe("id, work_id, remarks, submitted_at");
    expect(PORTAL_REPORT_ITEM_COLUMNS).toBe("id, report_id, name, sort, done, note");
    expect(PORTAL_REPORT_WORK_COLUMNS).toBe("id, scheduled_date");
  });

  it("作業がない建物は、報告書を取りにいかず、空", async () => {
    const { reportsPortalSection } = await import("./portal");
    const { client, calls } = scripted([{ data: [] }]);
    expect(await reportsPortalSection.load(client, "b1")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("写真の区画は、建物の、報告書の項目につく写真だけ取り、押すと写真を開く印（photoId）を持つ（置き場所のパスは取らない）", async () => {
    const { PORTAL_REPORT_PHOTO_COLUMNS, reportPhotosPortalSection } = await import("./portal");
    const { client, calls } = scripted([{ data: [{ id: "p1", kind: "after", taken_at: "2026-11-20T01:00:00Z", report_item_id: "i1" }] }]);
    const items = await reportPhotosPortalSection.load(client, "b1");
    expect(items).toEqual([{ key: "p1", label: "2026年11月20日 作業後", photoId: "p1" }]);
    expect(calls[0].table).toBe("photos");
    expect(calls[0].chain).toContainEqual(["eq", ["building_id", "b1"]]);
    expect(calls[0].chain).toContainEqual(["not", ["report_item_id", "is", null]]);
    expect(PORTAL_REPORT_PHOTO_COLUMNS).toBe("id, kind, taken_at, report_item_id");
  });
});
