// 出入りの入力の確かめ・残高の見せ方・操作の出し分け（R-006-34〜36）
import { describe, expect, it } from "vitest";
import { screenActions, summarizeAccount, validateEntryInput } from "./entry";

const base = { accountId: "acc-1", date: "2026-11-10", amount: "1,980", purpose: "洗剤", direction: "out" as const };

describe("validateEntryInput", () => {
  it("R-006-34 正しい入力は通り、金額は整数に直る（全角・カンマ・円もよい）", () => {
    expect(validateEntryInput(base)).toEqual({
      ok: true,
      value: { accountId: "acc-1", date: "2026-11-10", amount: 1980, purpose: "洗剤", direction: "out" },
    });
    expect(validateEntryInput({ ...base, amount: "１２００円" })).toMatchObject({ ok: true, value: { amount: 1200 } });
  });

  it("R-006-34 金額が1円以上の整数でなければ断る", () => {
    for (const amount of ["", "0", "-5", "12.5", "abc", "1e3"]) {
      const r = validateEntryInput({ ...base, amount });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.amount).toBeTruthy();
    }
  });

  it("R-006-34 用途が空（空白だけ）なら断る", () => {
    const r = validateEntryInput({ ...base, purpose: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.purpose).toBeTruthy();
  });

  it("R-006-34 日付がない・ありえない日付なら断る", () => {
    for (const date of ["", "2026-13-01", "2026-02-30", "11/10"]) {
      const r = validateEntryInput({ ...base, date });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.date).toBeTruthy();
    }
  });

  it("R-006-34 小口が選ばれていなければ断る", () => {
    const r = validateEntryInput({ ...base, accountId: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.accountId).toBeTruthy();
  });

  it("R-006-34 持ち手の画面は出金だけ。入金は、渡す人（cash.manage）の画面だけ", () => {
    expect(validateEntryInput({ ...base, direction: "in" }, { allowIn: false }).ok).toBe(false);
    expect(validateEntryInput({ ...base, direction: "in" }, { allowIn: true }).ok).toBe(true);
  });
});

describe("summarizeAccount：持ち手の画面の残高", () => {
  it("R-006-35 残高・確認済みの残高・下書きの数・送れていない件数を出す", () => {
    expect(summarizeAccount({ balance: 9500, confirmed_balance: 10000, draft_count: 1 }, 2)).toEqual({
      balanceText: "¥9,500",
      confirmedText: "¥10,000",
      draftCount: 1,
      pendingText: "送れていない記録が 2 件あります",
      warning: null,
    });
  });

  it("R-006-35 残高がマイナスのときは、止めずに注意を出す", () => {
    expect(summarizeAccount({ balance: -300, confirmed_balance: 0, draft_count: 1 }, 0).warning).toMatch(/マイナス/);
  });

  it("R-006-35 送れていない記録がなければ、件数の文を出さない", () => {
    expect(summarizeAccount({ balance: 0, confirmed_balance: 0, draft_count: 0 }, 0).pendingText).toBeNull();
  });
});

describe("screenActions：管理の操作の出し分け", () => {
  it("R-006-36 cash.manage を持つ人には、確認・締め・入金の登録・CSV を出す", () => {
    expect(screenActions(["cash.manage", "field.record"])).toEqual({ confirm: true, closeMonth: true, grant: true, exportCsv: true, manage: true });
  });

  it("R-006-36 cash.manage を持たない人には、その操作を出さない（出さなくても DB が断る）", () => {
    const none = { confirm: false, closeMonth: false, grant: false, exportCsv: false, manage: false };
    expect(screenActions(["field.record"])).toEqual(none);
    expect(screenActions([])).toEqual(none);
  });
});
