-- 機能 015：お知らせを作る共通の関数（R-015-2・9〜15）
begin;
select * from no_plan();
select tests.seed();

-- 呼ぶのは、後の機能の RPC（security definer）の中。ここでは持ち主の権限で直接呼ぶ
create or replace function pg_temp.channels(p_dedupe text) returns text language sql as $$
  select coalesce(string_agg(channel, ',' order by channel), '') from public.notifications where dedupe_key = p_dedupe
$$;

-- 種類の初めの値で受け取る（R-015-2）：work_tomorrow は通知が入、メールが切。staffA は端末を持つ
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '明日の作業', '10:00 に A ビル', '/works/5', 'd1'), 2,
          'R-015-9 出来事が呼ぶと、一覧の行と通知の行の2つを作る');
select is(pg_temp.channels('d1'), 'app,push', 'R-015-2 設定がなければ種類の初めの値（通知は入・メールは切）で作る');
select is((select status from public.notifications where dedupe_key = 'd1' and channel = 'push'), 'pending', 'R-015-9 通知の行は「送る前」で作る');
select is((select status from public.notifications where dedupe_key = 'd1' and channel = 'app'), 'sent', 'R-015-9 一覧の行は、作るとき「送った」');
select ok((select sent_at is not null from public.notifications where dedupe_key = 'd1' and channel = 'app'), 'R-015-9 一覧の行には送った時刻が入る');
select is((select title || '/' || body || '/' || link || '/' || membership_id::text || '/' || tenant_id::text from public.notifications where dedupe_key = 'd1' and channel = 'push'),
          '明日の作業/10:00 に A ビル//works/5/' || tests.id('m:A:staffA')::text || '/' || tests.t('A')::text, 'R-015-9 題名・本文・リンク・受け取る人・会社が入る');
select is((select count(*)::int from public.notifications where dedupe_key = 'd1' and read_at is null), 2, 'R-015-9 作ったときは未読');

-- 種類の初めの値（メールが入の種類）と、端末がない人（R-015-11）：memberA は端末を持たない。quote_approved はメールも入
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:memberA'), 'quote_approved', '見積が承認されました', null, '/quotes/1', 'd2'), 2,
          'R-015-11 端末のない人には、通知の行を作らない（一覧とメールの2つ）');
select is(pg_temp.channels('d2'), 'app,email', 'R-015-2 メールが入の種類は、メールの行も作る');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:memberA'), 'work_tomorrow', '明日', null, null, 'd3'), 1, 'R-015-11 端末がなく、メールが切なら、一覧の行だけ');
select is(pg_temp.channels('d3'), 'app', 'R-015-11 一覧の行は常にある');
select is((select count(*)::int from public.notifications where dedupe_key = 'd3' and link is null and body is null), 1, 'R-015-9 本文とリンクは空でもよい');

-- 本人が切っている手段は作らない（R-015-10）：staffA は work_changed の通知を切っている
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_changed', '予定の変更', null, '/works/7', 'd4'), 1, 'R-015-10 通知を切っているならば、通知の行を作らない');
select is(pg_temp.channels('d4'), 'app', 'R-015-10 一覧の行は、設定にかかわらず作る');
-- 本人がメールを入にしたら作る
insert into public.notification_settings (tenant_id, membership_id, kind, channel, enabled) values (tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', 'email', true);
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '明日の作業2', null, '/works/6', 'd5'), 3, 'R-015-10 メールを入にした人には、通知もメールも作る');
select is(pg_temp.channels('d5'), 'app,email,push', 'R-015-10 本人の設定が初めの値より先に効く');
-- 本人が初めの値と逆にする（通知を切る）
insert into public.notification_settings (tenant_id, membership_id, kind, channel, enabled) values (tests.t('A'), tests.id('m:A:memberA'), 'quote_approved', 'email', false);
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:memberA'), 'quote_approved', '見積2', null, '/quotes/2', 'd6'), 1, 'R-015-10 メールを切っているならば、メールの行を作らない');
-- 外した端末は数えない
update public.push_subscriptions set deleted_at = now() where id = tests.id('psA-staff');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '外した後', null, null, 'd7'), 2, 'R-015-11 端末の登録を外した人には、通知の行を作らない（一覧とメール）');
select is(pg_temp.channels('d7'), 'app,email', 'R-015-11 外した端末には送らない');
update public.push_subscriptions set deleted_at = null where id = tests.id('psA-staff');

-- 作らない相手（R-015-12）
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'quote_approved', '金額の知らせ', null, '/quotes/1', 'd8'), 0, 'R-015-12 その種類に要る権限（amount.read）を持たない人には作らない');
select is((select count(*)::int from public.notifications where dedupe_key = 'd8'), 0, 'R-015-12 一覧の行も作らない');
select tests.make_user('susp');
select tests.make_member('A', 'susp', 'member', 'suspended');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:susp'), 'work_tomorrow', '止めた人', null, null, 'd9'), 0, 'R-015-12 止められた人には作らない');
select is(app.enqueue_notification(tests.t('B'), tests.id('m:A:staffA'), 'work_tomorrow', '別の会社', null, null, 'd10'), 0, 'R-015-12 渡された会社の所属でない人には作らない（会社 B・A の所属）');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:B:staffB'), 'work_tomorrow', '別の会社', null, null, 'd11'), 0, 'R-015-12 渡された会社の所属でない人には作らない（会社 A・B の所属）');
select is((select count(*)::int from public.notifications where dedupe_key in ('d9', 'd10', 'd11')), 0, 'R-015-12 別の会社にも、止めた人にも、1行も作らない');
select is(app.enqueue_notification(tests.t('A'), gen_random_uuid(), 'work_tomorrow', '知らない所属', null, null, 'd12'), 0, 'R-015-12 知らない所属には作らない');
update public.memberships set deleted_at = now() where id = tests.id('m:A:memberA');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:memberA'), 'work_tomorrow', '消した所属', null, null, 'd13'), 0, 'R-015-12 消した所属には作らない');
update public.memberships set deleted_at = null where id = tests.id('m:A:memberA');

-- 重複の印（R-015-13）
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '重複', null, null, 'dup'), 3, 'R-015-13 初めての重複の印は作る');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '重複', null, null, 'dup'), 0, 'R-015-13 同じ印の二度目は何も作らない');
select is((select count(*)::int from public.notifications where dedupe_key = 'dup' and membership_id = tests.id('m:A:staffA')), 3, 'R-015-13 行は増えない（一覧・通知・メールの3つのまま）');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:memberA'), 'work_tomorrow', '別の人', null, null, 'dup'), 1, 'R-015-13 同じ印でも、別の人には作る');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '印なし', null, null), 3, 'R-015-13 印がなければ、毎回作る');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '印なし', null, null), 3, 'R-015-13 印がなければ、二度目も作る');

-- 断る（R-015-14）
select is(tests.run_as_role('postgres', '{}', format('select app.enqueue_notification(%L, %L, ''nokind'', ''x'', null, null)', tests.t('A'), tests.id('m:A:staffA'))) ->> 'error', '22023', 'R-015-14 知らない種類は断る');
select is(tests.run_as_role('postgres', '{}', format('select app.enqueue_notification(%L, %L, ''work_tomorrow'', ''x'', null, ''https://evil.example/x'')', tests.t('A'), tests.id('m:A:staffA'))) ->> 'error', '22023', 'R-015-14 外のリンクは断る');
select is(tests.run_as_role('postgres', '{}', format('select app.enqueue_notification(%L, %L, ''work_tomorrow'', ''x'', null, ''//evil.example/x'')', tests.t('A'), tests.id('m:A:staffA'))) ->> 'error', '22023', 'R-015-14 // で始まるリンクは断る');
select is(tests.run_as_role('postgres', '{}', format('select app.enqueue_notification(%L, %L, ''work_tomorrow'', ''x'', null, ''javascript:alert(1)'')', tests.t('A'), tests.id('m:A:staffA'))) ->> 'error', '22023', 'R-015-14 / で始まらないリンクは断る');
select is(tests.run_as_role('postgres', '{}', format('select app.enqueue_notification(%L, %L, ''work_tomorrow'', '''', null, null)', tests.t('A'), tests.id('m:A:staffA'))) ->> 'error', '22023', 'R-015-14 題名が空なら断る');
select is((select count(*)::int from public.notifications where title = 'x'), 0, 'R-015-14 断ったときは1行も作らない');

-- 呼べる人（R-015-15）
select is(tests.err(tests.u('staffA'), format('select app.enqueue_notification(%L, %L, ''work_tomorrow'', ''x'', null, null)', tests.t('A'), tests.id('m:A:staffA'))), '42501', 'R-015-15 ログインした人は、共通の関数を呼べない');
select is(tests.err(tests.u('adminA'), format('select public.enqueue_notification(%L, %L, ''work_tomorrow'', ''x'', null, null, null, null)', tests.t('A'), tests.id('m:A:staffA'))), '42501', 'R-015-15 管理者も、公開の関数を呼べない');
select is(tests.run_as_anon(format('select public.enqueue_notification(%L, %L, ''work_tomorrow'', ''x'', null, null, null, null)', tests.t('A'), tests.id('m:A:staffA'))) ->> 'error', '42501', 'R-015-15 ログインしていない人は呼べない');
select is(tests.run_as_service(format('select public.enqueue_notification(%L, %L, ''work_tomorrow'', ''定時'', null, ''/works/1'', ''svc1'', null) as n', tests.t('A'), tests.id('m:A:staffA'))) -> 'rows' -> 0 ->> 'n', '3', 'R-015-15 定時の処理（service_role）は呼べる');
select is(tests.run_as_service(format('select public.enqueue_notification(%L, %L, ''work_tomorrow'', ''他社'', null, ''/works/1'', ''svc2'', null) as n', tests.t('B'), tests.id('m:A:staffA'))) -> 'rows' -> 0 ->> 'n', '0', 'R-015-15 定時の処理も、別の会社の所属には作らない');
select is((select count(*)::int from public.notifications where tenant_id = tests.t('B') and dedupe_key like 'svc%'), 0, 'R-015-15 定時の処理が、別の会社の行を作らない');

-- 処理の記録（run_id）は、渡せば残る
insert into public.job_runs (id, tenant_id, kind, status) values (tests.id('runA-x'), tests.t('A'), 'daily_x', 'success');
select is(app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '処理から', null, null, 'withrun', tests.id('runA-x')), 3, 'R-015-9 処理の記録の ID を渡せる');
select is((select count(*)::int from public.notifications where dedupe_key = 'withrun' and run_id = tests.id('runA-x')), 3, 'R-015-9 作った行から、処理の記録をたどれる');
select is(tests.run_as_role('postgres', '{}', format('select app.enqueue_notification(%L, %L, ''work_tomorrow'', ''他社の記録'', null, null, ''badrun'', %L)', tests.t('A'), tests.id('m:A:staffA'), tests.id('jobB'))) ->> 'error', '23503', 'R-015-12 別の会社の処理の記録は結べない');

select * from finish();
rollback;
