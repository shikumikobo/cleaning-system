// 撮った画像を、端末で、元の画像（長辺 1600px）と小さな画像（長辺 320px）にする（機能 008）。
// 作り直す（canvas に描いて JPEG にする）ので、Exif は入らない。そのうえで、付属の情報が残っていないことを確かめてから返す。
import { assertCleanJpeg, fitSize, PHOTO_MAX_SIDE, PHOTO_QUALITY, stripJpegMetadata, THUMB_MAX_SIDE, THUMB_QUALITY } from "./image";

/** 画像を読み、指定の寸法の JPEG にする口（ブラウザでは canvas。単体のテストでは偽物） */
export interface Renderer {
  open(file: Blob): Promise<{ width: number; height: number }>;
  encode(width: number, height: number, quality: number): Promise<Uint8Array>;
}

export interface ProcessedPhoto {
  photo: ArrayBuffer;
  thumb: ArrayBuffer;
  width: number;
  height: number;
  bytes: number;
  thumbWidth: number;
  thumbHeight: number;
}

function toBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export async function processPhotoWith(r: Renderer, file: Blob): Promise<ProcessedPhoto> {
  const src = await r.open(file);
  const big = fitSize(src.width, src.height, PHOTO_MAX_SIDE);
  const small = fitSize(src.width, src.height, THUMB_MAX_SIDE);
  const photo = stripJpegMetadata(await r.encode(big.width, big.height, PHOTO_QUALITY));
  const thumb = stripJpegMetadata(await r.encode(small.width, small.height, THUMB_QUALITY));
  assertCleanJpeg(photo);
  assertCleanJpeg(thumb);
  return {
    photo: toBuffer(photo),
    thumb: toBuffer(thumb),
    width: big.width,
    height: big.height,
    bytes: photo.length,
    thumbWidth: small.width,
    thumbHeight: small.height,
  };
}

/** ブラウザの口：向き（回転）を反映して読み、canvas に描いて JPEG にする */
export function browserRenderer(): Renderer {
  let bmp: ImageBitmap | null = null;
  return {
    async open(file) {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { width: bmp.width, height: bmp.height };
    },
    async encode(width, height, quality) {
      if (!bmp) throw new Error("画像を読んでいません");
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("画像を作れませんでした");
      ctx.drawImage(bmp, 0, 0, width, height);
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) throw new Error("画像を作れませんでした");
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

export function processPhoto(file: Blob): Promise<ProcessedPhoto> {
  return processPhotoWith(browserRenderer(), file);
}
