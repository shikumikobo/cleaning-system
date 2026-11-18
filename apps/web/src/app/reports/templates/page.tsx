"use client";

// ひな形の編集（R-009-35）：建物を選び、ひな形と項目を、作る・名前を直す・並べ替える・「使わない」にする・消す。
// 編集を出すのは master.edit を持つ人だけ（見せ方のため。判定は DB）。使われているものは、消さずに「使わない」になる
import { useCallback, useEffect, useState } from "react";
import { Field, Loading, Notice, ReportShell, useReportCtx } from "@/components/reports/Shell";
import { describeError } from "@/lib/errors";
import { selectableCandidates, sortAreas } from "@/lib/masters/format";
import { listAreas, listBuildings } from "@/lib/masters/repo";
import type { Area, Building } from "@/lib/masters/types";
import { sortReportItems, swapSort, templateDeleteMessage, validateName } from "@/lib/reports/format";
import {
  createTemplate,
  createTemplateItem,
  deleteTemplate,
  deleteTemplateItem,
  listTemplateItems,
  listTemplates,
  updateTemplate,
  updateTemplateItem,
} from "@/lib/reports/repo";
import type { TemplateItemRow, TemplateRow } from "@/lib/reports/types";

export default function TemplatesPage() {
  const { ctx, error } = useReportCtx();
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [building, setBuilding] = useState("");
  const [areas, setAreas] = useState<Area[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [items, setItems] = useState<TemplateItemRow[]>([]);
  const [newName, setNewName] = useState("");
  const [newItem, setNewItem] = useState<Record<string, { name: string; area: string }>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void listBuildings(ctx.sb, ctx.tenantId)
      .then((b) => !cancelled && setBuildings(b))
      .catch((e) => !cancelled && setMsg(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const load = useCallback(async () => {
    if (!ctx || !building) {
      setTemplates([]);
      setItems([]);
      setAreas([]);
      return;
    }
    try {
      const [ts, as] = await Promise.all([listTemplates(ctx.sb, ctx.tenantId, building), listAreas(ctx.sb, building)]);
      setTemplates(ts);
      setAreas(sortAreas(selectableCandidates(as)));
      setItems(await listTemplateItems(ctx.sb, ctx.tenantId, ts.map((t) => t.id)));
    } catch (e) {
      setMsg(describeError(e));
    }
  }, [ctx, building]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<string | void>) {
    setMsg(null);
    setOk(null);
    try {
      const done = await fn();
      if (done) setOk(done);
      await load();
    } catch (e) {
      setMsg(describeError(e));
    }
  }

  if (!ctx) return <ReportShell title="報告のひな形" active="templates"><Loading error={error} ctx={null} /></ReportShell>;
  const edit = ctx.canMaster;
  return (
    <ReportShell title="報告のひな形" active="templates">
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      <p className="m-sub">建物ごとに、報告書のチェック項目の並び（ひな形）を作ります。契約の中身のひな形に選ぶと、作業の報告書がこの項目から作られます。</p>
      <div className="m-bar">
        <select aria-label="建物" value={building} onChange={(e) => setBuilding(e.target.value)}>
          <option value="">建物を選んでください</option>
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      {building && !edit ? <p className="m-sub">ひな形を直せるのは、登録の権限がある人です。</p> : null}
      {building && edit ? (
        <div className="m-row" style={{ marginBottom: 16 }}>
          <Field label="新しいひな形の名前" error={errs.newName}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={100} aria-label="新しいひな形の名前" />
          </Field>
          <button
            type="button"
            className="m-btn"
            onClick={() => {
              const e = validateName(newName);
              setErrs({ newName: e ?? "" });
              if (e) return;
              void run(async () => {
                await createTemplate(ctx.sb, ctx.tenantId, building, newName);
                setNewName("");
                return "ひな形を作りました";
              });
            }}
          >
            ひな形を作る
          </button>
        </div>
      ) : null}
      {building && templates.length === 0 ? <p>この建物のひな形はまだありません。</p> : null}
      {templates.map((t) => {
        const mine = sortReportItems(items.filter((i) => i.template_id === t.id));
        const draft = newItem[t.id] ?? { name: "", area: "" };
        return (
          <article key={t.id} className="m-card" aria-label={t.name} data-testid="template">
            <strong>
              {t.name} {!t.active ? <span className="m-badge off">使わない</span> : null}
            </strong>
            {edit ? (
              <span className="m-row">
                <button
                  type="button"
                  className="m-btn sub"
                  onClick={() => {
                    const name = window.prompt("ひな形の名前", t.name);
                    if (name === null) return;
                    const e = validateName(name);
                    if (e) return setMsg(e);
                    void run(async () => {
                      await updateTemplate(ctx.sb, t.id, { name: name.trim() });
                      return "名前を直しました";
                    });
                  }}
                >
                  名前を直す
                </button>
                <button type="button" className="m-btn sub" onClick={() => void run(async () => void (await updateTemplate(ctx.sb, t.id, { active: !t.active })))}>
                  {t.active ? "使わない" : "使う"}
                </button>
                <button
                  type="button"
                  className="m-btn danger"
                  onClick={() => {
                    if (!window.confirm(`ひな形「${t.name}」を消しますか？`)) return;
                    void run(async () => templateDeleteMessage("template", await deleteTemplate(ctx.sb, t.id)));
                  }}
                >
                  消す
                </button>
              </span>
            ) : null}
            <ul style={{ paddingLeft: 18, margin: "8px 0" }}>
              {mine.map((i) => (
                <li key={i.id} data-testid="template-item" className="m-row" style={{ justifyContent: "space-between" }}>
                  <span>
                    {i.name}
                    {i.area_id ? `（${areas.find((a) => a.id === i.area_id)?.name ?? "場所"}）` : ""} {!i.active ? <span className="m-badge off">使わない</span> : null}
                  </span>
                  {edit ? (
                    <span className="m-row">
                      <button
                        type="button"
                        className="m-btn sub"
                        aria-label={`${i.name}を上へ`}
                        onClick={() => {
                          const ch = swapSort(mine, i.id, -1);
                          if (ch) void run(async () => void (await Promise.all(ch.map((c) => updateTemplateItem(ctx.sb, c.id, { sort: c.sort })))));
                        }}
                      >
                        上へ
                      </button>
                      <button
                        type="button"
                        className="m-btn sub"
                        aria-label={`${i.name}を下へ`}
                        onClick={() => {
                          const ch = swapSort(mine, i.id, 1);
                          if (ch) void run(async () => void (await Promise.all(ch.map((c) => updateTemplateItem(ctx.sb, c.id, { sort: c.sort })))));
                        }}
                      >
                        下へ
                      </button>
                      <button
                        type="button"
                        className="m-btn sub"
                        onClick={() => {
                          const name = window.prompt("項目の名前", i.name);
                          if (name === null) return;
                          const e = validateName(name);
                          if (e) return setMsg(e);
                          void run(async () => void (await updateTemplateItem(ctx.sb, i.id, { name: name.trim() })));
                        }}
                      >
                        名前
                      </button>
                      <button type="button" className="m-btn sub" onClick={() => void run(async () => void (await updateTemplateItem(ctx.sb, i.id, { active: !i.active })))}>
                        {i.active ? "使わない" : "使う"}
                      </button>
                      <button
                        type="button"
                        className="m-btn danger"
                        onClick={() => void run(async () => templateDeleteMessage("item", await deleteTemplateItem(ctx.sb, i.id)))}
                      >
                        消す
                      </button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {edit ? (
              <div className="m-row">
                <input
                  aria-label={`${t.name}の新しい項目`}
                  placeholder="項目の名前"
                  value={draft.name}
                  maxLength={100}
                  onChange={(e) => setNewItem({ ...newItem, [t.id]: { ...draft, name: e.target.value } })}
                />
                <select aria-label={`${t.name}の新しい項目の場所`} value={draft.area} onChange={(e) => setNewItem({ ...newItem, [t.id]: { ...draft, area: e.target.value } })} style={{ width: "auto" }}>
                  <option value="">場所なし</option>
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="m-btn"
                  onClick={() => {
                    const e = validateName(draft.name);
                    if (e) return setMsg(e);
                    void run(async () => {
                      await createTemplateItem(ctx.sb, ctx.tenantId, t.id, { name: draft.name, area_id: draft.area || null, sort: mine.length + 1 });
                      setNewItem({ ...newItem, [t.id]: { name: "", area: draft.area } });
                      return "項目を足しました";
                    });
                  }}
                >
                  項目を足す
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
    </ReportShell>
  );
}
