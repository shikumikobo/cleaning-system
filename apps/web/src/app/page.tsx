"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/AuthProvider";
import { NavBoard } from "@/components/NavBoard";
import { TodayBoard } from "@/components/TodayBoard";
import { RequireAuth } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/api";
import { homeFor } from "@/lib/files/portal";

export default function Home() {
  return (
    <RequireAuth>
      <HomeBody />
    </RequireAuth>
  );
}

function HomeBody() {
  const { current } = useAuth();
  const router = useRouter();
  const portal = homeFor(current?.roleCode);
  useEffect(() => {
    if (portal) router.replace(portal); // 外部の人は専用ページへ（機能 005）
  }, [portal, router]);
  if (!current || portal) return null;
  return (
    <section>
      <h1>{current.tenantName}</h1>
      <p className="lead">あなたの役割：{ROLE_LABELS[current.roleCode]}</p>
      <TodayBoard />
      <NavBoard admin={current.roleCode === "admin"} />
    </section>
  );
}
