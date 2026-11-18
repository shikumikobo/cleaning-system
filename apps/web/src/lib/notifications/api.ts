// DB との口（機能 015）。権限は DB が守る。ここは、画面が使う問い合わせの形だけ。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Channel, Kind, Setting } from "./kinds";
import type { RegisterPayload } from "./push";

/** 既読にしたとき、ヘッダーの鈴の件数を取り直させる合図（画面の中の連絡だけ。データは運ばない） */
export const NOTIFICATIONS_CHANGED = "cleaning:notifications-changed";
export function announceNotificationsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
}

export interface Subscription {
  id: string;
  endpoint: string;
  device_label: string | null;
}

export interface NotificationsApi {
  listKinds(): Promise<Kind[]>;
  listSettings(membershipId: string): Promise<Setting[]>;
  saveSetting(tenantId: string, membershipId: string, kind: string, channel: Channel, enabled: boolean): Promise<void>;
  /** 一覧（channel = app の行）。新しい順 */
  listNotifications(membershipId: string, limit?: number): Promise<NotificationItem[]>;
  unreadCount(membershipId: string): Promise<number>;
  markRead(ids: string[]): Promise<void>;
  markAllRead(membershipId: string): Promise<void>;
  registerPush(tenantId: string, payload: RegisterPayload): Promise<void>;
  removePush(endpoint: string): Promise<void>;
  listMySubscriptions(membershipId: string): Promise<Subscription[]>;
}

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export function createNotificationsApi(db: SupabaseClient): NotificationsApi {
  return {
    async listKinds() {
      return check(await db.from("notification_kinds").select("code, name, default_push, default_email, required_perm, sort").order("sort")) as Kind[];
    },
    async listSettings(membershipId) {
      return check(
        await db.from("notification_settings").select("kind, channel, enabled").eq("membership_id", membershipId).is("deleted_at", null),
      ) as Setting[];
    },
    async saveSetting(tenantId, membershipId, kind, channel, enabled) {
      check(
        await db.from("notification_settings").upsert(
          { tenant_id: tenantId, membership_id: membershipId, kind, channel, enabled, deleted_at: null },
          { onConflict: "tenant_id,membership_id,kind,channel" },
        ),
      );
    },
    async listNotifications(membershipId, limit = 50) {
      return check(
        await db
          .from("notifications")
          .select("id, kind, title, body, link, created_at, read_at")
          .eq("membership_id", membershipId)
          .eq("channel", "app")
          .order("created_at", { ascending: false })
          .limit(limit),
      ) as NotificationItem[];
    },
    async unreadCount(membershipId) {
      const r = await db
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("membership_id", membershipId)
        .eq("channel", "app")
        .is("read_at", null);
      if (r.error) throw new Error(r.error.message);
      return r.count ?? 0;
    },
    async markRead(ids) {
      if (ids.length === 0) return;
      check(await db.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids).is("read_at", null));
    },
    async markAllRead(membershipId) {
      check(
        await db.from("notifications").update({ read_at: new Date().toISOString() }).eq("membership_id", membershipId).eq("channel", "app").is("read_at", null),
      );
    },
    async registerPush(tenantId, p) {
      check(
        await db.rpc("register_push_subscription", {
          p_tenant: tenantId,
          p_endpoint: p.endpoint,
          p_p256dh: p.p256dh,
          p_auth: p.auth,
          p_label: p.label,
        }),
      );
    },
    async removePush(endpoint) {
      check(await db.from("push_subscriptions").update({ deleted_at: new Date().toISOString() }).eq("endpoint", endpoint).is("deleted_at", null));
    },
    async listMySubscriptions(membershipId) {
      return check(
        await db.from("push_subscriptions").select("id, endpoint, device_label").eq("membership_id", membershipId).is("deleted_at", null),
      ) as Subscription[];
    },
  };
}
