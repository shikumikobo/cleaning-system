// 予定を作る定時の処理の判断（機能 010。R-010-6〜12）。RRULE の読み解きと、会社ごとの回し方を、偽の口で確かめる。
// DB の関数と合わせた確かめは schedule-db.test.ts。
import { describe, expect, it } from "vitest";
import {
  addMonths,
  datesForService,
  expandRrule,
  parseRrule,
  runSchedule,
  sanitizeError,
  todayJst,
  type ScheduleStore,
  type ServiceRow,
} from "../../../supabase/functions/_shared/schedule";

describe("R-010-6 RRULE の読み解き（日付への展開）", () => {
  it("毎週 月・木", () => {
    expect(expandRrule("FREQ=WEEKLY;BYDAY=MO,TH", "2026-11-02", "2026-11-02", "2026-11-15")).toEqual(["2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12"]);
  });

  it("隔週火曜は、起点の週から数える（起点が火曜）", () => {
    expect(expandRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "2026-11-03", "2026-11-03", "2026-12-15")).toEqual(["2026-11-03", "2026-11-17", "2026-12-01", "2026-12-15"]);
  });

  it("隔週は、期間の始まりを後ろにずらしても、同じ週に当たる（起点から数える）", () => {
    expect(expandRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "2026-11-03", "2026-11-18", "2026-12-15")).toEqual(["2026-12-01", "2026-12-15"]);
  });

  it("月2回（10 日と 25 日）", () => {
    expect(expandRrule("FREQ=MONTHLY;BYMONTHDAY=10,25", "2026-11-10", "2026-11-10", "2027-01-31")).toEqual([
      "2026-11-10", "2026-11-25", "2026-12-10", "2026-12-25", "2027-01-10", "2027-01-25",
    ]);
  });

  it("毎月 第2火曜", () => {
    expect(expandRrule("FREQ=MONTHLY;BYDAY=2TU", "2026-11-01", "2026-11-01", "2027-01-31")).toEqual(["2026-11-10", "2026-12-08", "2027-01-12"]);
  });

  it("毎月 最終金曜", () => {
    expect(expandRrule("FREQ=MONTHLY;BYDAY=-1FR", "2026-11-01", "2026-11-01", "2027-01-31")).toEqual(["2026-11-27", "2026-12-25", "2027-01-29"]);
  });

  it("3か月ごと（起点の日）", () => {
    expect(expandRrule("FREQ=MONTHLY;INTERVAL=3", "2026-11-15", "2026-11-15", "2027-08-31")).toEqual(["2026-11-15", "2027-02-15", "2027-05-15", "2027-08-15"]);
  });

  it("月末（BYMONTHDAY=-1）は、月によって 28〜31 日", () => {
    expect(expandRrule("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-31", "2026-11-01", "2027-02-28")).toEqual(["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  });

  it("毎月 31 日は、31 日のない月を飛ばす", () => {
    expect(expandRrule("FREQ=MONTHLY", "2026-01-31", "2026-11-01", "2027-01-31")).toEqual(["2026-12-31", "2027-01-31"]);
  });

  it("単発（FREQ=DAILY;COUNT=1）は、起点の1日だけ。期間の外なら空", () => {
    expect(expandRrule("FREQ=DAILY;COUNT=1", "2026-12-01", "2026-11-16", "2027-01-16")).toEqual(["2026-12-01"]);
    expect(expandRrule("FREQ=DAILY;COUNT=1", "2026-11-01", "2026-11-16", "2027-01-16")).toEqual([]);
    expect(expandRrule("FREQ=DAILY;COUNT=1", "2027-03-01", "2026-11-16", "2027-01-16")).toEqual([]);
  });

  it("COUNT は、起点から数える（期間の前の分も数に入る）", () => {
    expect(expandRrule("FREQ=WEEKLY;BYDAY=MO;COUNT=3", "2026-11-02", "2026-11-16", "2027-02-01")).toEqual(["2026-11-16"]);
  });

  it("UNTIL は、その日を含む", () => {
    expect(expandRrule("FREQ=DAILY;INTERVAL=7;UNTIL=20261201", "2026-11-03", "2026-11-03", "2027-01-01")).toEqual(["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01"]);
  });

  it("曜日の指定がない毎週は、起点の曜日", () => {
    expect(expandRrule("FREQ=WEEKLY", "2026-11-04", "2026-11-04", "2026-11-25")).toEqual(["2026-11-04", "2026-11-11", "2026-11-18", "2026-11-25"]);
  });

  it("毎年（月・日の指定）", () => {
    expect(expandRrule("FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=1", "2026-04-01", "2026-11-01", "2028-12-31")).toEqual(["2027-04-01", "2028-04-01"]);
  });

  it("RRULE: の接頭辞と小文字を受け付ける", () => {
    expect(expandRrule("RRULE:freq=weekly;byday=mo", "2026-11-02", "2026-11-02", "2026-11-09")).toEqual(["2026-11-02", "2026-11-09"]);
  });

  it("読めない形は断る（黙って違う予定を作らない）", () => {
    for (const bad of ["", "毎週月曜", "FREQ=HOURLY", "FREQ=MONTHLY;BYDAY=2TU;BYSETPOS=1", "FREQ=WEEKLY;BYDAY=XX", "FREQ=WEEKLY;INTERVAL=0", "BYDAY=MO", "FREQ=WEEKLY;BYDAY=2MO", "FREQ=MONTHLY;BYMONTHDAY=0"]) {
      expect(parseRrule(bad).ok, bad).toBe(false);
      expect(() => expandRrule(bad, "2026-11-02", "2026-11-02", "2026-12-01"), bad).toThrow();
    }
  });

  it("長すぎる期間は展開しない", () => {
    expect(() => expandRrule("FREQ=DAILY;COUNT=99999", "1990-01-01", "2026-11-01", "2026-12-01")).toThrow();
  });
});

describe("日付の道具", () => {
  it("addMonths：その日のない月は月末に寄せる", () => {
    expect(addMonths("2026-11-16", 2)).toBe("2027-01-16");
    expect(addMonths("2026-12-31", 2)).toBe("2027-02-28");
    expect(addMonths("2027-12-31", 2)).toBe("2028-02-29");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
  it("todayJst：日本時間の日付", () => {
    expect(todayJst(new Date("2026-11-15T16:00:00Z"))).toBe("2026-11-16");
    expect(todayJst(new Date("2026-11-15T14:59:59Z"))).toBe("2026-11-15");
  });
  it("sanitizeError：鍵のような長い文字列を伏せる", () => {
    expect(sanitizeError(new Error("bad key abcdefghijklmnopqrstuvwxyz0123456789ABCDEF here"))).toBe("bad key *** here");
  });
});

const svc = (over: Partial<ServiceRow> = {}): ServiceRow => ({
  service_id: "s1", service_key: "k1", contract_id: "c1", name: "定期清掃", recurrence: "FREQ=WEEKLY;BYDAY=MO",
  valid_from: "2026-01-05", valid_to: null, contract_start: "2026-01-05", contract_end: null, staff: [], ...over,
});

describe("R-010-7 中身の期間と契約の期間の内側だけ作る", () => {
  it("今日から先だけ（過去の日は作らない）", () => {
    expect(datesForService(svc(), "2026-11-16", "2026-12-07")).toEqual(["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"]);
  });
  it("中身が閉じた日（valid_to）より後は作らない", () => {
    expect(datesForService(svc({ valid_to: "2026-11-30" }), "2026-11-16", "2026-12-31")).toEqual(["2026-11-16", "2026-11-23", "2026-11-30"]);
  });
  it("契約の終了日より後は作らない", () => {
    expect(datesForService(svc({ contract_end: "2026-11-23" }), "2026-11-16", "2026-12-31")).toEqual(["2026-11-16", "2026-11-23"]);
  });
  it("まだ始まっていない中身（valid_from が先）は、始まる日から。起点は valid_from（隔週の週がずれない）", () => {
    expect(datesForService(svc({ recurrence: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", valid_from: "2026-12-01", contract_start: "2026-01-05" }), "2026-11-16", "2026-12-31"))
      .toEqual(["2026-12-01", "2026-12-15", "2026-12-29"]);
  });
  it("契約の開始日より前は作らない", () => {
    expect(datesForService(svc({ valid_from: "2026-01-05", contract_start: "2026-12-01" }), "2026-11-16", "2026-12-14")).toEqual(["2026-12-07", "2026-12-14"]);
  });
});

// ---- 偽の口 ----
interface FakeOpts {
  tenants: string[];
  services?: Record<string, ServiceRow[]>;
  running?: string[]; // すでに動いている会社
  failInsert?: string[]; // insert が失敗する会社
}
function fakeStore(o: FakeOpts) {
  const log: string[] = [];
  const finished: Array<{ tenant: string; status: string; counts: Record<string, number>; error: string | null }> = [];
  const inserted: Array<{ tenant: string; run: string; works: Array<{ service_id: string; date: string }> }> = [];
  const asked: Array<{ tenant: string; from: string; to: string; contract: string | null }> = [];
  const store: ScheduleStore = {
    async tenants() {
      log.push("tenants");
      return o.tenants;
    },
    async startRun(t) {
      log.push(`start:${t}`);
      return o.running?.includes(t) ? null : `run-${t}`;
    },
    async services(t, from, to, contract) {
      asked.push({ tenant: t, from, to, contract });
      return o.services?.[t] ?? [];
    },
    async insert(t, run, works) {
      if (o.failInsert?.includes(t)) throw new Error("db down secret-abcdefghijklmnopqrstuvwxyz0123456789");
      inserted.push({ tenant: t, run, works });
      return { created: works.length, skipped: 0, assignments: 0, charges: 0 };
    },
    async finishRun(t, _run, status, counts, error) {
      finished.push({ tenant: t, status, counts, error });
    },
  };
  return { store, log, finished, inserted, asked };
}

describe("R-010-11・12 会社ごとに分けて回し、処理の記録を残す", () => {
  it("会社ごとに記録を始め、閉じる。作った件数が記録に入る", async () => {
    const f = fakeStore({ tenants: ["a", "b"], services: { a: [svc()], b: [svc({ service_id: "s2" })] } });
    const r = await runSchedule(f.store, { today: "2026-11-16" });
    expect(r).toMatchObject({ tenants: 2, skipped: 0, failedTenants: 0, services: 2, invalid: 0 });
    expect(f.finished.map((x) => `${x.tenant}:${x.status}`)).toEqual(["a:success", "b:success"]);
    expect(f.finished[0].counts.created).toBe(r.created / 2);
    expect(f.inserted.every((i) => i.run === `run-${i.tenant}`)).toBe(true);
  });

  it("今日から 2 か月先までを、中身に問い合わせる", async () => {
    const f = fakeStore({ tenants: ["a"], services: { a: [] } });
    await runSchedule(f.store, { today: "2026-12-31" });
    expect(f.asked).toEqual([{ tenant: "a", from: "2026-12-31", to: "2027-02-28", contract: null }]);
  });

  it("作る日は、今日から 2 か月先まで（毎週月曜なら 9 回）", async () => {
    const f = fakeStore({ tenants: ["a"], services: { a: [svc()] } });
    await runSchedule(f.store, { today: "2026-11-16" });
    const dates = f.inserted.flatMap((i) => i.works.map((w) => w.date));
    expect(dates[0]).toBe("2026-11-16");
    expect(dates[dates.length - 1]).toBe("2027-01-11");
    expect(dates.length).toBe(9);
  });

  it("1つの会社の失敗が、ほかの会社を止めない。失敗は記録に残り、鍵のような文字列は伏せる", async () => {
    const f = fakeStore({ tenants: ["a", "b", "c"], services: { a: [svc()], b: [svc()], c: [svc()] }, failInsert: ["b"] });
    const r = await runSchedule(f.store, { today: "2026-11-16" });
    expect(r.failedTenants).toBe(1);
    expect(f.finished.map((x) => `${x.tenant}:${x.status}`)).toEqual(["a:success", "b:failure", "c:success"]);
    const failed = f.finished.find((x) => x.tenant === "b")!;
    expect(failed.error).toContain("db down");
    expect(failed.error).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("同じ会社ですでに動いていれば、その会社は飛ばす（記録も作らない）", async () => {
    const f = fakeStore({ tenants: ["a", "b"], services: { a: [svc()], b: [svc()] }, running: ["a"] });
    const r = await runSchedule(f.store, { today: "2026-11-16" });
    expect(r.skipped).toBe(1);
    expect(f.finished.map((x) => x.tenant)).toEqual(["b"]);
    expect(f.inserted.map((x) => x.tenant)).toEqual(["b"]);
  });

  it("繰り返しが読めない中身は数えて飛ばし、ほかの中身は作る（会社は成功）", async () => {
    const f = fakeStore({ tenants: ["a"], services: { a: [svc({ recurrence: "FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO" }), svc({ service_id: "s2" })] } });
    const r = await runSchedule(f.store, { today: "2026-11-16" });
    expect(r).toMatchObject({ failedTenants: 0, services: 2, invalid: 1 });
    expect(f.finished[0]).toMatchObject({ status: "success" });
    expect(f.finished[0].counts.invalid).toBe(1);
    expect(f.inserted.every((i) => i.works.every((w) => w.service_id === "s2"))).toBe(true);
  });

  it("1つの会社・1つの契約に絞って回せる（画面の「いま作り直す」）", async () => {
    const f = fakeStore({ tenants: ["a", "b"], services: { b: [svc()] } });
    const r = await runSchedule(f.store, { today: "2026-11-16", tenant: "b", contract: "c1" });
    expect(f.log).not.toContain("tenants");
    expect(r.tenants).toBe(1);
    expect(f.asked).toEqual([{ tenant: "b", from: "2026-11-16", to: "2027-01-16", contract: "c1" }]);
  });

  it("作る作業がたくさんあるときは、500 件ずつに分けて送る", async () => {
    const f = fakeStore({ tenants: ["a"], services: { a: [svc({ recurrence: "FREQ=DAILY", valid_from: "2026-01-01", contract_start: "2026-01-01" })] } });
    await runSchedule(f.store, { today: "2026-11-16" });
    expect(f.inserted.length).toBeGreaterThan(0);
    expect(f.inserted.every((i) => i.works.length <= 500)).toBe(true);
    expect(f.inserted.reduce((n, i) => n + i.works.length, 0)).toBe(62);
  });

  it("対象の会社がなければ、何もしない", async () => {
    const f = fakeStore({ tenants: [] });
    expect(await runSchedule(f.store, { today: "2026-11-16" })).toMatchObject({ tenants: 0, created: 0 });
  });
});
