"use client";

// データの取り込み（機能 014）：ひな形 → ファイルを選ぶ → 確かめ（エラー・重なり）→ OK で取り込み → 結果。確かめの間は何も書かない。
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Notice } from "@/components/masters/Shell";
import { sessionMessage, useSession } from "@/components/useSession";
import "@/components/masters/masters.css";
import "@/components/import/import.css";
import { describeError } from "@/lib/errors";
import { HINTS, KINDS, columnsOf, kindLabel, type Kind } from "@/lib/import/columns";
import { decodeCsvBytes, parseCsv } from "@/lib/import/csv";
import { KIND_UNIT, formatJobTime, importFailureMessage, jobStatusLabel, reasonMessage, type ImportResult } from "@/lib/import/format";
import { planImport, type Plan } from "@/lib/import/plan";
import { listImportJobs, loadExisting, runImport, type ImportJob } from "@/lib/import/repo";
import { toTable } from "@/lib/import/table";
import { templateCsv, templateFileName, templateXlsx } from "@/lib/import/template";
import { readXlsx } from "@/lib/import/xlsx";

async function readMatrix(file: File, kind: Kind): Promise<string[][]> {
  const buf = await file.arrayBuffer();
  if (/\.xlsx$/i.test(file.name)) return (await readXlsx(buf, kind)).matrix;
  if (/\.xls$/i.test(file.name)) throw new Error("古い形式の Excel（.xls）は読めません。.xlsx か CSV で保存し直してください");
  return parseCsv(decodeCsvBytes(buf));
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 取り込む行の見出し（確かめの一覧に出す短い説明） */
function rowTitle(kind: Kind, r: Record<string, unknown>): string {
  const s = (k: string) => String(r[k] ?? "");
  if (kind === "clients") return s("name");
  if (kind === "buildings") return `${s("client_name")} ／ ${s("name")}`;
  if (kind === "rooms") return `${s("building_name")} ／ ${s("room_no")}`;
  return `${s("building_name")} ／ ${s("start_date")}〜 ／ 清掃の中身 ${(r.services as unknown[]).length}つ`;
}

interface Preview {
  fileName: string;
  plan: Plan;
  ignored: string[];
}

function ImportBody({ sb, tenantId, perms }: { sb: SupabaseClient; tenantId: string; perms: string[] }) {
  const canImport = perms.includes("master.edit");
  const kinds = useMemo(() => KINDS.filter((k) => k !== "contracts" || perms.includes("contract.edit")), [perms]);
  const [kind, setKind] = useState<Kind>("clients");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<{ kind: Kind; fileName: string; r: ImportResult } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [jobsTick, setJobsTick] = useState(0);

  useEffect(() => {
    if (!canImport) return;
    let cancelled = false;
    void listImportJobs(sb, tenantId)
      .then((j) => !cancelled && setJobs(j))
      .catch((e: Error) => !cancelled && setMsg(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [sb, tenantId, canImport, jobsTick]);

  function reset(nextKind: Kind) {
    setKind(nextKind);
    setPreview(null);
    setResult(null);
    setMsg(null);
    setFileKey((n) => n + 1);
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setPreview(null);
    setResult(null);
    setMsg(null);
    if (!file) return;
    setBusy(true);
    try {
      const matrix = await readMatrix(file, kind);
      const table = toTable(kind, matrix);
      if (!table.ok) {
        setMsg(`ファイルの見出しが足りません：${table.missing.join("・")}（1行目に見出しを入れてください。ひな形を使うと確実です）`);
        return;
      }
      if (table.rows.length === 0) {
        setMsg("取り込む行がありません（2行目から入れてください）");
        return;
      }
      const existing = await loadExisting(sb, tenantId, kind); // 確かめのための読み取りだけ。何も書かない
      setPreview({ fileName: file.name, plan: planImport(kind, table.rows, existing), ignored: table.ignored });
    } catch (err) {
      const m = (err as Error).message;
      setMsg(/古い形式/.test(m) ? m : /通信|fetch|network/i.test(m) ? describeError(err) : `ファイルを読めませんでした（${kindLabel(kind)}の .xlsx か CSV を選んでください）：${m}`);
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    if (!preview) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await runImport(sb, tenantId, kind, preview.fileName, preview.plan);
      if (!r.ok) {
        setMsg(importFailureMessage(r.reason));
        return;
      }
      setResult({ kind, fileName: preview.fileName, r });
      setPreview(null);
      setFileKey((n) => n + 1);
      setJobsTick((n) => n + 1);
    } catch (err) {
      setMsg(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canImport) {
    return <Notice text="取り込みをする権限がありません。" />;
  }
  const plan = preview?.plan;
  return (
    <>
      <div className="m-form" style={{ maxWidth: 560 }}>
        <div className="m-field">
          <label htmlFor="im-kind">取り込むもの</label>
          <select id="im-kind" value={kind} onChange={(e) => reset(e.target.value as Kind)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        </div>
        <ul className="im-hints">
          {HINTS[kind].map((h) => (
            <li key={h}>{h}</li>
          ))}
          <li>取引先 → 建物 → 部屋 → 契約の順に取り込みます。</li>
        </ul>
        <div className="m-row">
          <button type="button" className="m-btn sub" onClick={() => download(templateFileName(kind, "xlsx"), templateXlsx(kind) as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}>
            ひな形（Excel）
          </button>
          <button type="button" className="m-btn sub" onClick={() => download(templateFileName(kind, "csv"), templateCsv(kind), "text/csv;charset=utf-8")}>
            ひな形（CSV）
          </button>
        </div>
        <p className="m-sub">見出し：{columnsOf(kind).map((c) => (c.required ? `${c.label}（必須）` : c.label)).join("、")}</p>
        <div className="m-field">
          <label htmlFor="im-file">ファイルを選ぶ</label>
          <input id="im-file" key={fileKey} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void onFile(e)} disabled={busy} />
        </div>
      </div>
      <Notice text={msg} />

      {plan && preview ? (
        <section aria-label="取り込む前の確かめ" className="m-section">
          <h2>取り込む前の確かめ（まだ何も書いていません）</h2>
          <p className="m-sub">ファイル：{preview.fileName}</p>
          <ul className="im-counts">
            <li>ファイルの行：{plan.counts.total}</li>
            <li className="ok">取り込める：{plan.counts.importable}{KIND_UNIT[kind]}</li>
            <li className={plan.counts.duplicate > 0 ? "warn" : ""}>重なり：{plan.counts.duplicate}{KIND_UNIT[kind]}</li>
            <li className={plan.counts.error > 0 ? "warn" : ""}>エラーの行：{plan.counts.error}</li>
          </ul>
          {preview.ignored.length > 0 ? <Notice text={`知らない見出しは無視しました：${preview.ignored.join("、")}`} /> : null}
          {plan.errors.length > 0 ? (
            <>
              <h3>エラーの行（取り込みません）</h3>
              <div className="im-scroll">
                <table className="im-table" aria-label="エラーの行">
                  <thead>
                    <tr>
                      <th>行</th>
                      <th>項目</th>
                      <th>理由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.errors.map((e, i) => (
                      <tr key={i}>
                        <td>{e.row}行目</td>
                        <td>{e.column}</td>
                        <td>{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {plan.duplicates.length > 0 ? (
            <>
              <h3>重なり（飛ばします）</h3>
              <div className="im-scroll">
                <table className="im-table" aria-label="重なりの行">
                  <thead>
                    <tr>
                      <th>行</th>
                      <th>理由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.duplicates.map((d, i) => (
                      <tr key={i}>
                        <td>{d.row}行目</td>
                        <td>{d.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {plan.payload.length > 0 ? (
            <>
              <h3>取り込む内容{plan.payload.length > 10 ? "（先頭の10件）" : ""}</h3>
              <ul>
                {plan.payload.slice(0, 10).map((r) => (
                  <li key={String(r.row)}>{rowTitle(kind, r)}</li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="m-row">
            <button type="button" className="m-btn" onClick={() => void onImport()} disabled={busy || plan.payload.length === 0}>
              この内容で取り込む
            </button>
            <span className="m-sub">{plan.payload.length === 0 ? "取り込めるものがありません。ファイルを直して選び直してください。" : "エラーと重なりの行は取り込みません。"}</span>
          </div>
        </section>
      ) : null}

      {result ? (
        <section aria-label="取り込みの結果" className="m-section">
          <h2>取り込みの結果</h2>
          <Notice kind="ok" text={`取り込みました（${kindLabel(result.kind)}：${result.fileName}）`} />
          <ul className="im-counts">
            <li className="ok">取り込んだ数：{result.r.created ?? 0}{KIND_UNIT[result.kind]}</li>
            <li className={(result.r.skipped ?? 0) > 0 ? "warn" : ""}>重なりで飛ばした数：{result.r.skipped ?? 0}</li>
            <li className={(result.r.errors ?? 0) > 0 ? "warn" : ""}>エラーの行：{result.r.errors ?? 0}</li>
          </ul>
          {(result.r.details ?? []).length > 0 ? (
            <div className="im-scroll">
              <table className="im-table" aria-label="取り込まなかった行">
                <thead>
                  <tr>
                    <th>行</th>
                    <th>区分</th>
                    <th>理由</th>
                  </tr>
                </thead>
                <tbody>
                  {(result.r.details ?? []).map((d, i) => (
                    <tr key={i}>
                      <td>{d.row}行目</td>
                      <td>{d.status === "duplicate" ? "重なり" : "エラー"}</td>
                      <td>{d.messages.map(reasonMessage).join(" ／ ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-label="取り込みの履歴" className="m-section">
        <h2>取り込みの履歴</h2>
        {jobs.length === 0 ? <p>まだ取り込みはありません。</p> : null}
        {jobs.map((j) => (
          <div key={j.id} className="m-card">
            <strong>
              {kindLabel(j.kind)}：{j.file_name}
            </strong>
            <span className="m-sub">
              {formatJobTime(j.created_at)} ／ 取り込み {j.created_count} ／ 重なり {j.skipped_count} ／ エラー {j.error_rows} ／ {jobStatusLabel(j.status)}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}

export default function ImportPage() {
  const state = useSession({ redirect: true });
  return (
    <section>
      <h1>データの取り込み</h1>
      {state.status === "failed" ? <Notice text={sessionMessage[state.reason]} /> : null}
      {state.status === "loading" ? <p>読み込み中…</p> : null}
      {state.status === "ready" ? <ImportBody sb={state.session.client} tenantId={state.session.tenantId} perms={state.session.perms} /> : null}
    </section>
  );
}
