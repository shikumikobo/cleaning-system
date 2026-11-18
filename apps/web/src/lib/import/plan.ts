// 取り込む前の確かめ（検査・重なり・契約のまとめ）。サーバーに渡す行（payload）と、外した行（エラー・重なり）を決める純粋な関数。
// 何も書かない。DB の import_rows が、同じ決まりでやり直す（R-014-13）。R-014-5〜9
import { columnsOf, type Kind } from "./columns";
import { importKey } from "./normalize";
import type { SourceRow } from "./table";
import {
  billingOf, clientKindOf, contractKindOf, parseAmount, parseClosingDay, parseDate, parseFloor, parseRecurrence, parseTime, serviceKindOf,
} from "./values";

/** すでに登録されているもの（今の会社の、消していない行）。重なりと名前の解決に使う */
export interface Existing {
  clients: Array<{ id: string; name: string }>;
  buildings: Array<{ id: string; client_id: string; name: string }>;
  rooms: Array<{ building_id: string; room_no: string }>;
  contracts: Array<{ building_id: string; kind: string; start_date: string; serviceNames: string[] }>;
}
export const emptyExisting = (): Existing => ({ clients: [], buildings: [], rooms: [], contracts: [] });

export interface Issue {
  row: number;
  /** 見出しの名前 */
  column: string;
  message: string;
}
export interface Duplicate {
  row: number;
  message: string;
}
/** サーバーに渡して記録に残す、外した行 */
export interface Excluded {
  row: number;
  status: "error" | "duplicate";
  messages: string[];
}
export interface PlanCounts {
  /** ファイルの行の数（空の行を除く） */
  total: number;
  /** 取り込む数（契約は、まとめた契約の数） */
  importable: number;
  duplicate: number;
  /** エラーの行の数 */
  error: number;
}
export interface Plan {
  kind: Kind;
  payload: Array<Record<string, unknown>>;
  errors: Issue[];
  duplicates: Duplicate[];
  excluded: Excluded[];
  counts: PlanCounts;
}

const EMAIL = /^[^@\s]+@[^@\s]+$/;
const label = (kind: Kind, field: string) => columnsOf(kind).find((c) => c.field === field)?.label ?? field;

type Resolved = { ok: true; id: string } | { ok: false; message: string };
function resolveClient(name: string, existing: Existing, what = "取引先"): Resolved {
  if (name === "") return { ok: false, message: `${what}の名前を入れてください` };
  const hit = existing.clients.filter((c) => importKey(c.name) === importKey(name));
  if (hit.length === 0) return { ok: false, message: `「${name}」という${what}は登録されていません（先に取引先を取り込んでください）` };
  if (hit.length > 1) return { ok: false, message: `「${name}」と同じ名前の${what}が複数あり、決まりません` };
  return { ok: true, id: hit[0].id };
}
function resolveBuilding(clientId: string, name: string, existing: Existing): Resolved {
  if (name === "") return { ok: false, message: "建物名を入れてください" };
  const hit = existing.buildings.filter((b) => b.client_id === clientId && importKey(b.name) === importKey(name));
  if (hit.length === 0) return { ok: false, message: `「${name}」という建物は、その取引先に登録されていません（先に建物を取り込んでください）` };
  if (hit.length > 1) return { ok: false, message: `「${name}」と同じ名前の建物が複数あり、決まりません` };
  return { ok: true, id: hit[0].id };
}

class Collector {
  errors: Issue[] = [];
  duplicates: Duplicate[] = [];
  constructor(private kind: Kind) {}
  issue(row: number, field: string, message: string) {
    this.errors.push({ row, column: label(this.kind, field), message });
  }
  hasIssue(row: number) {
    return this.errors.some((e) => e.row === row);
  }
  finish(total: number, payload: Array<Record<string, unknown>>): Plan {
    const errors = [...this.errors].sort((a, b) => a.row - b.row);
    const duplicates = [...this.duplicates].sort((a, b) => a.row - b.row);
    const excluded: Excluded[] = [];
    const byRow = new Map<number, string[]>();
    for (const e of errors) byRow.set(e.row, [...(byRow.get(e.row) ?? []), `${e.column}：${e.message}`]);
    for (const [row, messages] of byRow) excluded.push({ row, status: "error", messages });
    for (const d of duplicates) excluded.push({ row: d.row, status: "duplicate", messages: [d.message] });
    excluded.sort((a, b) => a.row - b.row);
    return { kind: this.kind, payload, errors, duplicates, excluded, counts: { total, importable: payload.length, duplicate: duplicates.length, error: byRow.size } };
  }
}

function planClients(rows: SourceRow[], existing: Existing): Plan {
  const c = new Collector("clients");
  const seen = new Map<string, number>();
  const known = new Set(existing.clients.map((x) => importKey(x.name)));
  const payload: Array<Record<string, unknown>> = [];
  for (const { row, cells } of rows) {
    const kind = cells.kind === "" ? "management_company" : clientKindOf(cells.kind);
    const closing = parseClosingDay(cells.closing_day);
    if (cells.name === "") c.issue(row, "name", "名前を入れてください");
    if (kind === null) c.issue(row, "kind", `「${cells.kind}」は使えません。管理会社かオーナーにしてください`);
    if (cells.email !== "" && !EMAIL.test(cells.email)) c.issue(row, "email", "メールアドレスの形が正しくありません");
    if (closing === null) c.issue(row, "closing_day", "締め日は 1〜31 の整数（31 または「月末」で月末）で入れてください");
    if (c.hasIssue(row)) continue;
    const key = importKey(cells.name);
    if (known.has(key)) {
      c.duplicates.push({ row, message: "同じ名前の取引先がすでに登録されています" });
    } else if (seen.has(key)) {
      c.duplicates.push({ row, message: `ファイルの${seen.get(key)}行目と同じ名前です` });
    } else {
      seen.set(key, row);
      payload.push({ row, kind, name: cells.name, address: cells.address, phone: cells.phone, email: cells.email, closing_day: closing, payment_terms: cells.payment_terms });
    }
  }
  return c.finish(rows.length, payload);
}

function planBuildings(rows: SourceRow[], existing: Existing): Plan {
  const c = new Collector("buildings");
  const seen = new Map<string, number>();
  const known = new Set(existing.buildings.map((b) => `${b.client_id}|${importKey(b.name)}`));
  const payload: Array<Record<string, unknown>> = [];
  for (const { row, cells } of rows) {
    const client = resolveClient(cells.client_name, existing);
    if (!client.ok) c.issue(row, "client_name", client.message);
    if (cells.name === "") c.issue(row, "name", "建物名を入れてください");
    if (cells.address === "") c.issue(row, "address", "住所を入れてください");
    if (cells.owner_name !== "") {
      const owner = resolveClient(cells.owner_name, existing, "所有者");
      if (!owner.ok) c.issue(row, "owner_name", owner.message);
    }
    if (c.hasIssue(row) || !client.ok) continue;
    const key = `${client.id}|${importKey(cells.name)}`;
    if (known.has(key)) c.duplicates.push({ row, message: "同じ取引先に同じ名前の建物がすでに登録されています" });
    else if (seen.has(key)) c.duplicates.push({ row, message: `ファイルの${seen.get(key)}行目と同じ建物です` });
    else {
      seen.set(key, row);
      payload.push({ row, client_name: cells.client_name, name: cells.name, address: cells.address, owner_name: cells.owner_name });
    }
  }
  return c.finish(rows.length, payload);
}

function planRooms(rows: SourceRow[], existing: Existing): Plan {
  const c = new Collector("rooms");
  const seen = new Map<string, number>();
  const known = new Set(existing.rooms.map((r) => `${r.building_id}|${importKey(r.room_no)}`));
  const payload: Array<Record<string, unknown>> = [];
  for (const { row, cells } of rows) {
    const client = resolveClient(cells.client_name, existing);
    let building: Resolved = { ok: false, message: "" };
    if (!client.ok) c.issue(row, "client_name", client.message);
    else {
      building = resolveBuilding(client.id, cells.building_name, existing);
      if (!building.ok) c.issue(row, "building_name", building.message);
    }
    if (cells.room_no === "") c.issue(row, "room_no", "部屋番号を入れてください");
    const floor = parseFloor(cells.floor);
    if (floor === null) c.issue(row, "floor", "階は整数（1・1階・1F など）で入れてください");
    if (c.hasIssue(row) || !building.ok) continue;
    const key = `${building.id}|${importKey(cells.room_no)}`;
    if (known.has(key)) c.duplicates.push({ row, message: "同じ建物に同じ部屋番号がすでに登録されています" });
    else if (seen.has(key)) c.duplicates.push({ row, message: `ファイルの${seen.get(key)}行目と同じ部屋です` });
    else {
      seen.set(key, row);
      payload.push({ row, client_name: cells.client_name, building_name: cells.building_name, room_no: cells.room_no, floor });
    }
  }
  return c.finish(rows.length, payload);
}

interface ContractLine {
  row: number;
  cells: Record<string, string>;
  clientName: string;
  buildingName: string;
  buildingId: string | null;
  kind: string | null;
  start: string | null;
  end: string | null;
  service: { service_kind: string; name: string; amount: number; billing: string; recurrence: string; start_time: string; end_time: string } | null;
}

function planContracts(rows: SourceRow[], existing: Existing): Plan {
  const c = new Collector("contracts");
  const lines: ContractLine[] = [];
  for (const { row, cells } of rows) {
    const client = resolveClient(cells.client_name, existing);
    let buildingId: string | null = null;
    if (!client.ok) c.issue(row, "client_name", client.message);
    else {
      const b = resolveBuilding(client.id, cells.building_name, existing);
      if (!b.ok) c.issue(row, "building_name", b.message);
      else buildingId = b.id;
    }
    const kind = cells.kind === "" ? null : contractKindOf(cells.kind);
    if (kind === null) c.issue(row, "kind", cells.kind === "" ? "契約の種類を入れてください（定期か単発）" : `「${cells.kind}」は使えません。定期か単発にしてください`);
    const start = cells.start_date === "" ? null : parseDate(cells.start_date);
    if (start === null) c.issue(row, "start_date", cells.start_date === "" ? "開始日を入れてください" : "日付として読めません（2026-12-01 の形で入れてください）");
    let end: string | null = "";
    if (cells.end_date !== "") {
      end = parseDate(cells.end_date);
      if (end === null) c.issue(row, "end_date", "日付として読めません（2026-12-01 の形で入れてください）");
      else if (start !== null && end < start) c.issue(row, "end_date", "終了日は開始日以後にしてください");
    }
    if (cells.service_name === "") c.issue(row, "service_name", "清掃の名前を入れてください");
    const serviceKind = cells.service_kind === "" ? null : serviceKindOf(cells.service_kind);
    if (serviceKind === null)
      c.issue(row, "service_kind", cells.service_kind === "" ? "清掃の種類を入れてください（基本・オプション・特別清掃）" : `「${cells.service_kind}」は使えません。基本・オプション・特別清掃のどれかにしてください`);
    const amount = parseAmount(cells.amount);
    if (amount === null) c.issue(row, "amount", "金額は 0 以上の整数で入れてください");
    let billing: string | null = null;
    if (cells.billing !== "") {
      billing = billingOf(cells.billing);
      if (billing === null) c.issue(row, "billing", `「${cells.billing}」は使えません。毎月か行った回ごとにしてください`);
    } else if (serviceKind !== null) billing = serviceKind === "base" ? "monthly" : "per_visit";
    const rec = parseRecurrence(cells.recurrence);
    if (!rec.ok) c.issue(row, "recurrence", `「${cells.recurrence}」は頻度として読めません（毎週月曜・毎月第2水曜・3か月に1回・単発・RRULE など）`);
    const st = cells.start_time === "" ? "" : parseTime(cells.start_time);
    const et = cells.end_time === "" ? "" : parseTime(cells.end_time);
    if (st === null) c.issue(row, "start_time", "時刻として読めません（9:00 の形で入れてください）");
    if (et === null) c.issue(row, "end_time", "時刻として読めません（9:00 の形で入れてください）");
    if (st && et && et <= st) c.issue(row, "end_time", "終了時刻は開始時刻より後にしてください");
    const ok = !c.hasIssue(row);
    lines.push({
      row, cells, clientName: cells.client_name, buildingName: cells.building_name, buildingId, kind, start, end,
      service:
        ok && serviceKind && amount !== null && billing && rec.ok
          ? { service_kind: serviceKind, name: cells.service_name, amount, billing, recurrence: rec.rrule, start_time: st ?? "", end_time: et ?? "" }
          : null,
    });
  }

  // 同じ契約（取引先・建物・種類・開始日・終了日が同じ）の行をまとめる。まとめる鍵が読めない行は、単独のエラー
  const groups = new Map<string, ContractLine[]>();
  for (const l of lines) {
    if (l.buildingId === null || l.kind === null || l.start === null || l.end === null) continue;
    const key = [l.buildingId, l.kind, l.start, l.end].join("|");
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const payload: Array<Record<string, unknown>> = [];
  const known = new Set(existing.contracts.map((x) => contractKey(x.building_id, x.kind, x.start_date, x.serviceNames)));
  const seen = new Map<string, number>();
  for (const members of groups.values()) {
    const bad = members.find((m) => m.service === null);
    if (bad) {
      for (const m of members) {
        if (m.service !== null) c.issue(m.row, "service_name", `同じ契約の${bad.row}行目にエラーがあるため、この契約は取り込めません`);
      }
      continue;
    }
    const first = members[0];
    const key = contractKey(first.buildingId!, first.kind!, first.start!, members.map((m) => m.service!.name));
    if (known.has(key)) {
      c.duplicates.push({ row: first.row, message: "同じ建物・種類・開始日・清掃の名前の契約がすでに登録されています" });
    } else if (seen.has(key)) {
      c.duplicates.push({ row: first.row, message: `ファイルの${seen.get(key)}行目の契約と同じです` });
    } else {
      seen.set(key, first.row);
      payload.push({
        row: first.row, lines: members.map((m) => m.row), client_name: first.clientName, building_name: first.buildingName,
        kind: first.kind, start_date: first.start, end_date: first.end, services: members.map((m) => m.service),
      });
    }
  }
  payload.sort((a, b) => (a.row as number) - (b.row as number));
  return c.finish(rows.length, payload);
}

function contractKey(buildingId: string, kind: string, start: string, names: string[]): string {
  return [buildingId, kind, start, names.map((n) => importKey(n)).sort().join("\u0000")].join("|");
}

export function planImport(kind: Kind, rows: SourceRow[], existing: Existing): Plan {
  switch (kind) {
    case "clients":
      return planClients(rows, existing);
    case "buildings":
      return planBuildings(rows, existing);
    case "rooms":
      return planRooms(rows, existing);
    case "contracts":
      return planContracts(rows, existing);
  }
}
