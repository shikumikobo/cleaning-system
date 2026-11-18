import { describe, expect, it } from "vitest";
import { describeError } from "./errors";

describe("エラーの文言", () => {
  it("R-001-9 期限切れ・使用済み・取り消し・別のメールは、同じ文言で断る", () => {
    const a = describeError({ code: "P0001", message: "招待が使えない" });
    expect(a).toContain("この招待は使えません");
    expect(a).toContain("期限切れ");
  });
  it("R-001-16 最後の管理者を変えられないことを伝える", () => {
    expect(describeError({ code: "P0002", message: "x" })).toContain("管理者が1人だけ");
  });
  it("R-001-12 権限のない操作は、権限がないと伝える（RPC が断った場合）", () => {
    expect(describeError({ code: "42501", message: "権限がない" })).toContain("権限がありません");
  });
  it("R-001-23 通信の失敗は、電波を確かめるよう伝える", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toContain("通信できません");
  });
  it("R-001-5 DB が返した日本語の理由は、そのまま出す", () => {
    expect(describeError({ code: "22023", message: "役割がない：x" })).toBe("役割がない：x");
  });
});
