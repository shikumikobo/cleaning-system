"use client";

// 案内板：ビルの館内案内のように、仕事の場所ごとに分けたメニュー。ホームと、ヘッダーのメニューで使う。
import Link from "next/link";

interface Entry {
  href: string;
  label: string;
  /** 案内板の札に書く1文字（読み上げには使わない） */
  mark: string;
}

const GROUPS: Array<{ title: string; entries: Entry[] }> = [
  {
    title: "現場",
    entries: [
      { href: "/schedule/", label: "予定と実績", mark: "予" },
      { href: "/map/", label: "地図", mark: "地" },
      { href: "/photos/", label: "現場の写真", mark: "写" },
      { href: "/reports/", label: "清掃報告書", mark: "報" },
      { href: "/cash/", label: "小口現金・レシート", mark: "金" },
    ],
  },
  {
    title: "営業と請求",
    entries: [
      { href: "/requests/", label: "案件", mark: "案" },
      { href: "/quotes/", label: "見積", mark: "見" },
      { href: "/contracts/", label: "契約・予定", mark: "契" },
      { href: "/invoices/", label: "請求", mark: "請" },
      { href: "/profit/", label: "売上と粗利", mark: "益" },
    ],
  },
  {
    title: "登録",
    entries: [
      { href: "/clients/", label: "取引先", mark: "取" },
      { href: "/buildings/", label: "建物", mark: "建" },
      { href: "/import/", label: "データの取り込み", mark: "込" },
      { href: "/files/", label: "ファイル", mark: "書" },
    ],
  },
  {
    title: "お知らせ",
    entries: [
      { href: "/notifications/", label: "お知らせ", mark: "知" },
      { href: "/settings/notifications/", label: "お知らせの受け取り", mark: "設" },
    ],
  },
];

const ADMIN: Entry[] = [
  { href: "/settings/users/", label: "利用者の管理（招待・役割・止める）", mark: "人" },
  { href: "/settings/tenant/", label: "会社の情報と、運営の閲覧の許可", mark: "社" },
];

export function NavBoard({ admin }: { admin: boolean }) {
  const groups = admin ? [...GROUPS, { title: "管理", entries: ADMIN }] : GROUPS;
  return (
    <div className="board">
      {groups.map((g) => (
        <section key={g.title} className="board-group">
          <h2 className="board-title">{g.title}</h2>
          <ul className="board-list">
            {g.entries.map((e) => (
              <li key={e.href}>
                <Link href={e.href} className="board-link">
                  <span className="board-mark" aria-hidden="true">
                    {e.mark}
                  </span>
                  {e.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
