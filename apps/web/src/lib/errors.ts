// DB・Edge Function・通信のエラーを、画面に出す日本語にする。
// 招待が使えない理由は、探られないよう区別しない（R-001-9）。
export interface DbErrorLike {
  code?: string;
  message?: string;
}

export function describeError(e: unknown): string {
  if (e instanceof TypeError || /failed to fetch|network|load failed/i.test(String((e as Error)?.message ?? ""))) {
    return "通信できません。電波を確かめて、もう一度試してください";
  }
  const { code, message } = (e ?? {}) as DbErrorLike;
  switch (code) {
    case "42501":
      return "この操作をする権限がありません";
    case "P0001":
      return "この招待は使えません。期限切れ・使用済み・取り消し・別のメールアドレスのいずれかです";
    case "P0002":
      return "有効な管理者が1人だけなので、止めたり管理者以外にしたりできません";
    case "28000":
      return "ログインが必要です。メールのリンクで入り直してください";
    case "23505":
      return "すでに登録されています";
    case "22023":
      return message || "入力が正しくありません";
    default:
      return message || "うまくいきませんでした";
  }
}
