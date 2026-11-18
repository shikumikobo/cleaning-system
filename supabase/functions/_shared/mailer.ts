// 招待のメール。試用の間は、Supabase のログインのメール（メールのリンク）で送る。
// 受け取った人がリンクを開くとログインされ、招待の鍵つきの画面（/invite/?token=…）に着く。
// 本番の前に、送信の専用のサービスに替える（この Mailer の実装だけを差し替える）。
import type { Mailer } from "./handlers.ts";

export interface OtpAuth {
  auth: {
    signInWithOtp(args: {
      email: string;
      options: { shouldCreateUser: boolean; emailRedirectTo: string };
    }): PromiseLike<{ error: { message: string } | null }>;
  };
}

export function loginLinkMailer(anon: OtpAuth, siteUrl: string): Mailer {
  const base = siteUrl.replace(/\/+$/, "");
  return {
    async sendInvitation({ email, token }) {
      const { error } = await anon.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: `${base}/invite/?token=${encodeURIComponent(token)}` },
      });
      if (error) throw new Error(error.message);
    },
  };
}
