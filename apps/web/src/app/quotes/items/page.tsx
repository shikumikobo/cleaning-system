"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Field, Loading, Notice, QuoteShell, useQuoteCtx, type QuoteCtx } from "@/components/quotes/Shell";
import { formatYen, lineKindLabel } from "@/lib/quotes/format";
import { deleteItem, listItems, saveItem, type ItemInput } from "@/lib/quotes/repo";
import type { Item } from "@/lib/quotes/types";
import { validateItem, type Errors } from "@/lib/quotes/validate";

const EMPTY: ItemInput = { name: "", unit: "式", unit_price: "0", kind: "one_time" };

function Items({ ctx }: { ctx: QuoteCtx }) {
  const [items, setItems] = useState<Item[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // 直している品名の id（"" は新規）
  const [form, setForm] = useState<ItemInput>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await listItems(ctx.sb, ctx.tenantId));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, [ctx]);
  useEffect(() => {
    void reload();
  }, [reload]);

  function start(it: Item | null) {
    setEditing(it?.id ?? "");
    setForm(it ? { name: it.name, unit: it.unit, unit_price: String(it.unit_price), kind: it.kind } : EMPTY);
    setErrors({});
    setMsg(null);
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const errs = validateItem(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    try {
      await saveItem(ctx.sb, ctx.tenantId, editing || null, form);
      setEditing(null);
      await reload();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setMsg(/duplicate key|items_name_uq/.test(m) ? "同じ名前の品名がすでにあります" : m);
    }
  }

  async function onDelete(it: Item) {
    if (!window.confirm(`品名「${it.name}」を消しますか？（すでに見積に入れた明細は変わりません）`)) return;
    try {
      await deleteItem(ctx.sb, it.id);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const set = (k: keyof ItemInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <Notice text={msg} />
      <p className="m-sub">見積の明細に入れる品名・単位・単価の候補です。明細に入れるときは写すので、あとで直しても、入れた明細は変わりません。</p>
      {items.length === 0 ? <p>品名の候補はまだありません。</p> : null}
      {items.map((it) => (
        <div key={it.id} className="m-item">
          <span>
            <strong>{it.name}</strong>
            <span className="m-sub">
              {" "}
              <span className="m-badge">{lineKindLabel(it.kind)}</span>
              {formatYen(it.unit_price)} / {it.unit}
            </span>
          </span>
          {ctx.canEdit ? (
            <span className="m-row">
              <button className="m-btn sub" type="button" onClick={() => start(it)}>
                直す
              </button>
              <button className="m-btn danger" type="button" onClick={() => onDelete(it)}>
                消す
              </button>
            </span>
          ) : null}
        </div>
      ))}
      {ctx.canEdit && editing === null ? (
        <p>
          <button className="m-btn" type="button" onClick={() => start(null)}>
            品名を追加
          </button>
        </p>
      ) : null}
      {editing !== null ? (
        <form className="m-form two" onSubmit={onSave} noValidate>
          <Field label="品名" error={errors.name}>
            <input value={form.name} onChange={set("name")} autoComplete="off" />
          </Field>
          <Field label="種類" error={errors.kind}>
            <select value={form.kind} onChange={set("kind")}>
              <option value="base">基本</option>
              <option value="option">オプション</option>
              <option value="one_time">単発</option>
            </select>
          </Field>
          <Field label="単位（回・月・式 など）" error={errors.unit}>
            <input value={form.unit} onChange={set("unit")} autoComplete="off" />
          </Field>
          <Field label="単価（円）" error={errors.unit_price}>
            <input value={form.unit_price} onChange={set("unit_price")} inputMode="numeric" />
          </Field>
          <div className="m-row wide">
            <button className="m-btn" type="submit">
              保存する
            </button>
            <button className="m-btn sub" type="button" onClick={() => setEditing(null)}>
              やめる
            </button>
          </div>
        </form>
      ) : null}
    </>
  );
}

export default function ItemsPage() {
  const { ctx, error } = useQuoteCtx();
  return (
    <QuoteShell title="品名の候補" active="items">
      <Loading error={error} ctx={ctx ? { sb: ctx.sb, tenantId: ctx.tenantId } : null} />
      {ctx ? <Items ctx={ctx} /> : null}
    </QuoteShell>
  );
}
