-- 機能 015：お知らせの権限（R-015-1〜8・16・17）。本人だけが読み書きできる
begin;
select * from no_plan();
select tests.seed();

-- 種類の一覧（R-015-1）
select ok(tests.n(tests.u('staffA'), 'select 1 from public.notification_kinds') >= 6, 'R-015-1 ログインした人は、種類の一覧を読める（6つ以上）');
select is((select string_agg(code, ',' order by code) from public.notification_kinds where code in ('work_changed', 'work_tomorrow', 'request_due', 'report_missing', 'quote_approved', 'invoice_overdue')),
          'invoice_overdue,quote_approved,report_missing,request_due,work_changed,work_tomorrow', 'R-015-1 波 6 の6つの種類が初めから載っている');
select is(tests.run_as_anon('select 1 from public.notification_kinds') ->> 'error', '42501', 'R-015-1 ログインしていない人は、種類の一覧を読めない');
select is(tests.err(tests.u('adminA'), 'insert into public.notification_kinds (code, name, default_push, default_email) values (''x'', ''x'', true, true)'), '42501',
          'R-015-1 管理者でも、画面から種類を足せない');
select is(tests.err(tests.u('adminA'), 'update public.notification_kinds set default_push = false'), '42501', 'R-015-1 画面から種類を直せない');
select is((select required_perm from public.notification_kinds where code = 'quote_approved'), 'amount.read', 'R-015-1 見積の承認は金額を見る権限が要る');

-- 設定を本人が保存する（R-015-3）
select is(tests.cnt(tests.u('staffA'), format('insert into public.notification_settings (tenant_id, membership_id, kind, channel, enabled) values (%L, %L, ''work_tomorrow'', ''push'', false)', tests.t('A'), tests.id('m:A:staffA'))),
          1::bigint, 'R-015-3 本人が設定を保存できる');
select is(tests.cnt(tests.u('staffA'), format('insert into public.notification_settings (tenant_id, membership_id, kind, channel, enabled) values (%L, %L, ''work_tomorrow'', ''push'', true) on conflict (tenant_id, membership_id, kind, channel) do update set enabled = excluded.enabled', tests.t('A'), tests.id('m:A:staffA'))),
          1::bigint, 'R-015-3 同じ種類・手段は、上書きで直せる');
select is((select count(*)::int from public.notification_settings where membership_id = tests.id('m:A:staffA') and kind = 'work_tomorrow' and channel = 'push'), 1, 'R-015-3 同じ種類・手段の設定は1つだけ');
select is((select enabled from public.notification_settings where membership_id = tests.id('m:A:staffA') and kind = 'work_tomorrow' and channel = 'push'), true, 'R-015-3 上書きした値が残る');
select is(tests.err(tests.u('staffA'), format('insert into public.notification_settings (tenant_id, membership_id, kind, channel, enabled) values (%L, %L, ''work_tomorrow'', ''push'', true)', tests.t('A'), tests.id('m:A:staffA'))),
          '23505', 'R-015-3 同じ種類・手段を重ねて作れない');
select is(tests.err(tests.u('staffA'), format('insert into public.notification_settings (tenant_id, membership_id, kind, channel, enabled) values (%L, %L, ''nokind'', ''push'', true)', tests.t('A'), tests.id('m:A:staffA'))),
          '23503', 'R-015-3 知らない種類の設定は作れない');
select is(tests.err(tests.u('staffA'), format('insert into public.notification_settings (tenant_id, membership_id, kind, channel, enabled) values (%L, %L, ''request_due'', ''sms'', true)', tests.t('A'), tests.id('m:A:staffA'))),
          '23514', 'R-015-3 手段は通知とメールだけ');
select is(tests.err(tests.u('staffA'), format('insert into public.notification_settings (tenant_id, membership_id, kind, channel, enabled) values (%L, %L, ''request_due'', ''push'', true)', tests.t('A'), tests.id('m:A:memberA'))),
          '42501', 'R-015-3 ほかの人の分の設定は作れない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.notification_settings'), 2::bigint, 'R-015-3 本人は自分の設定を読める（種の1件と今作った1件）');

-- 本人以外には、読ませず・書かせない（R-015-4）
select is(tests.n(tests.u('adminA'), 'select 1 from public.notification_settings'), 0::bigint, 'R-015-4 管理者は、ほかの人の設定を読めない');
select is(tests.n(tests.u('memberA'), format('select 1 from public.notification_settings where membership_id = %L', tests.id('m:A:staffA'))), 0::bigint, 'R-015-4 work.assign を持つ社員も、スタッフの設定を読めない');
select is(tests.n(tests.u('staffA'), format('select 1 from public.notification_settings where membership_id = %L', tests.id('m:A:memberA'))), 0::bigint, 'R-015-4 スタッフは、社員の設定を読めない');
select is(tests.n(tests.u('adminA'), 'select 1 from public.push_subscriptions'), 0::bigint, 'R-015-4 管理者は、ほかの人の端末の登録を読めない');
select is(tests.n(tests.u('memberA'), format('select 1 from public.notifications where membership_id <> %L', tests.id('m:A:memberA'))), 0::bigint, 'R-015-4 work.assign を持つ人も、ほかの人のお知らせを読めない');
select is(tests.n(tests.u('adminA'), format('select 1 from public.notifications where membership_id = %L', tests.id('m:A:staffA'))), 0::bigint, 'R-015-4 管理者は、スタッフのお知らせを読めない');
select is(tests.n(tests.u('staffA'), 'select 1 from public.notifications'), 2::bigint, 'R-015-4 本人は自分のお知らせを読める');
select is(tests.n(tests.u('staffA'), 'select 1 from public.push_subscriptions'), 1::bigint, 'R-015-4 本人は自分の端末の登録を読める');
select is(tests.n(tests.u('staffB'), format('select 1 from public.notifications where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-015-4 別の会社の人は、お知らせを読めない');
select is(tests.n(tests.u('multi'), format('select 1 from public.notifications where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-015-4 2つの会社に入っている人も、会社 A の別の人のお知らせを読めない');
select is(tests.run_as_anon('select 1 from public.notifications') ->> 'error', '42501', 'R-015-4 ログインしていない人は、お知らせを読めない');
select is(tests.run_as_anon('select 1 from public.notification_settings') ->> 'error', '42501', 'R-015-4 ログインしていない人は、設定を読めない');
select is(tests.run_as_anon('select 1 from public.push_subscriptions') ->> 'error', '42501', 'R-015-4 ログインしていない人は、端末の登録を読めない');
select is(tests.cnt(tests.u('adminA'), format('update public.notification_settings set enabled = true where id = %L', tests.id('nsA-staff'))), 0::bigint, 'R-015-4 管理者は、ほかの人の設定を直せない');
select is(tests.cnt(tests.u('adminA'), format('update public.notifications set read_at = now() where id = %L', tests.id('ntA-1'))), 0::bigint, 'R-015-4 管理者は、ほかの人のお知らせを既読にできない');
select is(tests.cnt(tests.u('adminA'), format('update public.push_subscriptions set deleted_at = now() where id = %L', tests.id('psA-staff'))), 0::bigint, 'R-015-4 管理者は、ほかの人の端末の登録を外せない');
select is(tests.n(tests.u('extA'), 'select 1 from public.notifications'), 0::bigint, 'R-015-4 外部の人は、他人のお知らせを読めない');

-- 運営は、許可の間だけ読める。書けない
insert into public.support_access_grants (id, tenant_id, granted_by, reason, starts_at, ends_at)
values (tests.id('grantA-ntf'), tests.t('A'), tests.u('adminA'), '問い合わせ', now() - interval '1 hour', now() + interval '1 hour');
select is(tests.n(tests.u('operator'), format('select 1 from public.notifications where tenant_id = %L', tests.t('A'))), 3::bigint, 'R-015-4 許可の間、運営は A のお知らせを読める');
select is(tests.cnt(tests.u('operator'), format('update public.notifications set read_at = now() where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-015-4 許可の間も、運営は書けない');
select is(tests.n(tests.u('operator'), format('select 1 from public.notifications where tenant_id = %L', tests.t('B'))), 0::bigint, 'R-015-4 許可のない B のお知らせは、運営も読めない');
update public.support_access_grants set revoked_at = now() where id = tests.id('grantA-ntf');
select is(tests.n(tests.u('operator'), format('select 1 from public.notifications where tenant_id = %L', tests.t('A'))), 0::bigint, 'R-015-4 取り消したら、運営は読めない');

-- 端末の登録（R-015-5〜8）
select is(tests.run_as(tests.u('staffA'), format('select public.register_push_subscription(%L, ''https://push.example.test/dev1'', ''k1'', ''a1'', ''Pixel'') as id', tests.t('A'))) -> 'rows' -> 0 ->> 'id' is not null, true,
          'R-015-5 本人が端末を登録できる（登録の ID が返る）');
select is((select count(*)::int from public.push_subscriptions where membership_id = tests.id('m:A:staffA') and endpoint = 'https://push.example.test/dev1' and deleted_at is null), 1, 'R-015-5 本人の端末として保存される');
select is((select device_label || '/' || p256dh || '/' || auth from public.push_subscriptions where endpoint = 'https://push.example.test/dev1'), 'Pixel/k1/a1', 'R-015-5 端末の名前と鍵が保存される');
select is(tests.run_as(tests.u('staffA'), format('select public.register_push_subscription(%L, ''https://push.example.test/dev1'', ''k2'', ''a2'', ''Pixel 2'') as id', tests.t('A'))) -> 'rows' -> 0 ->> 'id' is not null, true,
          'R-015-5 同じ端末をもう一度登録できる');
select is((select count(*)::int from public.push_subscriptions where membership_id = tests.id('m:A:staffA') and endpoint = 'https://push.example.test/dev1'), 1, 'R-015-5 同じ端末は1件のまま');
select is((select p256dh from public.push_subscriptions where endpoint = 'https://push.example.test/dev1'), 'k2', 'R-015-5 二度目の鍵で更新される');
select is(tests.err(tests.u('staffA'), format('insert into public.push_subscriptions (tenant_id, membership_id, endpoint, p256dh, auth) values (%L, %L, ''https://push.example.test/direct'', ''k'', ''a'')', tests.t('A'), tests.id('m:A:staffA'))),
          '42501', 'R-015-5 画面から直接は登録できない（登録の関数だけ）');
select is(tests.err(tests.u('staffB'), format('select public.register_push_subscription(%L, ''https://push.example.test/x'', ''k'', ''a'', null)', tests.t('A'))), '42501', 'R-015-5 別の会社の人は、その会社の所属として登録できない');
select is(tests.run_as_anon(format('select public.register_push_subscription(%L, ''https://push.example.test/x'', ''k'', ''a'', null)', tests.t('A'))) ->> 'error', '42501', 'R-015-5 ログインしていない人は登録できない');

select is(tests.run_as(tests.u('memberA'), format('select public.register_push_subscription(%L, ''https://push.example.test/dev1'', ''k3'', ''a3'', ''共用'') as id', tests.t('A'))) -> 'rows' -> 0 ->> 'id' is not null, true,
          'R-015-6 同じ端末を別の人が登録できる');
select is((select count(*)::int from public.push_subscriptions where endpoint = 'https://push.example.test/dev1'), 1, 'R-015-6 前の人の登録は消え、1件だけ残る');
select is((select membership_id from public.push_subscriptions where endpoint = 'https://push.example.test/dev1'), tests.id('m:A:memberA'), 'R-015-6 残るのは新しい人の登録');
select is(tests.n(tests.u('staffA'), 'select 1 from public.push_subscriptions where endpoint = ''https://push.example.test/dev1'''), 0::bigint, 'R-015-6 前の人は、その端末の登録を持たない');

select is(tests.err(tests.u('staffA'), format('select public.register_push_subscription(%L, ''http://push.example.test/insecure'', ''k'', ''a'', null)', tests.t('A'))), '23514', 'R-015-8 https でない送り先は断る');
select is(tests.err(tests.u('staffA'), format('select public.register_push_subscription(%L, ''javascript:alert(1)'', ''k'', ''a'', null)', tests.t('A'))), '23514', 'R-015-8 https 以外の形は断る');

-- 外す（R-015-7）
select is(tests.cnt(tests.u('staffA'), format('update public.push_subscriptions set deleted_at = now() where id = %L', tests.id('psA-staff'))), 1::bigint, 'R-015-7 本人が端末の登録を外せる');
select ok((select deleted_at is not null from public.push_subscriptions where id = tests.id('psA-staff')), 'R-015-7 外した印が残る');
select is(tests.err(tests.u('staffA'), format('update public.push_subscriptions set endpoint = ''https://push.example.test/evil'' where id = %L', tests.id('psA-staff'))), '42501', 'R-015-7 送り先は、画面から書き換えられない');
select is(tests.err(tests.u('staffA'), format('update public.push_subscriptions set p256dh = ''x'' where id = %L', tests.id('psA-staff'))), '42501', 'R-015-7 鍵は画面から書き換えられない');

-- 既読（R-015-16）と書き換えの禁止（R-015-17）
select is(tests.cnt(tests.u('staffA'), format('update public.notifications set read_at = now() where id = %L', tests.id('ntA-1'))), 1::bigint, 'R-015-16 本人がお知らせを既読にできる');
select ok((select read_at is not null from public.notifications where id = tests.id('ntA-1')), 'R-015-16 既読の時刻が残る');
select is(tests.n(tests.u('staffA'), 'select 1 from public.notifications where read_at is null'), 1::bigint, 'R-015-16 未読の件数を数えられる（残りは1件）');
select is((select string_agg(title, ',' order by created_at desc) from public.notifications where membership_id = tests.id('m:A:staffA')), '明日の作業,予定が変わりました', 'R-015-16 新しい順に並べられる');
select is(tests.err(tests.u('staffA'), format('update public.notifications set title = ''書き換え'' where id = %L', tests.id('ntA-1'))), '42501', 'R-015-17 題名は画面から書き換えられない');
select is(tests.err(tests.u('staffA'), format('update public.notifications set status = ''failed'' where id = %L', tests.id('ntA-1'))), '42501', 'R-015-17 状況は画面から書き換えられない');
select is(tests.err(tests.u('staffA'), format('update public.notifications set link = ''/x'' where id = %L', tests.id('ntA-1'))), '42501', 'R-015-17 リンクは画面から書き換えられない');
select is(tests.err(tests.u('staffA'), format('insert into public.notifications (tenant_id, membership_id, kind, title, channel) values (%L, %L, ''work_changed'', ''偽'', ''app'')', tests.t('A'), tests.id('m:A:staffA'))), '42501', 'R-015-17 本人でも、お知らせを画面から作れない');

select * from finish();
rollback;
