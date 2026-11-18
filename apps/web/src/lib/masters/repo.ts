// Supabase を呼ぶ薄い層。RLS が権限と会社を決めるので、ここは「どの表をどう読み書きするか」だけを持つ。
// 消すのは RPC（子も一緒に消し、使われていれば止める）。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Area, Building, Client, Contact, DeleteResult, Karte, Room } from "./types";

const nul = (v: string | undefined | null) => (v === undefined || v === null || v.trim() === "" ? null : v.trim());
const num = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v.trim()));
const int = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : Number(v.trim()));

function fail<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

async function rpcDelete(sb: SupabaseClient, fn: string, id: string): Promise<DeleteResult> {
  const res = await sb.rpc(fn, { p_id: id });
  return fail(res) as DeleteResult;
}

// ---- 取引先 ----
export interface ClientInput {
  kind: string;
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  closing_day?: string;
  payment_terms?: string;
}
const clientRow = (i: ClientInput) => ({
  kind: i.kind,
  name: i.name.trim(),
  address: nul(i.address),
  phone: nul(i.phone),
  email: nul(i.email),
  closing_day: int(i.closing_day),
  payment_terms: nul(i.payment_terms),
});

export async function listClients(sb: SupabaseClient, tenantId: string): Promise<Client[]> {
  return fail(await sb.from("clients").select("*").eq("tenant_id", tenantId).is("deleted_at", null).order("name"));
}
export async function getClient(sb: SupabaseClient, tenantId: string, id: string): Promise<Client | null> {
  return fail(await sb.from("clients").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}
export async function saveClient(sb: SupabaseClient, tenantId: string, id: string | null, i: ClientInput): Promise<Client> {
  if (id) return fail(await sb.from("clients").update(clientRow(i)).eq("id", id).select().single());
  return fail(await sb.from("clients").insert({ tenant_id: tenantId, ...clientRow(i) }).select().single());
}
export const deleteClient = (sb: SupabaseClient, id: string) => rpcDelete(sb, "delete_client", id);

// ---- 担当者 ----
export interface ContactInput {
  name: string;
  email?: string;
  phone?: string;
}
export async function listContacts(sb: SupabaseClient, clientId: string): Promise<Contact[]> {
  return fail(await sb.from("client_contacts").select("*").eq("client_id", clientId).is("deleted_at", null).order("created_at"));
}
export async function saveContact(sb: SupabaseClient, tenantId: string, clientId: string, id: string | null, i: ContactInput): Promise<Contact> {
  const row = { name: i.name.trim(), email: nul(i.email), phone: nul(i.phone) };
  if (id) return fail(await sb.from("client_contacts").update(row).eq("id", id).select().single());
  return fail(await sb.from("client_contacts").insert({ tenant_id: tenantId, client_id: clientId, ...row }).select().single());
}
/** 担当者は、画面から直接消す（論理削除） */
export async function deleteContact(sb: SupabaseClient, id: string): Promise<void> {
  fail(await sb.from("client_contacts").update({ deleted_at: new Date().toISOString() }).eq("id", id).select().single());
}

// ---- 建物 ----
export interface BuildingInput {
  name: string;
  address: string;
  client_id: string;
  owner_client_id?: string;
  lat?: string;
  lng?: string;
}
const buildingRow = (i: BuildingInput) => ({
  name: i.name.trim(),
  address: i.address.trim(),
  client_id: i.client_id,
  owner_client_id: nul(i.owner_client_id),
  lat: num(i.lat),
  lng: num(i.lng),
});

export async function listBuildings(sb: SupabaseClient, tenantId: string): Promise<Building[]> {
  return fail(await sb.from("buildings").select("*").eq("tenant_id", tenantId).is("deleted_at", null).order("name"));
}
export async function getBuilding(sb: SupabaseClient, tenantId: string, id: string): Promise<Building | null> {
  return fail(await sb.from("buildings").select("*").eq("tenant_id", tenantId).eq("id", id).is("deleted_at", null).maybeSingle());
}
export async function saveBuilding(sb: SupabaseClient, tenantId: string, id: string | null, i: BuildingInput): Promise<Building> {
  if (id) return fail(await sb.from("buildings").update(buildingRow(i)).eq("id", id).select().single());
  return fail(await sb.from("buildings").insert({ tenant_id: tenantId, ...buildingRow(i) }).select().single());
}
export const deleteBuilding = (sb: SupabaseClient, id: string) => rpcDelete(sb, "delete_building", id);

// ---- 建物カルテ（1つの建物に1つ。あれば直し、なければ作る） ----
export interface KarteInput {
  entry?: string;
  key_place?: string;
  parking?: string;
  garbage_days?: string;
  manager_contact?: string;
  cautions?: string;
}
export async function getKarte(sb: SupabaseClient, buildingId: string): Promise<Karte | null> {
  return fail(await sb.from("building_profiles").select("*").eq("building_id", buildingId).is("deleted_at", null).maybeSingle());
}
export async function saveKarte(sb: SupabaseClient, tenantId: string, buildingId: string, i: KarteInput): Promise<Karte> {
  const row = {
    entry: nul(i.entry),
    key_place: nul(i.key_place),
    parking: nul(i.parking),
    garbage_days: nul(i.garbage_days),
    manager_contact: nul(i.manager_contact),
    cautions: nul(i.cautions),
  };
  const existing = await getKarte(sb, buildingId);
  if (existing) return fail(await sb.from("building_profiles").update(row).eq("id", existing.id).select().single());
  return fail(await sb.from("building_profiles").insert({ tenant_id: tenantId, building_id: buildingId, ...row }).select().single());
}

// ---- 部屋・場所 ----
export interface RoomInput {
  room_no: string;
  floor?: string;
}
export async function listRooms(sb: SupabaseClient, buildingId: string): Promise<Room[]> {
  return fail(await sb.from("rooms").select("*").eq("building_id", buildingId).is("deleted_at", null));
}
export async function saveRoom(sb: SupabaseClient, tenantId: string, buildingId: string, id: string | null, i: RoomInput): Promise<Room> {
  const row = { room_no: i.room_no.trim(), floor: int(i.floor) };
  if (id) return fail(await sb.from("rooms").update(row).eq("id", id).select().single());
  return fail(await sb.from("rooms").insert({ tenant_id: tenantId, building_id: buildingId, ...row }).select().single());
}
export async function setRoomActive(sb: SupabaseClient, id: string, active: boolean): Promise<void> {
  fail(await sb.from("rooms").update({ active }).eq("id", id).select().single());
}
export const deleteRoom = (sb: SupabaseClient, id: string) => rpcDelete(sb, "delete_room", id);

export interface AreaInput {
  name: string;
  sort?: string;
}
export async function listAreas(sb: SupabaseClient, buildingId: string): Promise<Area[]> {
  return fail(await sb.from("building_areas").select("*").eq("building_id", buildingId).is("deleted_at", null));
}
export async function saveArea(sb: SupabaseClient, tenantId: string, buildingId: string, id: string | null, i: AreaInput): Promise<Area> {
  const row = { name: i.name.trim(), sort: int(i.sort) ?? 0 };
  if (id) return fail(await sb.from("building_areas").update(row).eq("id", id).select().single());
  return fail(await sb.from("building_areas").insert({ tenant_id: tenantId, building_id: buildingId, ...row }).select().single());
}
export async function setAreaActive(sb: SupabaseClient, id: string, active: boolean): Promise<void> {
  fail(await sb.from("building_areas").update({ active }).eq("id", id).select().single());
}
export const deleteArea = (sb: SupabaseClient, id: string) => rpcDelete(sb, "delete_building_area", id);
