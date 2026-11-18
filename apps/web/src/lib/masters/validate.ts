// 入力の検査。DB の check 制約と同じ決まりを、保存の前に画面で確かめる（R-002-23）。
// 戻りは「項目の名前 → 日本語のエラー」。空なら通る。
export type Errors = Record<string, string>;

const EMAIL = /^[^@\s]+@[^@\s]+$/;
const blank = (v: string | undefined | null) => !v || v.trim() === "";

function checkInt(v: string | undefined, label: string, min?: number, max?: number): string | undefined {
  if (blank(v)) return undefined;
  const t = v!.trim();
  if (!/^-?\d+$/.test(t)) return `${label}は整数で入れてください`;
  const n = Number(t);
  if (min !== undefined && n < min) return `${label}は ${min} 以上にしてください`;
  if (max !== undefined && n > max) return `${label}は ${max} 以下にしてください`;
  return undefined;
}

function checkNumber(v: string | undefined, label: string, min: number, max: number): string | undefined {
  if (blank(v)) return undefined;
  const n = Number(v!.trim());
  if (!Number.isFinite(n)) return `${label}は数で入れてください`;
  if (n < min || n > max) return `${label}は ${min}〜${max} の間にしてください`;
  return undefined;
}

export function validateClient(i: { kind?: string; name?: string; email?: string; closing_day?: string }): Errors {
  const e: Errors = {};
  if (blank(i.name)) e.name = "名前を入れてください";
  if (i.kind !== "management_company" && i.kind !== "owner") e.kind = "種類（管理会社・オーナー）を選んでください";
  if (!blank(i.email) && !EMAIL.test(i.email!.trim())) e.email = "メールアドレスの形が正しくありません";
  const d = checkInt(i.closing_day, "締め日", 1, 31);
  if (d) e.closing_day = d;
  return e;
}

export function validateContact(i: { name?: string; email?: string }): Errors {
  const e: Errors = {};
  if (blank(i.name)) e.name = "名前を入れてください";
  if (!blank(i.email) && !EMAIL.test(i.email!.trim())) e.email = "メールアドレスの形が正しくありません";
  return e;
}

export function validateBuilding(i: { name?: string; address?: string; client_id?: string; lat?: string; lng?: string }): Errors {
  const e: Errors = {};
  if (blank(i.name)) e.name = "建物の名前を入れてください";
  if (blank(i.address)) e.address = "住所を入れてください";
  if (blank(i.client_id)) e.client_id = "依頼元の取引先を選んでください";
  const hasLat = !blank(i.lat);
  const hasLng = !blank(i.lng);
  if (hasLat !== hasLng) {
    e.lat = "緯度と経度は、両方入れるか、両方空にしてください";
  } else {
    const a = checkNumber(i.lat, "緯度", -90, 90);
    if (a) e.lat = a;
    const b = checkNumber(i.lng, "経度", -180, 180);
    if (b) e.lng = b;
  }
  return e;
}

export function validateRoom(i: { room_no?: string; floor?: string }): Errors {
  const e: Errors = {};
  if (blank(i.room_no)) e.room_no = "部屋番号を入れてください";
  const f = checkInt(i.floor, "階");
  if (f) e.floor = f;
  return e;
}

export function validateArea(i: { name?: string; sort?: string }): Errors {
  const e: Errors = {};
  if (blank(i.name)) e.name = "場所の名前を入れてください";
  const s = checkInt(i.sort, "並び順");
  if (s) e.sort = s;
  return e;
}
