// 開始・終了のときだけ位置を記録する（機能 013、R-013-18・27・28）。
// 毎回「位置を記録しますか」と尋ね、了承の選びを端末に残さない。「位置なし」「やめる」では、位置を取りに行かない。
// 常に位置を追う処理（watchPosition など）は作らない。getCurrentPosition を、了承した 1 回だけ呼ぶ。
import { isValidLatLng, type LatLng } from "./geo";

export type ConsentChoice = "with" | "without" | "cancel";

export type CaptureFailure = "unsupported" | "denied" | "timeout" | "unavailable" | "invalid";
export type CaptureResult = ({ ok: true } & LatLng) | { ok: false; reason: CaptureFailure };

/** navigator.geolocation のうち、使う部分だけ */
export interface GeoLike {
  getCurrentPosition(
    success: (p: { coords: { latitude: number; longitude: number } }) => void,
    error: (e: { code: number }) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ): void;
}

export const CAPTURE_TIMEOUT_MS = 10_000;

/** 今の位置を 1 回だけ取る。拒否・時間切れ・非対応は、失敗の理由を返す（例外にしない） */
export function captureLocation(geo: GeoLike | null | undefined, timeoutMs: number = CAPTURE_TIMEOUT_MS): Promise<CaptureResult> {
  if (!geo) return Promise.resolve({ ok: false, reason: "unsupported" });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: CaptureResult) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    // 端末が応答しないときの保険（ブラウザの timeout の指定とは別に、こちらでも切る）
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs + 1000);
    try {
      geo.getCurrentPosition(
        (p) => (isValidLatLng(p.coords.latitude, p.coords.longitude) ? finish({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude }) : finish({ ok: false, reason: "invalid" })),
        (e) => finish({ ok: false, reason: e.code === 1 ? "denied" : e.code === 3 ? "timeout" : "unavailable" }),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
      );
    } catch {
      finish({ ok: false, reason: "unavailable" });
    }
  });
}

export const CAPTURE_MESSAGES: Record<CaptureFailure, string> = {
  unsupported: "この端末では位置を取れないので、位置なしで記録しました",
  denied: "位置の使用が許可されていないので、位置なしで記録しました",
  timeout: "位置を取れなかった（時間切れ）ので、位置なしで記録しました",
  unavailable: "位置を取れなかったので、位置なしで記録しました",
  invalid: "位置を取れなかったので、位置なしで記録しました",
};

export interface Resolved {
  /** やめる：何も記録しない */
  cancelled: boolean;
  /** 付ける位置（なければ null＝位置なしで記録する） */
  pos: LatLng | null;
  /** 画面に出す補足（位置を取れなかったとき） */
  note: string | null;
}

/** 了承の選びから、付ける位置を決める。「位置なし」「やめる」では、位置を取りに行かない（R-013-27）。取れなければ位置なし（R-013-28） */
export async function resolvePosition(choice: ConsentChoice, geo: GeoLike | null | undefined, timeoutMs?: number): Promise<Resolved> {
  if (choice === "cancel") return { cancelled: true, pos: null, note: null };
  if (choice === "without") return { cancelled: false, pos: null, note: null };
  const r = await captureLocation(geo, timeoutMs);
  if (r.ok) return { cancelled: false, pos: { lat: r.lat, lng: r.lng }, note: null };
  return { cancelled: false, pos: null, note: CAPTURE_MESSAGES[r.reason] };
}
