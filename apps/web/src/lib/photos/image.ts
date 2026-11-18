// 画像の純粋な部品（機能 008）：縮小の寸法と、JPEG の付属の情報（Exif の位置など）を消す。
// 縮小の幅は design.md の「決めたこと」：元の画像は長辺 1600px、一覧用の小さな画像は長辺 320px。

export const PHOTO_MAX_SIDE = 1600;
export const THUMB_MAX_SIDE = 320;
export const PHOTO_QUALITY = 0.8;
export const THUMB_QUALITY = 0.7;

/** 長辺が max を超えるときだけ、縦横比を保って縮める。拡大はしない */
export function fitSize(width: number, height: number, max: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// JPEG のマーカー：APP0（JFIF）は画像の読み方に要るので残す。APP1（Exif・XMP＝位置・機種・撮影者）、APP2（ICC）、
// APP3〜15、COM（コメント）は、すべて消す。SOS（画素）以降は、一字も変えない
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;

function isStandalone(m: number): boolean {
  return m === 0x01 || (m >= 0xd0 && m <= 0xd9);
}
function isDroppable(m: number): boolean {
  return (m >= 0xe1 && m <= 0xef) || m === 0xfe;
}

interface Segment {
  marker: number;
  start: number;
  end: number;
}

function segments(b: Uint8Array): { segs: Segment[]; sosAt: number } {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) throw new Error("JPEG ではありません");
  const segs: Segment[] = [];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error("JPEG が壊れています");
    while (b[i + 1] === 0xff) i++; // 詰め物
    const m = b[i + 1];
    if (m === undefined) throw new Error("JPEG が壊れています");
    if (m === SOS) return { segs, sosAt: i };
    if (m === EOI) return { segs, sosAt: -1 };
    if (isStandalone(m)) {
      segs.push({ marker: m, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (i + 4 > b.length) throw new Error("JPEG が壊れています");
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw new Error("JPEG が壊れています");
    segs.push({ marker: m, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  throw new Error("JPEG が壊れています");
}

/** 付属の情報（Exif・位置・コメントなど）が残っているか */
export function hasJpegMetadata(b: Uint8Array): boolean {
  return segments(b).segs.some((s) => isDroppable(s.marker));
}

/** 付属の情報を消した JPEG を返す（画素は変えない）。JPEG でない・壊れていれば例外 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  const { segs, sosAt } = segments(b);
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  for (const s of segs) if (!isDroppable(s.marker)) parts.push(b.subarray(s.start, s.end));
  parts.push(sosAt >= 0 ? b.subarray(sosAt) : b.subarray(b.length - 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 送る前の最後の確かめ：付属の情報が残っていたら例外（位置を外に出さない） */
export function assertCleanJpeg(b: Uint8Array): void {
  if (hasJpegMetadata(b)) throw new Error("画像に位置などの情報が残っています");
}
