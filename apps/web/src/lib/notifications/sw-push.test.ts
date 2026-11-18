// 通知の受け取り（public/sw-push.js）。偽の self で動かして確かめる（R-015-28）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Handler = (event: unknown) => void;

function load() {
  const handlers: Record<string, Handler> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const focused: string[] = [];
  let windows: { focus(): Promise<{ navigate?: (u: string) => Promise<unknown> }> }[] = [];
  const self = {
    addEventListener: (name: string, fn: Handler) => void (handlers[name] = fn),
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: {
      matchAll: async () => windows,
      openWindow: async (u: string) => void opened.push(u),
    },
  };
  const code = readFileSync(join(process.cwd(), "public", "sw-push.js"), "utf8");
  new Function("self", code)(self);
  return {
    handlers,
    shown,
    opened,
    navigated,
    focused,
    setWindows(n: number) {
      windows = Array.from({ length: n }, () => ({
        focus: async () => {
          focused.push("focus");
          return { navigate: async (u: string) => void navigated.push(u) };
        },
      }));
    },
  };
}

async function push(sw: ReturnType<typeof load>, data: unknown, raw?: string) {
  let waited: Promise<unknown> = Promise.resolve();
  sw.handlers.push({
    data: raw !== undefined || data !== undefined ? { json: () => (raw !== undefined ? JSON.parse(raw) : data) } : null,
    waitUntil: (p: Promise<unknown>) => void (waited = p),
  });
  await waited;
}

async function click(sw: ReturnType<typeof load>, data: unknown) {
  let waited: Promise<unknown> = Promise.resolve();
  let closed = false;
  sw.handlers.notificationclick({
    notification: { data, close: () => void (closed = true) },
    waitUntil: (p: Promise<unknown>) => void (waited = p),
  });
  await waited;
  return closed;
}

describe("通知の受け取り（サービスワーカー）", () => {
  it("R-015-28 通知を受け取ったとき、題名と本文を表示する", async () => {
    const sw = load();
    await push(sw, { id: "n1", title: "明日の作業", body: "10:00 に A ビル", link: "/works/1" });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe("明日の作業");
    expect(sw.shown[0].options).toMatchObject({ body: "10:00 に A ビル", tag: "n1", data: { link: "/works/1" } });
  });

  it("R-015-28 題名がなければ「お知らせ」。壊れた中身でも落ちない", async () => {
    const sw = load();
    await push(sw, {});
    expect(sw.shown[0].title).toBe("お知らせ");
    await push(sw, undefined, "not json{");
    expect(sw.shown[1].title).toBe("お知らせ");
    sw.handlers.push({ data: null, waitUntil: () => {} });
    expect(sw.shown.map((x) => x.title)).toEqual(["お知らせ", "お知らせ", "お知らせ"]); // 中身が空でも表示する
  });

  it("R-015-28 アプリの外のリンクは受けず、お知らせの一覧を開く", async () => {
    const sw = load();
    for (const link of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/\\evil", 5, null]) {
      await push(sw, { title: "t", link });
    }
    expect(sw.shown.map((s) => (s.options.data as { link: string }).link)).toEqual(Array(6).fill("/notifications/"));
  });

  it("R-015-28 押されたとき、開いている画面があればそのリンクの先へ、なければ新しく開く", async () => {
    const sw = load();
    sw.setWindows(0);
    expect(await click(sw, { link: "/works/1" })).toBe(true); // 通知は閉じる
    expect(sw.opened).toEqual(["/works/1"]);
    sw.setWindows(1);
    await click(sw, { link: "/requests/2" });
    expect(sw.focused).toEqual(["focus"]);
    expect(sw.navigated).toEqual(["/requests/2"]);
  });

  it("R-015-28 押されたときも、アプリの外のリンクは開かない", async () => {
    const sw = load();
    sw.setWindows(0);
    await click(sw, { link: "https://evil.example/" });
    await click(sw, undefined);
    expect(sw.opened).toEqual(["/notifications/", "/notifications/"]);
  });
});
