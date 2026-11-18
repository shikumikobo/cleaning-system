// 機能 002 の行の形（data-model.md の 002 の章）
export type ClientKind = "management_company" | "owner";

export interface Client {
  id: string;
  tenant_id: string;
  kind: ClientKind;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  closing_day: number | null;
  payment_terms: string | null;
  deleted_at: string | null;
}

export interface Contact {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  deleted_at: string | null;
}

export interface Building {
  id: string;
  tenant_id: string;
  client_id: string;
  owner_client_id: string | null;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  location_fixed: boolean;
  deleted_at: string | null;
}

export interface Karte {
  id: string;
  tenant_id: string;
  building_id: string;
  entry: string | null;
  key_place: string | null;
  parking: string | null;
  garbage_days: string | null;
  manager_contact: string | null;
  cautions: string | null;
  deleted_at: string | null;
}

export interface Room {
  id: string;
  tenant_id: string;
  building_id: string;
  room_no: string;
  floor: number | null;
  active: boolean;
  deleted_at: string | null;
}

export interface Area {
  id: string;
  tenant_id: string;
  building_id: string;
  name: string;
  sort: number;
  active: boolean;
  deleted_at: string | null;
}

/** 消す RPC の戻り（delete_client・delete_building・delete_room・delete_building_area） */
export interface Blocker {
  reason: string;
  table: string;
  count: number;
}
export interface DeleteResult {
  ok: boolean;
  reason?: string;
  deleted?: boolean;
  deactivated?: boolean;
  already?: boolean;
  blockers?: Blocker[];
}
export type DeleteTarget = "client" | "building" | "room" | "area";
