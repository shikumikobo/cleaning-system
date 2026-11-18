"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Field, Loading, Notice, Shell, useMasters, type MastersCtx } from "@/components/masters/Shell";
import { deleteMessage, sortAreas, sortRooms } from "@/lib/masters/format";
import {
  deleteArea,
  deleteBuilding,
  deleteRoom,
  getBuilding,
  getKarte,
  listAreas,
  listClients,
  listRooms,
  saveArea,
  saveBuilding,
  saveKarte,
  saveRoom,
  setAreaActive,
  setRoomActive,
  type BuildingInput,
  type KarteInput,
} from "@/lib/masters/repo";
import type { Area, Client, DeleteResult, DeleteTarget, Room } from "@/lib/masters/types";
import { validateArea, validateBuilding, validateRoom, type Errors } from "@/lib/masters/validate";

const EMPTY: BuildingInput = { name: "", address: "", client_id: "", owner_client_id: "", lat: "", lng: "" };
const EMPTY_KARTE: KarteInput = { entry: "", key_place: "", parking: "", garbage_days: "", manager_contact: "", cautions: "" };

function BuildingForm({ ctx }: { ctx: MastersCtx }) {
  const router = useRouter();
  const id = useSearchParams().get("id");
  const [form, setForm] = useState<BuildingInput>(EMPTY);
  const [clients, setClients] = useState<Client[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cs = await listClients(ctx.sb, ctx.tenantId);
        if (cancelled) return;
        setClients(cs);
        if (!id) return;
        const b = await getBuilding(ctx.sb, ctx.tenantId, id);
        if (cancelled) return;
        if (!b) return setMsg("建物が見つかりません（消されたか、見る権限がありません）");
        setForm({
          name: b.name,
          address: b.address,
          client_id: b.client_id,
          owner_client_id: b.owner_client_id ?? "",
          lat: b.lat?.toString() ?? "",
          lng: b.lng?.toString() ?? "",
        });
      } catch (e) {
        if (!cancelled) setMsg(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, id]);

  const set = (k: keyof BuildingInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setOk(null);
    const errs = validateBuilding(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      const saved = await saveBuilding(ctx.sb, ctx.tenantId, id, form);
      setOk("保存しました");
      if (!id) router.replace(`/buildings/edit/?id=${saved.id}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!id || !window.confirm("この建物を消しますか？（カルテ・部屋・場所も一緒に消えます）")) return;
    setBusy(true);
    try {
      const r = await deleteBuilding(ctx.sb, id);
      if (r.ok) router.replace("/buildings/");
      else setMsg(deleteMessage("building", r));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      <form className="m-form two" onSubmit={onSave} noValidate>
        <Field label="建物の名前" error={errors.name}>
          <input value={form.name} onChange={set("name")} autoComplete="off" />
        </Field>
        <Field label="住所" error={errors.address}>
          <input value={form.address} onChange={set("address")} autoComplete="off" />
        </Field>
        <Field label="依頼元（管理会社など）" error={errors.client_id}>
          <select value={form.client_id} onChange={set("client_id")}>
            <option value="">選んでください</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="所有者（オーナー。なくてもよい）">
          <select value={form.owner_client_id} onChange={set("owner_client_id")}>
            <option value="">なし</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="緯度（地図の機能で入ります。空でよい）" error={errors.lat}>
          <input value={form.lat} onChange={set("lat")} inputMode="decimal" />
        </Field>
        <Field label="経度" error={errors.lng}>
          <input value={form.lng} onChange={set("lng")} inputMode="decimal" />
        </Field>
        <div className="m-row wide">
          <button className="m-btn" type="submit" disabled={busy}>
            保存する
          </button>
          {id ? (
            <button className="m-btn danger" type="button" disabled={busy} onClick={onDelete}>
              この建物を消す
            </button>
          ) : null}
        </div>
      </form>
      {id ? (
        <>
          <KarteSection ctx={ctx} buildingId={id} />
          <RoomsSection ctx={ctx} buildingId={id} />
          <AreasSection ctx={ctx} buildingId={id} />
        </>
      ) : (
        <p className="m-sub">カルテ・部屋・場所は、建物を保存したあとに登録できます。</p>
      )}
    </>
  );
}

function KarteSection({ ctx, buildingId }: { ctx: MastersCtx; buildingId: string }) {
  const [form, setForm] = useState<KarteInput>(EMPTY_KARTE);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getKarte(ctx.sb, buildingId)
      .then((k) => {
        if (cancelled || !k) return;
        setForm({
          entry: k.entry ?? "",
          key_place: k.key_place ?? "",
          parking: k.parking ?? "",
          garbage_days: k.garbage_days ?? "",
          manager_contact: k.manager_contact ?? "",
          cautions: k.cautions ?? "",
        });
      })
      .catch((e: Error) => !cancelled && setMsg(e.message));
    return () => {
      cancelled = true;
    };
  }, [ctx, buildingId]);

  const set = (k: keyof KarteInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setOk(null);
    try {
      await saveKarte(ctx.sb, ctx.tenantId, buildingId, form);
      setOk("カルテを保存しました");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="m-section">
      <h2>建物カルテ</h2>
      <p className="m-sub">スタッフが現場で見ます。外部の人には見えません。</p>
      <Notice text={msg} />
      <Notice text={ok} kind="ok" />
      <form className="m-form" onSubmit={save}>
        <Field label="入り方">
          <textarea value={form.entry} onChange={set("entry")} />
        </Field>
        <Field label="鍵の場所">
          <textarea value={form.key_place} onChange={set("key_place")} />
        </Field>
        <Field label="駐車場">
          <textarea value={form.parking} onChange={set("parking")} />
        </Field>
        <Field label="ゴミの日">
          <input value={form.garbage_days} onChange={set("garbage_days")} />
        </Field>
        <Field label="管理人の連絡先">
          <input value={form.manager_contact} onChange={set("manager_contact")} />
        </Field>
        <Field label="注意すること">
          <textarea value={form.cautions} onChange={set("cautions")} />
        </Field>
        <div>
          <button className="m-btn" type="submit">
            カルテを保存する
          </button>
        </div>
      </form>
    </div>
  );
}

function resultNotice(target: DeleteTarget, r: DeleteResult): string {
  return deleteMessage(target, r);
}

function RoomsSection({ ctx, buildingId }: { ctx: MastersCtx; buildingId: string }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ room_no: "", floor: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => setRooms(await listRooms(ctx.sb, buildingId)), [ctx, buildingId]);
  useEffect(() => {
    void reload().catch((e: Error) => setMsg(e.message));
  }, [reload]);

  function start(r: Room | null) {
    setEditing(r?.id ?? "");
    setForm({ room_no: r?.room_no ?? "", floor: r?.floor?.toString() ?? "" });
    setErrors({});
    setMsg(null);
  }

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const errs = validateRoom(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    await run(async () => {
      await saveRoom(ctx.sb, ctx.tenantId, buildingId, editing || null, form);
      setEditing(null);
    });
  }

  async function remove(r: Room) {
    if (!window.confirm(`部屋「${r.room_no}」を消しますか？`)) return;
    await run(async () => setMsg(resultNotice("room", await deleteRoom(ctx.sb, r.id))));
  }

  return (
    <div className="m-section">
      <h2>部屋</h2>
      <Notice text={msg} />
      {rooms.length === 0 ? <p className="m-sub">部屋はまだ登録されていません。</p> : null}
      {sortRooms(rooms).map((r) => (
        <div key={r.id} className="m-item">
          <span>
            <strong>{r.room_no}</strong>
            <span className="m-sub"> {r.floor !== null ? `${r.floor}階` : ""} </span>
            {!r.active ? <span className="m-badge off">使わない</span> : null}
          </span>
          <span className="m-row">
            <button className="m-btn sub" type="button" onClick={() => start(r)}>
              直す
            </button>
            <button className="m-btn sub" type="button" onClick={() => run(() => setRoomActive(ctx.sb, r.id, !r.active))}>
              {r.active ? "使わない" : "使う"}
            </button>
            <button className="m-btn danger" type="button" onClick={() => remove(r)}>
              消す
            </button>
          </span>
        </div>
      ))}
      {editing === null ? (
        <p>
          <button className="m-btn sub" type="button" onClick={() => start(null)}>
            部屋を追加
          </button>
        </p>
      ) : (
        <form className="m-form two" onSubmit={save} noValidate>
          <Field label="部屋番号" error={errors.room_no}>
            <input value={form.room_no} onChange={(e) => setForm({ ...form, room_no: e.target.value })} />
          </Field>
          <Field label="階" error={errors.floor}>
            <input value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} inputMode="numeric" />
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
      )}
    </div>
  );
}

function AreasSection({ ctx, buildingId }: { ctx: MastersCtx; buildingId: string }) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", sort: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => setAreas(await listAreas(ctx.sb, buildingId)), [ctx, buildingId]);
  useEffect(() => {
    void reload().catch((e: Error) => setMsg(e.message));
  }, [reload]);

  function start(a: Area | null) {
    setEditing(a?.id ?? "");
    setForm({ name: a?.name ?? "", sort: a?.sort.toString() ?? "" });
    setErrors({});
    setMsg(null);
  }

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const errs = validateArea(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    await run(async () => {
      await saveArea(ctx.sb, ctx.tenantId, buildingId, editing || null, form);
      setEditing(null);
    });
  }

  async function remove(a: Area) {
    if (!window.confirm(`場所「${a.name}」を消しますか？`)) return;
    await run(async () => setMsg(resultNotice("area", await deleteArea(ctx.sb, a.id))));
  }

  return (
    <div className="m-section">
      <h2>場所</h2>
      <p className="m-sub">写真と報告のひな形で使います（エントランス・階段・ゴミ置き場 など）。</p>
      <Notice text={msg} />
      {areas.length === 0 ? <p className="m-sub">場所はまだ登録されていません。</p> : null}
      {sortAreas(areas).map((a) => (
        <div key={a.id} className="m-item">
          <span>
            <strong>{a.name}</strong>
            <span className="m-sub"> 並び {a.sort} </span>
            {!a.active ? <span className="m-badge off">使わない</span> : null}
          </span>
          <span className="m-row">
            <button className="m-btn sub" type="button" onClick={() => start(a)}>
              直す
            </button>
            <button className="m-btn sub" type="button" onClick={() => run(() => setAreaActive(ctx.sb, a.id, !a.active))}>
              {a.active ? "使わない" : "使う"}
            </button>
            <button className="m-btn danger" type="button" onClick={() => remove(a)}>
              消す
            </button>
          </span>
        </div>
      ))}
      {editing === null ? (
        <p>
          <button className="m-btn sub" type="button" onClick={() => start(null)}>
            場所を追加
          </button>
        </p>
      ) : (
        <form className="m-form two" onSubmit={save} noValidate>
          <Field label="名前" error={errors.name}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="並び順（小さいほど上）" error={errors.sort}>
            <input value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })} inputMode="numeric" />
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
      )}
    </div>
  );
}

function Inner() {
  const { ctx, error } = useMasters();
  const id = useSearchParams().get("id");
  return (
    <Shell title={id ? "建物の編集" : "建物の登録"} active="buildings">
      <Loading error={error} ctx={ctx} />
      {ctx ? <BuildingForm key={id ?? "new"} ctx={ctx} /> : null}
    </Shell>
  );
}

export default function BuildingEditPage() {
  return (
    <Suspense fallback={<p>読み込み中…</p>}>
      <Inner />
    </Suspense>
  );
}
