// 会計ソフトに渡す CSV（R-006-30〜32）
import { describe, expect, it } from "vitest";
import { buildCashCsv, csvCell, type CsvEntry } from "./csv";

const row = (over: Partial<CsvEntry> = {}): CsvEntry => ({
  entry_date: "2026-11-10",
  account_name: "スタッフA の小口",
  holder_name: "山田",
  direction: "out",
  amount: 1980,
  purpose: "洗剤",
  has_receipt: true,
  status: "confirmed",
  confirmed_at: "2026-11-11T01:00:00Z",
  building_id: null,
  ...over,
});

const noBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const HEADER = "日付,小口,持ち手,区分,金額,用途,レシート,状況,確認日,建物ID";

describe("buildCashCsv", () => {
  it("R-006-30 確認済み・締め済みの出入りだけを出し、下書きは含めない", () => {
    const csv = buildCashCsv([row(), row({ purpose: "下書き", status: "draft", confirmed_at: null }), row({ purpose: "締め済み", status: "closed" })]);
    const lines = noBom(csv).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3); // 見出し＋2件
    expect(csv).not.toContain("下書き");
    expect(csv).toContain("締め済み");
  });

  it("R-006-31 先頭に BOM、改行は CRLF、見出しは決めた列の順", () => {
    const csv = buildCashCsv([row()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("\r\n");
    expect(noBom(csv).split("\r\n")[0]).toBe(HEADER);
  });

  it("R-006-31 日付は YYYY/MM/DD、金額は円の整数、確認日は日本時間の日付", () => {
    const body = noBom(buildCashCsv([row()])).split("\r\n")[1];
    expect(body).toBe("2026/11/10,スタッフA の小口,山田,出金,1980,洗剤,あり,確認済み,2026/11/11,");
  });

  it("R-006-31 日本時間の日付をまたぐ確認日（UTC の夕方）は、翌日になる", () => {
    const body = buildCashCsv([row({ confirmed_at: "2026-11-10T15:30:00Z" })]).split("\r\n")[1];
    expect(body).toContain(",2026/11/11,");
  });

  it("R-006-31 区分・レシート・状況は日本語で出す", () => {
    const body = buildCashCsv([row({ direction: "in", has_receipt: false, status: "closed" })]).split("\r\n")[1];
    expect(body).toContain(",入金,");
    expect(body).toContain(",なし,締め済み,");
  });

  it("R-006-31 日付の順に並べる", () => {
    const csv = buildCashCsv([row({ entry_date: "2026-11-12", purpose: "B" }), row({ entry_date: "2026-11-02", purpose: "A" })]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toContain("2026/11/02");
    expect(lines[2]).toContain("2026/11/12");
  });

  it("R-006-31 データがなくても、見出しの行は出る", () => {
    expect(noBom(buildCashCsv([]))).toBe(HEADER + "\r\n");
  });
});

describe("csvCell", () => {
  it("R-006-31 カンマ・引用符・改行を含む値は、引用符で囲み、引用符は2つにする", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("1行目\n2行目")).toBe('"1行目\n2行目"');
    expect(csvCell("ふつう")).toBe("ふつう");
    expect(csvCell(null)).toBe("");
  });

  it("R-006-32 =・+・-・@ で始まる値は、先頭に ' を付けて式として動かさない", () => {
    expect(csvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvCell("+81 90")).toBe("'+81 90");
    expect(csvCell("-3個")).toBe("'-3個");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("R-006-32 先頭がタブ・復帰でも、式として動かさない", () => {
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    expect(csvCell("\r=1")).toBe('"\'\r=1"');
  });

  it("R-006-32 用途に式があるとき、CSV 全体でも先頭に ' が付く", () => {
    const body = buildCashCsv([row({ purpose: '=HYPERLINK("x")' })]).split("\r\n")[1];
    expect(body).toContain('"\'=HYPERLINK(""x"")"');
  });

  it("R-006-31 金額（数値）は、そのまま出す（円の整数）", () => {
    expect(csvCell(-100)).toBe("-100");
    expect(csvCell(1980)).toBe("1980");
  });
});
