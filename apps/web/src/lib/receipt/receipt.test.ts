// レシートの読み取り：中身の解析と、差し替えられる読み取り（R-006-24〜26）
import { describe, expect, it } from "vitest";
import {
  manualReader,
  parseReceiptText,
  runReader,
  textReader,
  type ReceiptReader,
} from "../../../../../supabase/functions/_shared/receipt";

const bytes = new Uint8Array([1, 2, 3]);

describe("parseReceiptText：文字から金額と日付を取る", () => {
  it("R-006-24 合計の金額と日付を取る", () => {
    expect(parseReceiptText("ホームセンター\n2026/11/10 14:20\n洗剤 ¥680\n合計 ¥1,980\n")).toEqual({ amount: 1980, date: "2026-11-10" });
  });

  it("R-006-24 全角の数字・「円」・「年月日」も読める", () => {
    expect(parseReceiptText("２０２６年１１月３日\n合計　１，２３４円")).toEqual({ amount: 1234, date: "2026-11-03" });
  });

  it("R-006-24 合計を、小計・お預り・お釣りより優先する", () => {
    expect(parseReceiptText("小計 1,000\n消費税 100\n合計 1,100\nお預り 2,000\nお釣り 900")).toMatchObject({ amount: 1100 });
  });

  it("R-006-24 「合計」がないときは、いちばん大きい円の金額を候補にする", () => {
    expect(parseReceiptText("ゴミ袋 ¥300\n電池 ¥1,280\n")).toMatchObject({ amount: 1280 });
  });

  it("R-006-24 金額が取れないときは null", () => {
    expect(parseReceiptText("ありがとうございました")).toEqual({ amount: null, date: null });
  });

  it("R-006-24 ありえない日付は取らない", () => {
    expect(parseReceiptText("2026/13/40\n合計 500円")).toEqual({ amount: 500, date: null });
  });

  it("R-006-24 ハイフンの日付も読める", () => {
    expect(parseReceiptText("2026-1-5 合計 ¥90")).toEqual({ amount: 90, date: "2026-01-05" });
  });
});

describe("runReader：読み取りの中身を差し替えられる", () => {
  it("R-006-26 初めの読み取り（読み取らない）は、「読み取れず」を返し、手で入れる画面に進める", async () => {
    expect(await runReader(manualReader, bytes, "image/jpeg")).toEqual({ status: "failed", amount: null, date: null, reader: "manual" });
  });

  it("R-006-26 別の読み取り（文字を返す OCR など）に、同じ形で差し替えられる", async () => {
    const fake: ReceiptReader = textReader("fake-ocr", async () => "2026/11/10\n合計 ¥2,500");
    expect(await runReader(fake, bytes, "image/png")).toEqual({ status: "read", amount: 2500, date: "2026-11-10", reader: "fake-ocr" });
  });

  it("R-006-26 読み取りが例外を出しても、画面は手で入れる形に進める（失敗にして返す）", async () => {
    const broken: ReceiptReader = {
      name: "broken",
      read: async () => {
        throw new Error("boom");
      },
    };
    expect(await runReader(broken, bytes, "image/jpeg")).toMatchObject({ status: "failed", amount: null, reader: "broken" });
  });

  it("R-006-24 金額が読めたときは「読み取り済み」、日付だけなら「読み取れず」", async () => {
    const dateOnly = textReader("d", async () => "2026/11/10 ありがとう");
    expect(await runReader(dateOnly, bytes, "image/jpeg")).toMatchObject({ status: "failed", date: "2026-11-10", amount: null });
  });

  it("R-006-25 読み取りは金額と日付の候補を返すだけで、出入りを書く部品を持たない", () => {
    // 出入りに入れるのは、画面で持ち手が確かめた値だけ
    expect(Object.keys(manualReader).sort()).toEqual(["name", "read"]);
  });
});
