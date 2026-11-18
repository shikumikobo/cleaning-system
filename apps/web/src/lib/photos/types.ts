// 機能 008 の行の形（data-model.md の 008 の章・supabase/migrations/20261119020000_photos.sql）
export type PhotoKind = "before" | "after" | "observation";

export interface PhotoRow {
  id: string;
  tenant_id: string;
  building_id: string;
  area_id: string | null;
  room_id: string | null;
  work_id: string | null;
  report_item_id: string | null;
  request_id: string | null;
  kind: PhotoKind;
  /** 端末で撮った時刻 */
  taken_at: string;
  /** 撮った人（所属の id） */
  taken_by: string;
  storage_path: string;
  thumb_path: string;
  width: number;
  height: number;
  bytes: number;
  /** 届いた時刻 */
  created_at: string;
  deleted_at: string | null;
}

/** 端末から送る行（届いた時刻・作った人などは DB が入れる） */
export interface NewPhotoRow {
  id: string;
  tenant_id: string;
  building_id: string;
  area_id?: string | null;
  room_id?: string | null;
  /** 作業（010）と報告書の項目（009）。報告書の項目つきの写真は、項目の行が届いてから送る */
  work_id?: string | null;
  report_item_id?: string | null;
  request_id?: string | null;
  kind: PhotoKind;
  taken_at: string;
  taken_by: string;
  storage_path: string;
  thumb_path: string;
  width: number;
  height: number;
  bytes: number;
}
