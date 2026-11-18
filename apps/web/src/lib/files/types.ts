// 機能 005 の行の形（data-model.md の 005 の章）
export interface FileRowData {
  id: string;
  tenant_id: string;
  building_id: string;
  request_id: string | null;
  quote_id: string | null;
  name: string;
  mime: string;
  size: number;
  storage_path: string;
  shared_external: boolean;
  created_at: string;
  deleted_at: string | null;
}

/** 行を作るときに渡すもの（作成日時などは DB が入れる） */
export type NewFileRow = Pick<FileRowData, "id" | "tenant_id" | "building_id" | "name" | "mime" | "size" | "storage_path">;
