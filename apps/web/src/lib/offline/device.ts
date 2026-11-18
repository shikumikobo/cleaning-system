// 端末の ID：初めて使うときに uuid を作り、端末に残す（R-001-31 の「同じ端末」の元）
import { DEFAULT_DB, openDb, reqToPromise, txDone } from "./db";

export async function getDeviceId(dbName: string = DEFAULT_DB): Promise<string> {
  const db = await openDb(dbName);
  try {
    const tx = db.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    const found = (await reqToPromise(store.get("device_id"))) as { key: string; value: string } | undefined;
    if (found) {
      await txDone(tx);
      return found.value;
    }
    const value = crypto.randomUUID();
    store.put({ key: "device_id", value });
    await txDone(tx);
    return value;
  } finally {
    db.close();
  }
}
