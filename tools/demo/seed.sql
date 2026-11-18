-- デモデータ（全部、架空の会社・人・建物）。temp 表 u(role, id) に、作った利用者の ID が入っている前提。
do $$
declare
  t uuid; off1 uuid; r_admin uuid; r_member uuid; r_staff uuid;
  u_admin uuid; u_member uuid; u_s1 uuid; u_s2 uuid;
  m_admin uuid; m_member uuid; m_s1 uuid; m_s2 uuid;
  c1 uuid; c2 uuid; c3 uuid; o1 uuid; o2 uuid;
  bid uuid[]; i int; d date; w uuid; tpl uuid; q uuid; ct uuid; cs uuid; cs2 uuid; inv uuid; skey uuid;
  names text[] := array['グリーンハイツ南青山','サンライズタワー渋谷','コーポ緑ヶ丘','メゾン桜台','ブルーレジデンス品川'];
  addrs text[] := array['東京都港区南青山3-1-5','東京都渋谷区道玄坂2-10-7','東京都世田谷区緑ヶ丘1-4-12','東京都練馬区桜台2-8-3','東京都品川区北品川4-6-9'];
  lats numeric[] := array[35.6652,35.6580,35.6050,35.7370,35.6230];
  lngs numeric[] := array[139.7186,139.6980,139.6680,139.6540,139.7390];
  owners uuid[]; clients uuid[]; areas text[] := array['エントランス','廊下・階段','エレベーター','ゴミ置き場','駐輪場'];
  k int; stf uuid[]; mon date := date_trunc('month', current_date)::date;
  wstat text; rep uuid; rstat text; staff_m uuid; ext uuid;
begin
  select id into r_admin from roles where code='admin'; select id into r_member from roles where code='member'; select id into r_staff from roles where code='staff';
  select id into u_admin from u where role='admin'; select id into u_member from u where role='member';
  select id into u_s1 from u where role='staff1'; select id into u_s2 from u where role='staff2';
  insert into profiles(id, display_name) values (u_admin,'山田 太郎（社長）'),(u_member,'佐藤 花子（事務）'),(u_s1,'鈴木 一郎'),(u_s2,'高橋 美咲') on conflict (id) do update set display_name=excluded.display_name;
  insert into tenants(name,address,phone,invoice_reg_no,status,trial_ends_at) values ('サンプル清掃株式会社（デモ）','東京都千代田区丸の内1-1-1','03-0000-0000','T1234567890123','trial', now()+interval '30 days') returning id into t;
  insert into offices(tenant_id,name,address) values (t,'本社','東京都千代田区丸の内1-1-1') returning id into off1;
  insert into memberships(tenant_id,user_id,role_id,office_id,status) values (t,u_admin,r_admin,off1,'active') returning id into m_admin;
  insert into memberships(tenant_id,user_id,role_id,office_id,status) values (t,u_member,r_member,off1,'active') returning id into m_member;
  insert into memberships(tenant_id,user_id,role_id,office_id,status) values (t,u_s1,r_staff,off1,'active') returning id into m_s1;
  insert into memberships(tenant_id,user_id,role_id,office_id,status) values (t,u_s2,r_staff,off1,'active') returning id into m_s2;
  stf := array[m_s1,m_s2];

  insert into clients(tenant_id,kind,name,address,phone,email,closing_day,payment_terms) values (t,'management_company','東都ビルマネジメント','東京都中央区日本橋1-2-3','03-1111-0001','info@toto-bm.example.test',31,'翌月末払い') returning id into c1;
  insert into clients(tenant_id,kind,name,address,phone,email,closing_day,payment_terms) values (t,'management_company','ハーモニー管理サービス','東京都新宿区西新宿2-4-1','03-1111-0002','mail@harmony.example.test',20,'翌月20日払い') returning id into c2;
  insert into clients(tenant_id,kind,name,address,phone,email,closing_day,payment_terms) values (t,'management_company','みどり不動産管理','東京都世田谷区三軒茶屋1-9-9','03-1111-0003','kanri@midori.example.test',31,'翌月末払い') returning id into c3;
  insert into clients(tenant_id,kind,name,address,phone,payment_terms) values (t,'owner','桜井 実（オーナー）','東京都練馬区桜台2-1-1','090-0000-0001','翌月10日払い') returning id into o1;
  insert into clients(tenant_id,kind,name,address,phone,payment_terms) values (t,'owner','青木 恵子（オーナー）','東京都品川区北品川1-1-1','090-0000-0002','翌月10日払い') returning id into o2;
  insert into client_contacts(tenant_id,client_id,name,email,phone) values (t,c1,'中村 健','nakamura@toto-bm.example.test','03-1111-0011'),(t,c2,'小林 優子','kobayashi@harmony.example.test','03-1111-0021'),(t,c3,'井上 浩','inoue@midori.example.test','03-1111-0031');
  clients := array[c1,c1,c3,c2,c2]; owners := array[null,o1,null,o1,o2]::uuid[];

  for i in 1..5 loop
    insert into buildings(tenant_id,client_id,owner_client_id,name,address,lat,lng,location_fixed) values (t,clients[i],owners[i],names[i],addrs[i],lats[i],lngs[i],true) returning id into w;
    bid := bid || w;
    insert into building_profiles(tenant_id,building_id,entry,key_place,parking,garbage_days,manager_contact,cautions) values (t,w,
      case i when 1 then '正面エントランス。管理人室で声をかける' else '裏口のオートロック（暗証番号は管理会社に確認）' end,
      '管理人室の鍵ボックス（番号は事務所で確認）','来客用駐車場1台（事前に管理会社へ連絡）','月・木：燃えるごみ／水：資源','管理人 '||(array['田中','渡辺','伊藤','加藤','吉田'])[i]||' 03-2222-000'||i,
      case i when 3 then 'ペット同伴の入居者が多い。共用部の消毒は薬剤を弱めに' else '早朝（9時前）は大きな音を出さない' end);
    for k in 1..5 loop insert into building_areas(tenant_id,building_id,name,sort) values (t,w,areas[k],k); end loop;
    for k in 1..8 loop insert into rooms(tenant_id,building_id,room_no,floor) values (t,w,(100*((k+1)/2)+((k-1)%2)+1)::text,(k+1)/2); end loop;
    insert into report_templates(tenant_id,building_id,name) values (t,w,'定期清掃（標準）') returning id into tpl;
    insert into template_items(tenant_id,template_id,area_id,name,sort) select t,tpl,id,name||'の清掃',sort from building_areas where building_id=w;
  end loop;

  insert into items(tenant_id,name,unit,unit_price,kind) values
    (t,'定期清掃（共用部・週2回）','月',68000,'base'),(t,'定期清掃（共用部・週1回）','月',42000,'base'),
    (t,'ガラス清掃','回',28000,'option'),(t,'床のワックスがけ','回',55000,'option'),(t,'高圧洗浄（駐輪場・外階段）','回',38000,'option'),
    (t,'エアコン清掃','台',12000,'one_time'),(t,'入居前の清掃（1室）','室',22000,'one_time'),(t,'電球の交換','個',1500,'one_time');

  for i in 1..5 loop
    insert into quotes(tenant_id,client_id,building_id,kind,number,issue_date,valid_until,subtotal,tax,total,status,submitted_at,decided_at,decided_by,note)
    values (t,clients[i],bid[i],'recurring','Q-2026-'||lpad(i::text,4,'0'),current_date-60+i,current_date-30+i,
      case when i%2=1 then 96000 else 97000 end, case when i%2=1 then 9600 else 9700 end, case when i%2=1 then 105600 else 106700 end,
      case when i<=4 then 'approved' else 'submitted' end, now()-interval '55 days', case when i<=4 then now()-interval '50 days' end, case when i<=4 then m_admin end,'デモの見積')
    returning id into q;
    if i%2=1 then
      insert into quote_lines(tenant_id,quote_id,line_kind,name,qty,unit,unit_price,recurrence,sort) values (t,q,'base','定期清掃（共用部・週2回）',1,'月',68000,'FREQ=WEEKLY;BYDAY=MO,TH',1),(t,q,'option','ガラス清掃',1,'回',28000,'FREQ=MONTHLY;BYMONTHDAY=15',2);
    else
      insert into quote_lines(tenant_id,quote_id,line_kind,name,qty,unit,unit_price,recurrence,sort) values (t,q,'base','定期清掃（共用部・週1回）',1,'月',42000,'FREQ=WEEKLY;BYDAY=WE',1),(t,q,'option','床のワックスがけ',1,'回',55000,'FREQ=MONTHLY;BYMONTHDAY=20',2);
    end if;
    if i<=4 then
      staff_m := stf[1+(i%2)];
      insert into contracts(tenant_id,client_id,building_id,source,quote_id,kind,start_date,status) values (t,clients[i],bid[i],'quote',q,'recurring',current_date-45,'active') returning id into ct;
      insert into contract_services(tenant_id,contract_id,service_kind,name,amount,billing,recurrence,start_time,end_time,valid_from)
        values (t,ct,'base',case when i%2=1 then '定期清掃（共用部・週2回）' else '定期清掃（共用部・週1回）' end,case when i%2=1 then 68000 else 42000 end,'monthly',
        case when i%2=1 then 'FREQ=WEEKLY;BYDAY=MO,TH' else 'FREQ=WEEKLY;BYDAY=WE' end,case when i=3 then '13:30'::time else '09:30'::time end,case when i=3 then '16:00'::time else '12:00'::time end,current_date-45) returning id, service_key into cs, skey;
      insert into contract_services(tenant_id,contract_id,service_kind,name,amount,billing,recurrence,start_time,end_time,valid_from)
        values (t,ct,'option',case when i%2=1 then 'ガラス清掃' else '床のワックスがけ' end,case when i%2=1 then 28000 else 55000 end,'per_visit',
        case when i%2=1 then 'FREQ=MONTHLY;BYMONTHDAY=15' else 'FREQ=MONTHLY;BYMONTHDAY=20' end,'13:00','16:00',current_date-45) returning id into cs2;
      insert into contract_service_staff(tenant_id,contract_service_id,membership_id) values (t,cs,staff_m);
      select id into tpl from report_templates where building_id=bid[i];
      for k in -21..21 loop
        d := current_date + k;
        if (i%2=1 and extract(isodow from d) in (1,4)) or (i%2=0 and extract(isodow from d)=3) then
          wstat := case when k<0 then 'done' when k=0 then 'in_progress' else 'scheduled' end;
          if i=4 and k<0 and k>-9 then wstat:='skipped'; end if;
          insert into works(tenant_id,building_id,contract_service_id,service_key,title,report_template_id,scheduled_date,start_time,end_time,status)
            values (t,bid[i],cs,skey,'定期清掃（'||names[i]||'）',tpl,d,case when i=3 then '13:30'::time else '09:30'::time end,case when i=3 then '16:00'::time else '12:00'::time end,wstat) returning id into w;
          insert into work_assignments(tenant_id,work_id,membership_id) values (t,w,staff_m);
          if wstat in ('done','in_progress') then
            insert into work_records(tenant_id,work_id,membership_id,started_at,ended_at,start_lat,start_lng,end_lat,end_lng,distance_m,distance_warning)
              values (t,w,staff_m,(d+time '09:34')::timestamptz,case when wstat='done' then (d+time '11:52')::timestamptz end,lats[i],lngs[i],case when wstat='done' then lats[i] end,case when wstat='done' then lngs[i] end,35,false);
            rstat := case when wstat='in_progress' then 'draft' when k<-10 then 'submitted' when k<-2 then 'checked' else 'draft' end;
            insert into reports(tenant_id,work_id,template_id,status,remarks,checked_by,checked_at,submitted_by,submitted_at)
              values (t,w,tpl,rstat,case when k%3=0 then '廊下の壁に汚れあり。次回、重点的に拭く。' else '問題なし。' end,
                case when rstat<>'draft' then m_member end, case when rstat<>'draft' then (d+time '17:00')::timestamptz end,
                case when rstat='submitted' then m_member end, case when rstat='submitted' then (d+time '18:00')::timestamptz end) returning id into rep;
            insert into report_items(tenant_id,report_id,template_item_id,area_id,name,sort,done)
              select t,rep,ti.id,ti.area_id,ti.name,ti.sort,(wstat='done' or ti.sort<3) from template_items ti where ti.template_id=tpl;
          end if;
        end if;
      end loop;
      if i in (1,3,4) then
      insert into invoices(tenant_id,client_id,period,number,issue_date,due_date,subtotal,tax,total,status,issued_at,sent_at)
        values (t,clients[i],(mon - interval '1 month')::date,'INV-2026-'||lpad(i::text,4,'0'),mon,mon+25,
          case when i%2=1 then 96000 else 97000 end, case when i%2=1 then 9600 else 9700 end, case when i%2=1 then 105600 else 106700 end,
          case when i=1 then 'paid' when i=3 then 'sent' else 'partial' end, now()-interval '17 days', now()-interval '16 days') returning id into inv;
      insert into invoice_lines(tenant_id,invoice_id,service_key,service_month,name,qty,unit,unit_price,sort)
        select t,inv,service_key,(mon - interval '1 month')::date,name,1,case when billing='monthly' then '月' else '回' end,amount,case when service_kind='base' then 1 else 2 end from contract_services where contract_id=ct;
      if i=1 then insert into payments(tenant_id,invoice_id,paid_on,amount,note) values (t,inv,current_date-5,105600,'銀行振込'); end if;
      if i=4 then insert into payments(tenant_id,invoice_id,paid_on,amount,note) values (t,inv,current_date-3,50000,'一部入金'); end if;
      end if;
    end if;
  end loop;

  insert into requests(tenant_id,client_id,building_id,source,category,title,detail,due_date,assignee_id,status) values
    (t,c1,bid[1],'phone','cleaning','エントランスのガラスの汚れ','雨のあとに目立つとの連絡。次回の定期で対応。',current_date-2,m_s1,'in_progress'),
    (t,c1,bid[2],'email','repair','駐輪場の電球が切れている','3か所。電球の持ち込みで交換。',current_date+1,m_s2,'new'),
    (t,c3,bid[3],'phone','complaint','ゴミ置き場のにおいの苦情','入居者から。消臭と床の洗浄を提案。',current_date+3,m_s2,'new'),
    (t,c2,bid[4],'manual','cleaning','退去後の室内清掃（204号室）','入居前の清掃。来週の水曜まで。',current_date+6,m_s1,'new'),
    (t,c2,bid[5],'email','inquiry','定期清掃の見積の相談','週2回での見積を依頼されている。',current_date+10,m_member,'in_progress'),
    (t,c1,bid[1],'field','other','外階段の手すりのぐらつき','現場で発見。管理会社へ報告済み。',current_date-5,m_s1,'done'),
    (t,c3,bid[3],'phone','cleaning','エアコン清掃（3室）','入居前。日程は調整中。',current_date+14,null,'new'),
    (t,c1,bid[2],'manual','cleaning','ガラス清掃の追加の依頼','エントランス全面。見積を出す。',current_date-1,m_member,'new');

  insert into cash_accounts(tenant_id,holder_id,name) values (t,m_s1,'鈴木さんの小口'),(t,m_s2,'高橋さんの小口');
  insert into cash_entries(tenant_id,account_id,holder_id,entry_date,direction,amount,purpose,status,confirmed_at,confirmed_by)
    select t,a.id,a.holder_id,current_date-12,'in',20000,'小口の受け取り','confirmed',now()-interval '12 days',m_member from cash_accounts a;
  insert into cash_entries(tenant_id,account_id,holder_id,entry_date,direction,amount,purpose,building_id,status,confirmed_at,confirmed_by)
    select t,a.id,a.holder_id,current_date-x.d2,'out',x.amt,x.pur,bid[1+(x.d2%5)],case when x.d2>5 then 'confirmed' else 'draft' end,case when x.d2>5 then now()-interval '3 days' end,case when x.d2>5 then m_member end
    from cash_accounts a, (values (9,3280,'洗剤・スポンジ'),(7,1540,'電球'),(4,980,'ごみ袋'),(2,2200,'駐車場代')) x(d2,amt,pur) where a.holder_id=m_s1 or x.d2<5;

  insert into costs(tenant_id,month,building_id,kind,amount,note) values (t,(mon - interval '1 month')::date,bid[1],'material',18000,'洗剤のまとめ買い'),(t,(mon - interval '1 month')::date,bid[2],'outsourcing',32000,'高所のガラス清掃（外注）'),(t,mon,bid[3],'other',6500,'駐車場代');

  select id into ext from u where role='external';
  if ext is not null then
    insert into profiles(id,display_name) values (ext,'中村 健（東都ビルマネジメント）') on conflict (id) do update set display_name=excluded.display_name;
    insert into memberships(tenant_id,user_id,role_id,status,client_id) values (t,ext,(select id from roles where code='external'),'active',c1) returning id into w;
    insert into external_building_access(tenant_id,membership_id,building_id) values (t,w,bid[1]),(t,w,bid[2]);
  end if;
end $$;
