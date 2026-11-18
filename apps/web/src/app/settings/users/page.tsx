"use client";

// 利用者の管理（管理者）：招待・役割の変更・止める／戻す・招待の取り消し・外部の人の建物。
// 権限は DB が最後に判定する。この画面は、管理者でない人には見せないだけ（R-001-12・23）。
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Flash, RequireAuth, formatDate, useAction } from "@/components/ui";
import { ROLE_CODES, ROLE_LABELS, type Invitation, type Member, type RoleCode } from "@/lib/api";

export default function UsersPage() {
  return (
    <RequireAuth adminOnly>
      <UsersBody />
    </RequireAuth>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function UsersBody() {
  const { api, current } = useAuth();
  const tenantId = current!.tenantId;
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleCode>("staff");
  const { error, notice, busy, run } = useAction();

  const reload = useCallback(async () => {
    if (!api) return;
    const [m, i] = await Promise.all([api.listMembers(tenantId), api.listInvitations(tenantId)]);
    setMembers(m);
    setInvitations(i);
  }, [api, tenantId]);

  // 会社を切り替えたら、その会社の分だけを取り直す（R-001-17）
  useEffect(() => {
    setMembers([]);
    setInvitations([]);
    void run(reload);
  }, [reload, run]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    const ok = await run(async () => {
      await api!.invite({ tenantId, email, roleCode: role });
      await reload();
    }, `${email} に招待のメールを送りました（7日間使えます）`);
    if (ok) setEmail("");
  }

  const act = (fn: () => Promise<unknown>, done: string) =>
    run(async () => {
      await fn();
      await reload();
    }, done);

  return (
    <section>
      <h1>利用者の管理</h1>
      <Flash error={error} notice={notice} />

      <h2>招待する</h2>
      <form onSubmit={invite} className="row">
        <label>
          招待するメールアドレス
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          役割
          <select value={role} onChange={(e) => setRole(e.target.value as RoleCode)}>
            {ROLE_CODES.map((c) => (
              <option key={c} value={c}>
                {ROLE_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          招待する
        </button>
      </form>

      <h2>招待中</h2>
      {invitations.length === 0 ? (
        <p className="hint">招待中の人はいません</p>
      ) : (
        <ul className="list" aria-label="招待中の一覧">
          {invitations.map((i) => (
            <li key={i.id}>
              <span>
                {i.email}（{ROLE_LABELS[i.roleCode]}）、期限：{formatDate(i.expiresAt)}
              </span>
              <button type="button" disabled={busy} onClick={() => void act(() => api!.revokeInvitation(i.id), `${i.email} の招待を取り消しました`)}>
                取り消し
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2>利用者</h2>
      <ul className="list" aria-label="利用者の一覧">
        {members.map((m) => (
          <MemberRow key={m.id} m={m} tenantId={tenantId} busy={busy} act={act} />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({
  m,
  tenantId,
  busy,
  act,
}: {
  m: Member;
  tenantId: string;
  busy: boolean;
  act: (fn: () => Promise<unknown>, done: string) => Promise<boolean>;
}) {
  const { api, userId } = useAuth();
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState("");
  const { error, run } = useAction();
  const name = m.displayName ?? "（名前を見られない人）";
  const suspended = m.status === "suspended";

  async function toggleBuildings() {
    if (!open) {
      const cur = await api!.getBuildings(tenantId, m.id).catch(() => []);
      setIds(cur.join("\n"));
    }
    setOpen(!open);
  }
  async function saveBuildings() {
    const list = ids.split(/[\s,、]+/).filter(Boolean);
    if (list.some((x) => !UUID.test(x))) {
      await run(async () => {
        throw { code: "22023", message: "建物の ID の形が正しくありません" };
      });
      return;
    }
    await act(() => api!.setBuildings(m.id, list), `${name} が見られる建物を決めました`);
  }

  return (
    <li className={suspended ? "suspended" : undefined}>
      <div className="member-line">
        <strong>{name}</strong>
        {m.userId === userId && <span className="hint">（あなた）</span>}
        {suspended && <span className="badge">止めています</span>}
        <select
            aria-label={`${name} の役割`}
            value={m.roleCode}
            disabled={busy}
            onChange={(e) => void act(() => api!.changeRole(m.id, e.target.value as RoleCode), `${name} の役割を ${ROLE_LABELS[e.target.value as RoleCode]} にしました`)}
          >
            {ROLE_CODES.map((c) => (
              <option key={c} value={c}>
                {ROLE_LABELS[c]}
              </option>
            ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => api!.setStatus(m.id, suspended ? "active" : "suspended"), suspended ? `${name} を戻しました` : `${name} を止めました`)}
          aria-label={`${name} を${suspended ? "戻す" : "止める"}`}
        >
          {suspended ? "戻す" : "止める"}
        </button>
        {m.roleCode === "external" && (
          <button type="button" onClick={() => void toggleBuildings()} aria-label={`${name} の建物を決める`}>
            建物を決める
          </button>
        )}
      </div>
      {open && (
        <div className="stack">
          <label>
            見られる建物の ID（1行に1つ。建物の登録は機能 002 で作ります）
            <textarea rows={3} value={ids} onChange={(e) => setIds(e.target.value)} />
          </label>
          <button type="button" disabled={busy} onClick={() => void saveBuildings()}>
            建物を保存
          </button>
          <Flash error={error} />
        </div>
      )}
    </li>
  );
}
