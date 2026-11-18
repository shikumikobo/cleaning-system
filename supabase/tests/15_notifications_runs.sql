-- 機能 015：送る処理が呼ぶ DB の関数と掃除（R-015-18〜23・25）。呼ぶのは service_role だけ
begin;
select * from no_plan();
select tests.seed();

-- 送る前の行を作っておく（staffA：通知の行、memberA：メールの行）
select app.enqueue_notification(tests.t('A'), tests.id('m:A:staffA'), 'work_tomorrow', '明日の作業', '本文', '/works/1', 'r1');
select app.enqueue_notification(tests.t('A'), tests.id('m:A:memberA'), 'quote_approved', '見積', null, '/quotes/1', 'r2');
select app.enqueue_notification(tests.t('B'), tests.id('m:B:staffB'), 'work_tomorrow', 'B の作業', null, '/works/9', 'rb');

-- 呼べる人（R-015-18）
select is(tests.err(tests.u('adminA'), 'select * from public.notification_tenants_pending()'), '42501', 'R-015-18 ログインした人は、送る処理の関数を呼べない（会社の一覧）');
select is(tests.err(tests.u('adminA'), format('select public.notification_start_run(%L, ''send_notifications'')', tests.t('A'))), '42501', 'R-015-18 ログインした人は、記録を始められない');
select is(tests.err(tests.u('adminA'), format('select * from public.notification_outbox(%L, 10)', tests.t('A'))), '42501', 'R-015-18 ログインした人は、送る前の行を取れない');
select is(tests.err(tests.u('adminA'), format('select public.notification_mark(%L, %L, ''sent'', null)', tests.t('A'), tests.id('ntA-1'))), '42501', 'R-015-19 ログインした人は、送った印を付けられない');
select is(tests.err(tests.u('adminA'), format('select public.notification_purge(%L)', tests.t('A'))), '42501', 'R-015-25 ログインした人は、掃除を呼べない');
select is(tests.run_as_anon('select * from public.notification_tenants_pending()') ->> 'error', '42501', 'R-015-18 ログインしていない人は呼べない');

-- 会社ごとに分ける（R-015-18）
select is((select count(*)::int from public.notification_tenants_pending()), 2, 'R-015-18 送る前の行がある会社（A・B）が出る');
select is(tests.run_as_service('select count(*)::int as c from public.notification_tenants_pending()') -> 'rows' -> 0 ->> 'c', '2', 'R-015-18 service_role は会社の一覧を取れる');
select is(tests.run_as_service(format('select count(*)::int as c from public.notification_outbox(%L, 100)', tests.t('A'))) -> 'rows' -> 0 ->> 'c', '2', 'R-015-18 会社 A の送る前は2行（通知とメール。一覧の行は含まない）');
select is((select count(*)::int from public.notification_outbox(tests.t('A'), 100) where tenant_id <> tests.t('A')), 0, 'R-015-18 ほかの会社の行は混ざらない');
select is((select count(*)::int from public.notification_outbox(tests.t('A'), 1)), 1, 'R-015-18 取る行数の上限が効く');
select is((select user_id from public.notification_outbox(tests.t('A'), 100) where channel = 'push'), tests.u('staffA'), 'R-015-18 受け取る人のログインの ID（user_id）が付く');
select is((select string_agg(channel, ',' order by channel) from public.notification_outbox(tests.t('A'), 100)), 'email,push', 'R-015-18 通知とメールの行だけを返す');

-- 処理の記録（R-015-18・23）
select is(tests.run_as_service(format('select public.notification_start_run(%L, ''bogus'') as r', tests.t('A'))) ->> 'error', '22023', 'R-015-18 知らない種類の記録は始められない');
create temp table _run as select public.notification_start_run(tests.t('A'), 'send_notifications') as id;
select ok((select id is not null from _run), 'R-015-18 記録を始められる（run の ID が返る）');
select is((select status || '/' || kind from public.job_runs where id = (select id from _run)), 'running/send_notifications', 'R-015-18 始めた記録は running');
select is((select tenant_id from public.job_runs where id = (select id from _run)), tests.t('A'), 'R-015-18 記録は会社ごと');
select ok(public.notification_start_run(tests.t('A'), 'send_notifications') is null, 'R-015-23 同じ会社の送りが動いている間は、もう一度始められない（null）');
select is((select count(*)::int from public.job_runs where tenant_id = tests.t('A') and kind = 'send_notifications' and status = 'running'), 1, 'R-015-23 動いている記録は1つだけ');
create temp table _runb as select public.notification_start_run(tests.t('B'), 'send_notifications') as id;
select ok((select id is not null from _runb), 'R-015-23 別の会社は同時に動かせる');
select ok(public.notification_start_run(tests.t('A'), 'purge_notifications') is not null, 'R-015-23 掃除は送りと別の種類（同時に動かせる）');

-- 止まったまま残った古い記録（R-015-23）
update public.job_runs set started_at = now() - interval '31 minutes' where id = (select id from _run);
create temp table _run2 as select public.notification_start_run(tests.t('A'), 'send_notifications') as id;
select ok((select id is not null from _run2) and (select id from _run2) <> (select id from _run), 'R-015-23 30 分を過ぎた記録があれば、閉じて始め直せる');
select is((select status || '/' || coalesce(error, '') from public.job_runs where id = (select id from _run)), 'failure/timeout', 'R-015-23 古い記録は失敗（timeout）で閉じる');
select ok((select ended_at is not null from public.job_runs where id = (select id from _run)), 'R-015-23 古い記録に終わりの時刻が入る');

-- 1通ずつ印を付ける（R-015-19・20）
select is(public.notification_mark(tests.t('A'), (select id from public.notifications where dedupe_key = 'r1' and channel = 'push'), 'sent', null), true, 'R-015-19 送れたら送ったにできる');
select is((select status from public.notifications where dedupe_key = 'r1' and channel = 'push'), 'sent', 'R-015-19 状況は送った');
select ok((select sent_at is not null from public.notifications where dedupe_key = 'r1' and channel = 'push'), 'R-015-19 送った時刻が入る');
select is(public.notification_mark(tests.t('A'), (select id from public.notifications where dedupe_key = 'r1' and channel = 'push'), 'failed', 'x'), false, 'R-015-19 送った行は、もう一度印を付けられない');
select is((select status from public.notifications where dedupe_key = 'r1' and channel = 'push'), 'sent', 'R-015-19 送った行は変わらない');
select is(public.notification_mark(tests.t('A'), (select id from public.notifications where dedupe_key = 'r2' and channel = 'email'), 'failed', repeat('あ', 400)), true, 'R-015-20 送れなければ失敗にできる');
select is((select status from public.notifications where dedupe_key = 'r2' and channel = 'email'), 'failed', 'R-015-20 状況は失敗');
select is((select length(error) from public.notifications where dedupe_key = 'r2' and channel = 'email'), 300, 'R-015-20 理由は 300 字までにする');
select ok((select sent_at is null from public.notifications where dedupe_key = 'r2' and channel = 'email'), 'R-015-20 失敗には送った時刻を入れない');
select is(public.notification_mark(tests.t('A'), (select id from public.notifications where dedupe_key = 'rb' and channel = 'push'), 'sent', null), false, 'R-015-19 別の会社の行には、会社を指定しても印を付けられない');
select is((select status from public.notifications where dedupe_key = 'rb' and channel = 'push'), 'pending', 'R-015-19 別の会社の行は変わらない');
select is(public.notification_mark(tests.t('A'), (select id from public.notifications where dedupe_key = 'r1' and channel = 'app'), 'failed', 'x'), false, 'R-015-19 一覧の行には印を付けられない');
select is(tests.run_as_service(format('select public.notification_mark(%L, %L, ''pending'', null)', tests.t('B'), (select id from public.notifications where dedupe_key = 'rb' and channel = 'push'))) ->> 'error', '22023', 'R-015-19 印は送った・失敗の2つだけ');
select is((select count(*)::int from public.notification_outbox(tests.t('A'), 100)), 0, 'R-015-18 印を付けたものは、送る前から外れる');
select is((select count(*)::int from public.notification_tenants_pending()), 1, 'R-015-18 送る前がなくなった会社は、一覧から外れる（B だけ）');

-- 記録を閉じる（R-015-18・22）
select is(public.notification_finish_run(tests.t('A'), (select id from _run2), 'success', '{"sent": 1, "failed": 1}', null), true, 'R-015-18 記録を閉じられる');
select is((select status || '/' || (counts ->> 'sent') || '/' || (counts ->> 'failed') from public.job_runs where id = (select id from _run2)), 'success/1/1', 'R-015-18 結果と件数が残る');
select ok((select ended_at is not null from public.job_runs where id = (select id from _run2)), 'R-015-18 終わりの時刻が入る');
select is(public.notification_finish_run(tests.t('A'), (select id from _run2), 'failure', '{}', 'もう一度'), false, 'R-015-18 閉じた記録は、もう直せない');
select is(public.notification_finish_run(tests.t('A'), (select id from _runb), 'success', '{}', null), false, 'R-015-22 別の会社の記録は、会社を取り違えて閉じられない');
select is((select status from public.job_runs where id = (select id from _runb)), 'running', 'R-015-22 取り違えた閉じ方では、記録は変わらない');
select is(public.notification_finish_run(tests.t('B'), (select id from _runb), 'failure', '{}', '送り手が使えない'), true, 'R-015-22 失敗の理由を、その会社の記録に残せる');
select is((select status || '/' || error from public.job_runs where id = (select id from _runb)), 'failure/送り手が使えない', 'R-015-22 失敗した会社の記録に理由が残る');
select is(tests.run_as_service(format('select public.notification_finish_run(%L, %L, ''running'', ''{}'', null)', tests.t('B'), tests.id('jobB'))) ->> 'error', '22023', 'R-015-18 閉じる状況は成功・失敗の2つだけ');

-- 届かない端末を消す（R-015-21）
select is(public.notification_drop_subscription(tests.t('B'), tests.id('psA-staff')), false, 'R-015-21 会社を取り違えると、端末の登録は消えない');
select is((select count(*)::int from public.push_subscriptions where id = tests.id('psA-staff')), 1, 'R-015-21 取り違えた消し方では、登録は残る');
select is(public.notification_drop_subscription(tests.t('A'), tests.id('psA-staff')), true, 'R-015-21 届かない端末の登録を消せる');
select is((select count(*)::int from public.push_subscriptions where id = tests.id('psA-staff')), 0, 'R-015-21 行ごと消える（鍵を残さない）');
select is((select count(*)::int from public.push_subscriptions where tenant_id = tests.t('B')), 1, 'R-015-21 ほかの会社の登録は残る');

-- 掃除（R-015-25）：180 日を過ぎたものだけ。その会社の分だけ
insert into public.notifications (id, tenant_id, membership_id, kind, title, channel, status, sent_at, created_at) values
  (tests.id('old-A1'), tests.t('A'), tests.id('m:A:staffA'), 'work_changed', '古い1', 'app', 'sent', now(), now() - interval '181 days'),
  (tests.id('old-A2'), tests.t('A'), tests.id('m:A:memberA'), 'work_changed', '古い2', 'app', 'sent', now(), now() - interval '400 days'),
  (tests.id('edge-A'), tests.t('A'), tests.id('m:A:staffA'), 'work_changed', '179日', 'app', 'sent', now(), now() - interval '179 days'),
  (tests.id('old-B1'), tests.t('B'), tests.id('m:B:staffB'), 'work_changed', 'B の古い', 'app', 'sent', now(), now() - interval '300 days');
update public.push_subscriptions set deleted_at = now() - interval '31 days' where id = tests.id('psB-staff');
insert into public.push_subscriptions (id, tenant_id, membership_id, endpoint, p256dh, auth, deleted_at) values
  (tests.id('psA-recent'), tests.t('A'), tests.id('m:A:staffA'), 'https://push.example.test/recent', 'k', 'a', now() - interval '1 day'),
  (tests.id('psA-old'), tests.t('A'), tests.id('m:A:memberA'), 'https://push.example.test/old', 'k', 'a', now() - interval '31 days');
select is(public.notification_purge(tests.t('A')), 2, 'R-015-25 180 日を過ぎた会社 A のお知らせ2件を消し、消した数を返す');
select is((select count(*)::int from public.notifications where id in (tests.id('old-A1'), tests.id('old-A2'))), 0, 'R-015-25 180 日を過ぎたお知らせは消える');
select is((select count(*)::int from public.notifications where id = tests.id('edge-A')), 1, 'R-015-25 179 日のお知らせは残る');
select is((select count(*)::int from public.notifications where id in (tests.id('ntA-1'), tests.id('ntA-2'), tests.id('ntA-m'))), 3, 'R-015-25 新しいお知らせは残る');
select is((select count(*)::int from public.notifications where id = tests.id('old-B1')), 1, 'R-015-25 ほかの会社のお知らせは消さない');
select is((select count(*)::int from public.push_subscriptions where id = tests.id('psA-old')), 0, 'R-015-25 外して 30 日を過ぎた端末の登録も消す');
select is((select count(*)::int from public.push_subscriptions where id = tests.id('psA-recent')), 1, 'R-015-25 外したばかりの登録は残る');
select is((select count(*)::int from public.push_subscriptions where id = tests.id('psB-staff')), 1, 'R-015-25 ほかの会社の登録は消さない');
select is(public.notification_purge(tests.t('B')), 1, 'R-015-25 会社 B の分も、その会社の呼び出しで消える');
select is((select count(*)::int from public.notifications where id = tests.id('old-B1')), 0, 'R-015-25 B の古いお知らせが消える');
select is(public.notification_purge(tests.t('A')), 0, 'R-015-25 もう一度呼んでも、消すものがなければ 0');
select is(tests.run_as_service(format('select public.notification_purge(%L) as n', tests.t('A'))) -> 'rows' -> 0 ->> 'n', '0', 'R-015-25 service_role から呼べる');

select * from finish();
rollback;
