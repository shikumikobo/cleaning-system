"use client";

// 建物ごとのファイル（社内）：一覧・上げる・共有のオンとオフ・開く・消す（R-005-30〜36）。
// 建物は ?building= で渡す（静的な書き出しに合わせ、動的なルートは使わない）。判定は DB。ここは見せ方だけ。
import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { Loading, Notice, useMasters, type MastersCtx } from "@/components/masters/Shell";
import "@/components/masters/masters.css";
import { useSession } from "@/components/useSession";
import { describeError } from "@/lib/errors";
import { canEditFiles, formatKind, formatSize, sortFiles } from "@/lib/files/format";
import { homeFor } from "@/lib/files/portal";
import { deleteFile, listFiles, openFile, setShared, uploadFile } from "@/lib/files/repo";
import type { FileRowData } from "@/lib/files/types";
import { listBuildings } from "@/lib/masters/repo";
import type { Building } from "@/lib/masters/types";

function jp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function FilesBody({ ctx, canEdit }: { ctx: MastersCtx; canEdit: boolean }) {
  const router = useRouter();
  const buildingId = useSearchParams().get("building") ?? "";
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [files, setFiles] = useState<FileRowData[]>([]);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void listBuildings(ctx.sb, ctx.tenantId)
      .then((b) => !cancelled && setBuildings(b))
      .catch((e) => !cancelled && setMsg(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const reload = useCallback(async () => {
    if (!buildingId) return setFiles([]);
    try {
      setFiles(sortFiles(await listFiles(ctx.sb, ctx.tenantId, buildingId)));
    } catch (e) {
      setMsg(describeError(e));
    }
  }, [ctx, buildingId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setMsg(null);
    setOk(null);
    try {
      await fn();
      if (done) setOk(done);
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function onUpload() {
    if (!picked) return setMsg("ファイルを選んでください");
    const file = picked;
    await run(async () => {
      await uploadFile(ctx.sb, ctx.tenantId, buildingId, file, name || file.name);
      setPicked(null);
      setName("");
      if (input.current) input.current.value = "";
      await reload();
    }, "上げました");
  }

  return (
    <>
      <div className="m-field">
        <label htmlFor="files-building">建物</label>
        <select id="files-building" value={buildingId} onChange={(e) => router.replace(e.target.value ? `/files/?building=${e.target.value}` : "/files/")}>
          <option value="">建物を選んでください</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />

      {buildingId && canEdit ? (
        <div className="m-form two" aria-label="ファイルを上げる">
          <div className="m-field">
            <label htmlFor="files-pick">ファイル</label>
            <input
              id="files-pick"
              ref={input}
              type="file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setPicked(f);
                if (f && !name) setName(f.name);
              }}
            />
          </div>
          <div className="m-field">
            <label htmlFor="files-name">名前</label>
            <input id="files-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="画面に出す名前" />
          </div>
          <div className="m-row wide">
            <button type="button" className="m-btn" disabled={busy || !picked} onClick={() => void onUpload()}>
              上げる
            </button>
          </div>
        </div>
      ) : null}

      {buildingId ? (
        <section aria-label="ファイルの一覧">
          {files.length === 0 ? <p>この建物のファイルはありません。</p> : null}
          {files.map((f) => (
            <div key={f.id} className="m-card" data-testid="file-row">
              <button type="button" className="link" onClick={() => void run(() => openFile(ctx.sb, f.id))} style={{ font: "inherit", fontWeight: "bold", textAlign: "left" }}>
                {f.name}
              </button>
              <span className="m-sub">
                {formatKind(f.mime, f.name)}・{formatSize(f.size)}・{jp(f.created_at)}
              </span>
              <span className="m-row" style={{ marginTop: 6 }}>
                <span className={`m-badge${f.shared_external ? "" : " off"}`}>{f.shared_external ? "外部に共有中" : "社内のみ"}</span>
                {canEdit ? (
                  <>
                    <button
                      type="button"
                      className="m-btn sub"
                      disabled={busy}
                      onClick={() => void run(async () => { await setShared(ctx.sb, f.id, !f.shared_external); await reload(); })}
                    >
                      {f.shared_external ? "共有をやめる" : "外部に共有する"}
                    </button>
                    <button
                      type="button"
                      className="m-btn danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`「${f.name}」を消しますか？`)) void run(async () => { await deleteFile(ctx.sb, f.id); await reload(); }, "消しました");
                      }}
                    >
                      消す
                    </button>
                  </>
                ) : null}
              </span>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}

function Gate() {
  const { ctx, error } = useMasters();
  const state = useSession({ redirect: true });
  const auth = useAuth();
  const router = useRouter();
  const role = auth.current?.roleCode;
  const home = homeFor(role);
  useEffect(() => {
    if (home) router.replace(home); // 外部の人は専用ページへ
  }, [home, router]);
  if (home) return <p>専用ページに移ります…</p>;
  const canEdit = state.status === "ready" && canEditFiles(state.session.perms);
  return (
    <section>
      <p>
        <Link href="/">← ホーム</Link>
      </p>
      <h1>ファイル</h1>
      <Loading error={error} ctx={ctx} />
      {ctx ? <FilesBody ctx={ctx} canEdit={canEdit} /> : null}
    </section>
  );
}

export default function FilesPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Gate />
    </Suspense>
  );
}
