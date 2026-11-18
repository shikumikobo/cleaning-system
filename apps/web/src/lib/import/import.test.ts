// 機能 014：データの取り込みの純粋な関数（ひな形・読み込み・見出し・検査・重なり・契約のまとめ・頻度の読み解き）。R-014-1〜9
import { describe, expect, it } from "vitest";
import { KINDS, columnsOf, kindLabel } from "./columns";
import { decodeCsvBytes, parseCsv } from "./csv";
import { importKey } from "./normalize";
import { emptyExisting, planImport, type Existing } from "./plan";
import { parseDate, parseRecurrence, parseTime } from "./values";
import { templateCsv, templateMatrix, templateXlsx } from "./template";
import { toTable } from "./table";
import { buildXlsx, readXlsx } from "./xlsx";

const bytes = (s: string) => new TextEncoder().encode(s);
const plan = (kind: Parameters<typeof planImport>[0], matrix: string[][], existing: Existing = emptyExisting()) => {
  const t = toTable(kind, matrix);
  if (!t.ok) throw new Error("見出しが足りない：" + t.missing.join("・"));
  return planImport(kind, t.rows, existing);
};

describe("名前の比べ方（R-014-9）", () => {
  it("R-014-9 全角半角・空白・大文字小文字の違いを無視して同じにする", () => {
    expect(importKey("  ＡＢＣ　商会 ")).toBe(importKey("abc 商会"));
    expect(importKey("ﾃｽﾄ管理会社")).toBe(importKey("テスト管理会社"));
    expect(importKey("101")).toBe(importKey("１０１"));
    expect(importKey("A  B")).toBe("a b");
  });
});

describe("CSV の読み込み（R-014-2）", () => {
  it("R-014-2 UTF-8（BOM あり・なし）を読む", () => {
    expect(decodeCsvBytes(bytes("名前,住所\r\n"))).toBe("名前,住所\r\n");
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("名前")]))).toBe("名前");
  });
  it("R-014-2 Shift_JIS（Excel の「CSV」の保存）を読む", () => {
    // あいう,ﾃ（半角カナ）
    const sjis = new Uint8Array([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x2c, 0xc3]);
    expect(decodeCsvBytes(sjis)).toBe("あいう,ﾃ");
  });
  it("R-014-2 引用符・セルの中のカンマ・改行・CRLF・末尾の空行を正しく扱う", () => {
    const m = parseCsv('a,b,c\r\n"x,1","y\r\nz","say ""hi"""\r\n\r\n,,\r\n');
    expect(m).toEqual([["a", "b", "c"], ["x,1", "y\r\nz", 'say "hi"']]); // 末尾の空の行は落とす
    expect(parseCsv("a\r\n\r\nb\r\n")).toEqual([["a"], [""], ["b"]]); // 途中の空行は残す（行番号がずれないように）
  });
  it("R-014-2 LF だけの改行・最後に改行がないファイルも読む", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("xlsx の読み込み（R-014-3）", () => {
  it("R-014-3 取り込む種類の名前のシートがあればそれを、なければ最初のシートを読む", async () => {
    const buf = buildXlsx([
      { name: "説明", rows: [["これは説明"]] },
      { name: "建物", rows: [["取引先名", "建物名", "住所"], ["青空管理", "ひまわりビル", "東京都1"]] },
    ]);
    const byName = await readXlsx(buf, "buildings");
    expect(byName.sheet).toBe("建物");
    expect(byName.matrix[1]).toEqual(["青空管理", "ひまわりビル", "東京都1"]);
    const first = await readXlsx(buf, "clients");
    expect(first.sheet).toBe("説明");
  });
  it("R-014-3 数値・日付・時刻のセルを、画面に見えるとおりの文字にして読む", async () => {
    const buf = buildXlsx([
      {
        name: "契約",
        rows: [
          ["開始日", "金額", "開始時刻", "部屋", "電話"],
          [{ date: "2026-12-01" }, 30000, { time: "09:30" }, 101, "03-1234-5678"],
        ],
      },
    ]);
    const r = await readXlsx(buf, "contracts");
    expect(r.matrix[1]).toEqual(["2026-12-01", "30000", "09:30", "101", "03-1234-5678"]);
  });
  it("R-014-3 xlsx でないファイルは、読めないと分かる", async () => {
    await expect(readXlsx(bytes("これはxlsxではない").buffer as ArrayBuffer, "clients")).rejects.toThrow();
  });
});

describe("見出し（R-014-4）", () => {
  it("R-014-4 見出しの順番は問わない。全角半角・空白の違いは無視する", () => {
    const t = toTable("rooms", [["　階 ", "部屋番号", "建物名", "取引先名"], ["1", "101", "ひまわり", "青空"]]);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.rows[0].cells).toMatchObject({ floor: "1", room_no: "101", building_name: "ひまわり", client_name: "青空" });
  });
  it("R-014-4 必須の見出しが足りなければ、ファイル全体のエラーにして、足りない見出しを出す", () => {
    const t = toTable("buildings", [["取引先名", "建物名"], ["a", "b"]]);
    expect(t).toEqual({ ok: false, missing: ["住所"] });
    const none = toTable("clients", [[]]);
    expect(none.ok).toBe(false);
  });
  it("R-014-4 知らない見出しは無視し、知らせる。空の行は飛ばし、行番号はファイルの行のとおり（見出しが1行目）", () => {
    const t = toTable("clients", [["名前", "メモ", "住所"], ["甲商事", "x", "東京"], ["", "", ""], ["乙商事", "", "大阪"]]);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.ignored).toEqual(["メモ"]);
    expect(t.rows.map((r) => [r.row, r.cells.name])).toEqual([[2, "甲商事"], [4, "乙商事"]]);
  });
});

describe("値の読み解き", () => {
  it("R-014-8 日付は 2026-12-01・2026/12/1・2026年12月1日を読み、存在しない日はエラー", () => {
    expect(parseDate("2026-12-01")).toBe("2026-12-01");
    expect(parseDate("2026/1/5")).toBe("2026-01-05");
    expect(parseDate("２０２６年１２月１日")).toBe("2026-12-01");
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull();
    expect(parseDate("来月")).toBeNull();
  });
  it("R-014-8 時刻は 9:00・09:00・9時30分・0.375（Excel の数）を読む", () => {
    expect(parseTime("9:00")).toBe("09:00");
    expect(parseTime("９時３０分")).toBe("09:30");
    expect(parseTime("17:05:00")).toBe("17:05");
    expect(parseTime("0.375")).toBe("09:00");
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("あ")).toBeNull();
  });
  it("R-014-8 頻度：RRULE と日本語を読む。読めない言葉はエラー", () => {
    const ok = (s: string, rule: string) => expect(parseRecurrence(s)).toEqual({ ok: true, rrule: rule });
    ok("", "FREQ=DAILY;COUNT=1");
    ok("単発", "FREQ=DAILY;COUNT=1");
    ok("FREQ=WEEKLY;BYDAY=MO", "FREQ=WEEKLY;BYDAY=MO");
    ok("rrule:freq=weekly;byday=tu", "FREQ=WEEKLY;BYDAY=TU");
    ok("毎週月曜", "FREQ=WEEKLY;BYDAY=MO");
    ok("毎週 火曜日", "FREQ=WEEKLY;BYDAY=TU");
    ok("隔週木曜", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH");
    ok("毎月第2水曜", "FREQ=MONTHLY;BYDAY=2WE");
    ok("毎月第２水曜日", "FREQ=MONTHLY;BYDAY=2WE");
    ok("毎月最終金曜", "FREQ=MONTHLY;BYDAY=-1FR");
    ok("毎月15日", "FREQ=MONTHLY;BYMONTHDAY=15");
    ok("毎月末", "FREQ=MONTHLY;BYMONTHDAY=-1");
    ok("3か月に1回", "FREQ=MONTHLY;INTERVAL=3");
    ok("６ヶ月に1回", "FREQ=MONTHLY;INTERVAL=6");
    ok("毎日", "FREQ=DAILY");
    expect(parseRecurrence("ときどき").ok).toBe(false);
    expect(parseRecurrence("FREQ=SOMETIMES").ok).toBe(false);
    expect(parseRecurrence("毎月第9水曜").ok).toBe(false);
    expect(parseRecurrence("毎月40日").ok).toBe(false);
  });
});

describe("ひな形（R-014-1）", () => {
  it("R-014-1 取引先・建物・部屋・契約の4つがある。見出しは日本語で、例の行がつく", () => {
    expect(KINDS).toEqual(["clients", "buildings", "rooms", "contracts"]);
    for (const k of KINDS) {
      const m = templateMatrix(k);
      expect(m[0]).toEqual(columnsOf(k).map((c) => c.label));
      expect(m.length).toBeGreaterThanOrEqual(2);
      expect(kindLabel(k)).toMatch(/取引先|建物|部屋|契約/);
    }
  });
  it("R-014-1 CSV のひな形は、Excel で開ける UTF-8（BOM つき）で、そのまま読み戻せる", () => {
    for (const k of KINDS) {
      const text = templateCsv(k);
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(parseCsv(decodeCsvBytes(bytes(text)))).toEqual(templateMatrix(k));
    }
  });
  it("R-014-1 Excel のひな形も、そのまま読み戻せる（シート名は種類の名前）", async () => {
    for (const k of KINDS) {
      const r = await readXlsx(templateXlsx(k), k);
      expect(r.sheet).toBe(kindLabel(k));
      expect(r.matrix).toEqual(templateMatrix(k));
    }
  });
  it("R-014-1 ひな形の例の行は、順に取り込むと、誤りも重なりもなく取り込める（取引先→建物→部屋→契約）", () => {
    const existing = emptyExisting();
    let id = 0;
    for (const k of KINDS) {
      const p = plan(k, templateMatrix(k), existing);
      expect(p.errors, `${k} のエラー`).toEqual([]);
      expect(p.duplicates, `${k} の重なり`).toEqual([]);
      expect(p.payload.length).toBeGreaterThan(0);
      // 取り込んだものを「登録済み」にして、次の種類へ
      for (const row of p.payload as Array<Record<string, string>>) {
        if (k === "clients") existing.clients.push({ id: `c${++id}`, name: row.name });
        if (k === "buildings") {
          const c = existing.clients.find((x) => importKey(x.name) === importKey(row.client_name))!;
          existing.buildings.push({ id: `b${++id}`, client_id: c.id, name: row.name });
        }
        if (k === "rooms") {
          const c = existing.clients.find((x) => importKey(x.name) === importKey(row.client_name))!;
          const b = existing.buildings.find((x) => x.client_id === c.id && importKey(x.name) === importKey(row.building_name))!;
          existing.rooms.push({ building_id: b.id, room_no: row.room_no });
        }
      }
    }
  });
});

const CLIENTS = [["名前", "種類", "住所", "電話", "メール", "締め日", "支払い条件"]];
describe("取引先の検査（R-014-5）", () => {
  it("R-014-5 正しい行は取り込める。種類の空は管理会社、「オーナー」「owner」も読む。締め日は 31 が月末（「月末」も可）", () => {
    const p = plan("clients", [
      ...CLIENTS,
      ["甲商事", "オーナー", "東京都", "03-1111-2222", "a@example.com", "25", "末締め"],
      ["乙管理", "", "", "", "", "月末", ""],
      ["丙", "owner", "", "", "", "31日", ""],
    ]);
    expect(p.errors).toEqual([]);
    expect(p.payload).toEqual([
      { row: 2, kind: "owner", name: "甲商事", address: "東京都", phone: "03-1111-2222", email: "a@example.com", closing_day: "25", payment_terms: "末締め" },
      { row: 3, kind: "management_company", name: "乙管理", address: "", phone: "", email: "", closing_day: "31", payment_terms: "" },
      { row: 4, kind: "owner", name: "丙", address: "", phone: "", email: "", closing_day: "31", payment_terms: "" },
    ]);
  });
  it("R-014-5 名前なし・種類が変・メールの形・締め日が範囲外は、行番号・項目・理由を出して取り込まない", () => {
    const p = plan("clients", [
      ...CLIENTS,
      ["", "", "", "", "", "", ""],
      ["", "管理会社", "東京", "", "", "", ""],
      ["甲", "テナント", "", "", "", "", ""],
      ["乙", "", "", "", "メール", "", ""],
      ["丙", "", "", "", "", "32", ""],
      ["丁", "", "", "", "", "ついたち", ""],
      ["戊", "", "", "", "", "", ""],
    ]);
    expect(p.errors.map((e) => [e.row, e.column])).toEqual([[3, "名前"], [4, "種類"], [5, "メール"], [6, "締め日"], [7, "締め日"]]);
    expect(p.errors.every((e) => e.message.length > 0)).toBe(true);
    expect(p.payload.map((r) => (r as { name: string }).name)).toEqual(["戊"]);
    expect(p.counts).toEqual({ total: 6, importable: 1, duplicate: 0, error: 5 });
  });
  it("R-014-9 ファイルの中の2回目以降・登録済みと同じ名前は重なりとして、エラーとは別に数える（取り込まない）", () => {
    const ex = emptyExisting();
    ex.clients.push({ id: "c1", name: "テスト管理会社Ａ" });
    const p = plan("clients", [...CLIENTS, ["ﾃｽﾄ管理会社A", "", "", "", "", "", ""], ["新規 商会", "", "", "", "", "", ""], ["新規　商会", "", "", "", "", "", ""], ["別の会社", "", "", "", "", "", ""]], ex);
    expect(p.duplicates.map((d) => d.row)).toEqual([2, 4]);
    expect(p.errors).toEqual([]);
    expect(p.payload.map((r) => (r as { name: string }).name)).toEqual(["新規 商会", "別の会社"]);
    expect(p.counts).toEqual({ total: 4, importable: 2, duplicate: 2, error: 0 });
    expect(p.excluded.map((e) => [e.row, e.status])).toEqual([[2, "duplicate"], [4, "duplicate"]]);
  });
  it("R-014-9 エラーの行は、あとの行の重なりの元にならない", () => {
    const p = plan("clients", [...CLIENTS, ["甲", "ふつう", "", "", "", "", ""], ["甲", "", "", "", "", "", ""]]);
    expect(p.errors.map((e) => e.row)).toEqual([2]);
    expect(p.duplicates).toEqual([]);
    expect(p.counts.importable).toBe(1);
  });
});

const BUILDINGS = [["取引先名", "建物名", "住所", "所有者名"]];
const baseExisting = (): Existing => {
  const e = emptyExisting();
  e.clients.push({ id: "c1", name: "青空管理" }, { id: "c2", name: "山田オーナー" }, { id: "c3", name: "同名" }, { id: "c4", name: "同名" }, { id: "c5", name: "二棟管理" });
  e.buildings.push({ id: "b1", client_id: "c1", name: "ひまわりビル" }, { id: "b2", client_id: "c5", name: "A棟" }, { id: "b3", client_id: "c5", name: "A棟" });
  e.rooms.push({ building_id: "b1", room_no: "101" });
  return e;
};
describe("建物の検査（R-014-6）", () => {
  it("R-014-6 取引先名が登録済みで1つに決まる行・所有者名が登録済みの行は取り込める", () => {
    const p = plan("buildings", [...BUILDINGS, ["青空管理", "さくらハイツ", "東京都1", "山田オーナー"], ["　青空管理 ", "ことぶきビル", "東京都2", ""]], baseExisting());
    expect(p.errors).toEqual([]);
    expect(p.payload).toEqual([
      { row: 2, client_name: "青空管理", name: "さくらハイツ", address: "東京都1", owner_name: "山田オーナー" },
      { row: 3, client_name: "青空管理", name: "ことぶきビル", address: "東京都2", owner_name: "" },
    ]);
  });
  it("R-014-6 取引先が登録されていない・決まらない・所有者が登録されていない・必須の欠けは、項目つきのエラー", () => {
    const p = plan(
      "buildings",
      [...BUILDINGS, ["", "x", "y", ""], ["存在しない", "x", "y", ""], ["同名", "x", "y", ""], ["青空管理", "", "y", ""], ["青空管理", "x", "", ""], ["青空管理", "x", "y", "知らない人"]],
      baseExisting(),
    );
    expect(p.errors.map((e) => [e.row, e.column])).toEqual([[2, "取引先名"], [3, "取引先名"], [4, "取引先名"], [5, "建物名"], [6, "住所"], [7, "所有者名"]]);
    expect(p.errors[1].message).toContain("登録されていません");
    expect(p.errors[2].message).toContain("決まりません");
    expect(p.payload).toEqual([]);
  });
  it("R-014-9 建物の重なりは、同じ取引先の中の同じ名前（既存・ファイルの中の2回目）。別の取引先なら別のもの", () => {
    const p = plan(
      "buildings",
      [...BUILDINGS, ["青空管理", "ひまわりビル", "重なり", ""], ["山田オーナー", "ひまわりビル", "別の取引先なので入る", ""], ["青空管理", "新ビル", "a", ""], ["青空管理", "新ビル", "b", ""]],
      baseExisting(),
    );
    expect(p.duplicates.map((d) => d.row)).toEqual([2, 5]);
    expect(p.payload.map((r) => (r as { row: number }).row)).toEqual([3, 4]);
  });
});

const ROOMS = [["取引先名", "建物名", "部屋番号", "階"]];
describe("部屋の検査（R-014-7）", () => {
  it("R-014-7 取引先・建物が登録済みで1つに決まる行は取り込める。階は整数（1階・1F も可）", () => {
    const p = plan("rooms", [...ROOMS, ["青空管理", "ひまわりビル", "102", "1"], ["青空管理", "ひまわりビル", "２０１", "2階"], ["青空管理", "ひまわりビル", "301", "3F"], ["青空管理", "ひまわりビル", "B1", ""]], baseExisting());
    expect(p.errors).toEqual([]);
    expect(p.payload.map((r) => (r as { floor: string }).floor)).toEqual(["1", "2", "3", ""]);
  });
  it("R-014-7 建物がない・決まらない・部屋番号なし・階が整数でないは、項目つきのエラー", () => {
    const p = plan(
      "rooms",
      [...ROOMS, ["青空管理", "ない建物", "1", ""], ["二棟管理", "A棟", "1", ""], ["青空管理", "ひまわりビル", "", ""], ["青空管理", "ひまわりビル", "9", "上"], ["ない会社", "ひまわりビル", "9", ""]],
      baseExisting(),
    );
    expect(p.errors.map((e) => [e.row, e.column])).toEqual([[2, "建物名"], [3, "建物名"], [4, "部屋番号"], [5, "階"], [6, "取引先名"]]);
  });
  it("R-014-9 部屋の重なりは、同じ建物の同じ部屋番号（全角半角の違いを無視）", () => {
    const p = plan("rooms", [...ROOMS, ["青空管理", "ひまわりビル", "１０１", "1"], ["青空管理", "ひまわりビル", "102", "1"], ["青空管理", "ひまわりビル", "102", "1"]], baseExisting());
    expect(p.duplicates.map((d) => d.row)).toEqual([2, 4]);
    expect(p.payload.length).toBe(1);
  });
});

const CONTRACTS = [["取引先名", "建物名", "契約の種類", "開始日", "終了日", "清掃の名前", "清掃の種類", "金額", "請求", "頻度", "開始時刻", "終了時刻"]];
describe("契約の検査（R-014-8）", () => {
  it("R-014-8 取引先・建物・種類・開始日・終了日が同じ行は、1つの契約の中身としてまとめる。言葉は DB の値にする", () => {
    const p = plan(
      "contracts",
      [
        ...CONTRACTS,
        ["青空管理", "ひまわりビル", "定期", "2026/12/1", "", "定期清掃", "基本", "30,000", "", "毎週月曜", "9:00", "12:00"],
        ["青空管理", "ひまわりビル", "定期", "2026-12-01", "", "窓清掃", "オプション", "¥12000", "行った回ごと", "3か月に1回", "", ""],
        ["青空管理", "ひまわりビル", "単発", "2027-01-10", "2027-01-10", "特別清掃", "特別清掃", "50000", "", "", "", ""],
      ],
      baseExisting(),
    );
    expect(p.errors).toEqual([]);
    expect(p.payload).toEqual([
      {
        row: 2, lines: [2, 3], client_name: "青空管理", building_name: "ひまわりビル", kind: "recurring", start_date: "2026-12-01", end_date: "",
        services: [
          { service_kind: "base", name: "定期清掃", amount: 30000, billing: "monthly", recurrence: "FREQ=WEEKLY;BYDAY=MO", start_time: "09:00", end_time: "12:00" },
          { service_kind: "option", name: "窓清掃", amount: 12000, billing: "per_visit", recurrence: "FREQ=MONTHLY;INTERVAL=3", start_time: "", end_time: "" },
        ],
      },
      {
        row: 4, lines: [4], client_name: "青空管理", building_name: "ひまわりビル", kind: "one_time", start_date: "2027-01-10", end_date: "2027-01-10",
        services: [{ service_kind: "special", name: "特別清掃", amount: 50000, billing: "per_visit", recurrence: "FREQ=DAILY;COUNT=1", start_time: "", end_time: "" }],
      },
    ]);
    expect(p.counts).toEqual({ total: 3, importable: 2, duplicate: 0, error: 0 });
  });
  it("R-014-8 項目ごとのエラー：取引先・建物・種類・開始日・終了日・名前・清掃の種類・金額・請求・頻度・時刻", () => {
    const row = (over: Partial<Record<number, string>>) => {
      const base = ["青空管理", "ひまわりビル", "定期", "2026-12-01", "", "定期清掃", "基本", "1000", "", "", "", ""];
      for (const [i, v] of Object.entries(over)) base[Number(i)] = v as string;
      return base;
    };
    const p = plan(
      "contracts",
      [
        ...CONTRACTS,
        row({ 0: "ない会社" }), // 2
        row({ 1: "ない建物", 3: "2026-12-02" }), // 3
        row({ 2: "ときどき", 3: "2026-12-03" }), // 4
        row({ 3: "" }), // 5
        row({ 3: "2026-12-04", 4: "2026-12-01" }), // 6
        row({ 3: "2026-12-05", 5: "" }), // 7
        row({ 3: "2026-12-06", 6: "ふつう" }), // 8
        row({ 3: "2026-12-07", 7: "-5" }), // 9
        row({ 3: "2026-12-08", 7: "1.5" }), // 10
        row({ 3: "2026-12-09", 8: "年ごと" }), // 11
        row({ 3: "2026-12-10", 9: "ときどき" }), // 12
        row({ 3: "2026-12-11", 10: "12:00", 11: "9:00" }), // 13
        row({ 3: "2026-12-12", 10: "あ" }), // 14
      ],
      baseExisting(),
    );
    expect(p.errors.map((e) => [e.row, e.column])).toEqual([
      [2, "取引先名"], [3, "建物名"], [4, "契約の種類"], [5, "開始日"], [6, "終了日"], [7, "清掃の名前"], [8, "清掃の種類"], [9, "金額"], [10, "金額"],
      [11, "請求"], [12, "頻度"], [13, "終了時刻"], [14, "開始時刻"],
    ]);
    expect(p.payload).toEqual([]);
  });
  it("R-014-8 まとめた中の1行でも正しくなければ、その契約は全部取り込まない（正しい行にも理由を出す）", () => {
    const p = plan(
      "contracts",
      [
        ...CONTRACTS,
        ["青空管理", "ひまわりビル", "定期", "2026-12-01", "", "定期清掃", "基本", "30000", "", "", "", ""],
        ["青空管理", "ひまわりビル", "定期", "2026-12-01", "", "窓清掃", "オプション", "たくさん", "", "", "", ""],
        ["青空管理", "ひまわりビル", "定期", "2027-01-01", "", "別の契約", "基本", "100", "", "", "", ""],
      ],
      baseExisting(),
    );
    expect(p.errors.map((e) => [e.row, e.column])).toEqual([[2, "清掃の名前"], [3, "金額"]]);
    expect(p.errors[0].message).toContain("3行目");
    expect(p.payload.map((r) => (r as { row: number }).row)).toEqual([4]);
    expect(p.counts).toEqual({ total: 3, importable: 1, duplicate: 0, error: 2 });
  });
  it("R-014-9 契約の重なり：既存の契約（建物・種類・開始日・清掃の名前の組が同じ）、ファイルの中の2回目", () => {
    const ex = baseExisting();
    ex.contracts.push({ building_id: "b1", kind: "recurring", start_date: "2026-12-01", serviceNames: ["定期清掃", "窓清掃"] });
    const p = plan(
      "contracts",
      [
        ...CONTRACTS,
        ["青空管理", "ひまわりビル", "定期", "2026-12-01", "", "定期清掃", "基本", "1", "", "", "", ""],
        ["青空管理", "ひまわりビル", "定期", "2026-12-01", "", "窓清掃", "オプション", "1", "", "", "", ""],
        ["青空管理", "ひまわりビル", "定期", "2026-12-01", "2027-12-31", "新しい 名前", "基本", "1", "", "", "", ""],
        ["青空管理", "ひまわりビル", "定期", "2026-12-01", "2028-12-31", "新しい　名前", "基本", "1", "", "", "", ""],
      ],
      ex,
    );
    // 2〜3 行目は既存と同じ組（定期清掃・窓清掃）、5 行目は4行目と同じ組
    expect(p.errors).toEqual([]);
    expect(p.duplicates.map((d) => d.row)).toEqual([2, 5]);
    expect(p.payload.map((r) => (r as { row: number }).row)).toEqual([4]);
  });
});
