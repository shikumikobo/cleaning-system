// 上げる順（R-005-13）：置き場所に上げてから行を作る。行を作れなかったら、上げたものを消そうとする。
import { buildStoragePath, validateFileName } from "./format";
import type { FileRowData, NewFileRow } from "./types";

export interface UploadSource {
  type: string;
  size: number;
}

export interface UploadDeps {
  newId(): string;
  /** 置き場所に上げる */
  upload(path: string, file: UploadSource): Promise<void>;
  removeObject(path: string): Promise<void>;
  insertRow(row: NewFileRow): Promise<FileRowData>;
}

export async function uploadFileFlow(
  deps: UploadDeps,
  tenantId: string,
  buildingId: string,
  file: UploadSource & { name: string },
  displayName: string,
): Promise<FileRowData> {
  const problem = validateFileName(displayName);
  if (problem) throw new Error(problem);
  const id = deps.newId();
  const path = buildStoragePath(tenantId, id, file.name);
  await deps.upload(path, file); // 上げられなければ、行は作らない
  try {
    return await deps.insertRow({
      id,
      tenant_id: tenantId,
      building_id: buildingId,
      name: displayName.trim(),
      mime: file.type || "application/octet-stream",
      size: file.size,
      storage_path: path,
    });
  } catch (e) {
    try {
      await deps.removeObject(path);
    } catch {
      // 消せなくても、掃除（猶予のあと）が拾う
    }
    throw e;
  }
}
