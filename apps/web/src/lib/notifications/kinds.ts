// 受け取る種類の設定の合成（機能 015）。DB の種類の一覧・本人の設定・本人の権限から、画面に出す行を作る。
// 画面での出し分けは見せ方のためだけ。権限の判定は DB（共通の関数）が行う。

export interface Kind {
  code: string;
  name: string;
  default_push: boolean;
  default_email: boolean;
  required_perm: string | null;
  sort: number;
}

export type Channel = "push" | "email";

export interface Setting {
  kind: string;
  channel: Channel;
  enabled: boolean;
}

export interface SettingRow {
  code: string;
  name: string;
  push: boolean;
  email: boolean;
  /** 本人が選んでいない（初めの値のまま）か */
  pushIsDefault: boolean;
  emailIsDefault: boolean;
}

/** 種類ごとに、今の値（選んでいなければ初めの値）を出す。自分の権限で受け取れない種類は出さない（R-015-2・27） */
export function buildSettingRows(kinds: Kind[], settings: Setting[], perms: Iterable<string>): SettingRow[] {
  const have = new Set(perms);
  const chosen = new Map(settings.map((s) => [`${s.kind}/${s.channel}`, s.enabled]));
  return [...kinds]
    .filter((k) => !k.required_perm || have.has(k.required_perm))
    .sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code))
    .map((k) => {
      const p = chosen.get(`${k.code}/push`);
      const e = chosen.get(`${k.code}/email`);
      return {
        code: k.code,
        name: k.name,
        push: p ?? k.default_push,
        email: e ?? k.default_email,
        pushIsDefault: p === undefined,
        emailIsDefault: e === undefined,
      };
    });
}
