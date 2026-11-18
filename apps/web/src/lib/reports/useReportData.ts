"use client";

// 確認・提出の画面と印刷の画面が使う、報告書 1 件の読み込み（報告書・項目・作業・建物の名前・写真と期限つきの URL）
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { describeError } from "../errors";
import { getBuilding } from "../masters/repo";
import { listPhotos, signPhotoUrls } from "../photos/repo";
import type { PhotoRow } from "../photos/types";
import { getReport, getWork, listReportItems, type WorkRef } from "./repo";
import type { ReportItemRow, ReportRow } from "./types";

export interface ReportData {
  report: ReportRow;
  work: WorkRef | null;
  building: string;
  items: ReportItemRow[];
  photos: PhotoRow[];
  /** 写真の id → 期限つきの URL */
  urls: Record<string, string>;
}

export function useReportData(ctx: { sb: SupabaseClient; tenantId: string } | null, id: string, variant: "thumb" | "original") {
  const [data, setData] = useState<ReportData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ctx || !id) return;
    try {
      const report = await getReport(ctx.sb, ctx.tenantId, id);
      if (!report) {
        setMsg("報告書が見つかりません（消されたか、見る権限がありません）");
        return;
      }
      const [work, items] = await Promise.all([getWork(ctx.sb, ctx.tenantId, report.work_id), listReportItems(ctx.sb, ctx.tenantId, report.id)]);
      const [b, photos] = await Promise.all([
        work ? getBuilding(ctx.sb, ctx.tenantId, work.building_id) : Promise.resolve(null),
        listPhotos(ctx.sb, ctx.tenantId, { work: report.work_id }),
      ]);
      const urls = photos.length > 0 ? (await signPhotoUrls(ctx.sb, photos.map((p) => p.id), variant)).urls : {};
      setData({ report, work, building: b?.name ?? "", items, photos, urls });
      setMsg(null);
    } catch (e) {
      setMsg(describeError(e));
    }
  }, [ctx, id, variant]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, msg, setMsg, reload };
}
