"use client";

// 外部の人の専用ページ（R-005-26〜29）：許された建物（名前と住所）と、建物ごとの区画（共有されたファイルなど）。
// 区画は lib/files/portal.ts の登録簿から組み立てる。外部の人は何も書き換えない（承認も社員が記録する）。
import Link from "next/link";
import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useAuth } from "@/components/AuthProvider";
import { RequireAuth } from "@/components/ui";
import { describeError } from "@/lib/errors";
import { listPortalBuildings, portalSections, type PortalBuilding, type PortalItem, type PortalSection } from "@/lib/files/portal";
import { openFile } from "@/lib/files/repo";
import { registerWorksPortalSection } from "@/lib/contracts/portal";
import { registerQuotesPortalSection } from "@/lib/quotes/portal";
import { registerReportPortalSections } from "@/lib/reports/portal";
import { signPhotoUrls } from "@/lib/photos/repo";
import "@/components/masters/masters.css";

registerQuotesPortalSection(); // 004：提出・承認の見積の区画（登録簿に足す）
registerWorksPortalSection(); // 010：作業の日と状況の区画
registerReportPortalSections(); // 009：提出した報告書と、その写真の区画

/** 期限つきの URL で、写真（元の画像）を新しいタブで開く（R-009-36） */
async function openPhoto(sb: SupabaseClient, id: string): Promise<void> {
  const r = await signPhotoUrls(sb, [id], "original");
  const url = r.urls[id];
  if (!url) throw new Error("写真を開けませんでした");
  window.open(url, "_blank", "noopener");
}

function SectionView({ sb, section, buildingId, onError }: { sb: SupabaseClient; section: PortalSection; buildingId: string; onError: (m: string) => void }) {
  const [items, setItems] = useState<PortalItem[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void section
      .load(sb, buildingId)
      .then((r) => !cancelled && setItems(r))
      .catch((e) => !cancelled && (setItems([]), onError(describeError(e))));
    return () => {
      cancelled = true;
    };
  }, [sb, section, buildingId, onError]);
  return (
    <div className="m-section" aria-label={section.title}>
      <h3>{section.title}</h3>
      {items === null ? <p>読み込み中…</p> : items.length === 0 ? <p className="m-sub">ありません。</p> : null}
      {(items ?? []).map((it) => (
        <div key={it.key} className="m-item">
          {it.photoId ? (
            <button
              type="button"
              className="link"
              style={{ font: "inherit", textAlign: "left" }}
              onClick={() => void openPhoto(sb, it.photoId as string).catch((e) => onError(describeError(e)))}
            >
              {it.label}
            </button>
          ) : it.fileId ? (
            <button
              type="button"
              className="link"
              style={{ font: "inherit", textAlign: "left" }}
              onClick={() => void openFile(sb, it.fileId as string).catch((e) => onError(describeError(e)))}
            >
              {it.label}
            </button>
          ) : (
            <span>{it.label}</span>
          )}
          {it.detail ? <span className="m-sub">{it.detail}</span> : null}
          {it.children && it.children.length > 0 ? (
            <ul className="m-sub" aria-label={`${it.label}の明細`}>
              {it.children.map((c) => (
                <li key={c.key}>
                  {c.label} {c.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PortalBody() {
  const auth = useAuth();
  const [buildings, setBuildings] = useState<PortalBuilding[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const current = auth.current;
  const sb = auth.client;
  const isExternal = current?.roleCode === "external";

  useEffect(() => {
    if (!sb || !current || !isExternal) return;
    let cancelled = false;
    void listPortalBuildings(sb, current.tenantId)
      .then((b) => !cancelled && setBuildings(b))
      .catch((e) => !cancelled && (setBuildings([]), setMsg(describeError(e))));
    return () => {
      cancelled = true;
    };
  }, [sb, current, isExternal]);

  if (!current || !sb) return null;
  if (!isExternal) {
    return (
      <section>
        <h1>専用ページ</h1>
        <p>この画面は、外部の人（取引先の担当者）用です。社内の人は、ファイルの画面で共有を切り替えます。</p>
        <p>
          <Link href="/files/">ファイル</Link> / <Link href="/">ホーム</Link>
        </p>
      </section>
    );
  }
  const sections = portalSections();
  return (
    <section>
      <h1>{current.tenantName}</h1>
      <p className="m-sub">あなたに見ることが許された建物です。</p>
      {msg ? <p className="m-msg" role="status">{msg}</p> : null}
      {buildings === null ? <p>読み込み中…</p> : null}
      {buildings && buildings.length === 0 ? <p>見られる建物がありません。</p> : null}
      {(buildings ?? []).map((b) => (
        <article key={b.id} className="m-card" aria-label={b.name} style={{ marginTop: 16 }}>
          <strong>{b.name}</strong>
          <span className="m-sub">{b.address}</span>
          {sections.map((s) => (
            <SectionView key={s.id} sb={sb} section={s} buildingId={b.id} onError={setMsg} />
          ))}
        </article>
      ))}
    </section>
  );
}

export default function PortalPage() {
  return (
    <RequireAuth>
      <PortalBody />
    </RequireAuth>
  );
}
