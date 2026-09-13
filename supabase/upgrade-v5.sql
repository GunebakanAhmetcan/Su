-- Mevcut v4 kurulumu için. SQL Editor içinde tamamını bir kez çalıştır.
-- Kayıtlar, eşleşmeler, bildirim abonelikleri ve mevcut webhook korunur.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

alter table public.water_entries add column if not exists recorded_day date;
alter table public.water_entries add column if not exists sync_revision bigint not null default 0;
create index if not exists water_entries_room_day_idx on public.water_entries(room_id, recorded_day);

create table if not exists private.water_versions (
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  revision bigint not null,
  primary key(user_id, client_id)
);
create table if not exists private.recovery_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);
revoke all on private.water_versions, private.recovery_codes from public, anon, authenticated;

create or replace function public.su_version() returns integer
language sql immutable as $$ select 5; $$;

create or replace function public.sync_water_changes(p_room_id uuid, p_changes jsonb)
returns table(client_id text, id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_change jsonb; v_client text; v_revision bigint; v_apply boolean;
begin
  if v_uid is null or not public.is_room_member(p_room_id, v_uid) then
    raise exception 'Eşleşme oturumu bulunamadı.';
  end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 100 then
    raise exception 'Geçersiz işlem listesi.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text, 724));
  if not public.is_room_member(p_room_id, v_uid) then raise exception 'Eşleşme oturumu bulunamadı.'; end if;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_client := v_change->>'client_id';
    v_revision := (v_change->>'revision')::bigint;
    if v_client is null or length(v_client) not between 1 and 80 or v_revision is null or v_revision <= 0
      or coalesce(v_change->>'kind', '') not in ('upsert', 'delete') then
      raise exception 'Geçersiz kayıt.';
    end if;
    v_apply := null;
    insert into private.water_versions as versions(user_id, client_id, revision)
      values(v_uid, v_client, v_revision)
      on conflict on constraint water_versions_pkey do update set revision = excluded.revision
      where versions.revision < excluded.revision
      returning true into v_apply;
    if v_apply then
      if v_change->>'kind' = 'delete' then
        delete from public.water_entries w where w.user_id = v_uid and w.client_id = v_client;
      else
        if v_change->>'recorded_day' is null or v_change->>'recorded_at' is null or v_change->>'amount' is null then
          raise exception 'Kayıt tarihi ve miktarı gerekli.';
        end if;
        insert into public.water_entries(room_id, user_id, client_id, amount, recorded_at, recorded_day, sync_revision)
          values(p_room_id, v_uid, v_client, (v_change->>'amount')::integer,
                 (v_change->>'recorded_at')::timestamptz, (v_change->>'recorded_day')::date, v_revision)
          on conflict on constraint water_entries_user_id_client_id_key do update set
            amount = excluded.amount, recorded_at = excluded.recorded_at,
            recorded_day = excluded.recorded_day, sync_revision = excluded.sync_revision;
      end if;
    end if;
    return query select v_client, (select w.id from public.water_entries w where w.user_id = v_uid and w.client_id = v_client);
  end loop;
end;
$$;

create or replace function public.get_pair_entries(p_from date, p_to date, p_time_zone text default 'UTC')
returns setof public.water_entries language plpgsql security invoker set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'En fazla 63 günlük aralık seç.';
  end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'Saat dilimi geçersiz.';
  end if;
  return query select w.* from public.water_entries w
    where coalesce(w.recorded_day, (w.recorded_at at time zone p_time_zone)::date) between p_from and p_to
    order by w.recorded_at desc, w.id;
end;
$$;

create or replace function public.current_pair()
returns table(room_id uuid, invite_code text, user_id uuid, display_name text, daily_goal integer)
language sql security invoker set search_path = '' as $$
  select r.id, r.invite_code, p.user_id, p.display_name, p.daily_goal
  from public.room_members m join public.rooms r on r.id=m.room_id
  join public.profiles p on p.user_id=m.user_id where m.user_id=auth.uid();
$$;

create or replace function public.set_recovery_code(p_hash text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists(select 1 from public.room_members where user_id=v_uid) then
    raise exception 'Önce eşleşme oluştur.';
  end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Geçersiz kurtarma kodu.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text, 724));
  insert into private.recovery_codes(user_id, token_hash) values(v_uid,p_hash)
    on conflict(user_id) do update set token_hash=excluded.token_hash, created_at=now();
end;
$$;

create or replace function public.recover_pair(p_code text)
returns table(room_id uuid, invite_code text, user_id uuid, display_name text, daily_goal integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_new uuid := auth.uid(); v_old uuid; v_lock uuid; v_room uuid; v_hash text;
  v_code text := upper(regexp_replace(coalesce(p_code,''), '[\s-]', '', 'g'));
  v_profile public.profiles%rowtype;
begin
  if v_new is null then raise exception 'Oturum bulunamadı.'; end if;
  if v_code !~ '^[0-9A-F]{64}$' then raise exception 'Kurtarma kodu geçersiz veya kullanılmış.'; end if;
  v_hash := encode(sha256(convert_to(v_code,'UTF8')), 'hex');
  select c.user_id into v_old from private.recovery_codes c where c.token_hash=v_hash;
  if v_old is null then raise exception 'Kurtarma kodu geçersiz veya kullanılmış.'; end if;
  for v_lock in select distinct x from unnest(array[v_old,v_new]) x order by x loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock::text, 724));
  end loop;
  perform 1 from private.recovery_codes c where c.user_id=v_old and c.token_hash=v_hash for update;
  if not found then raise exception 'Kurtarma kodu geçersiz veya kullanılmış.'; end if;
  select m.room_id into v_room from public.room_members m where m.user_id=v_old;
  if v_room is null then raise exception 'Eşleşme bulunamadı.'; end if;
  perform 1 from public.rooms r where r.id=v_room for update;
  if v_new<>v_old and exists(select 1 from public.room_members m where m.user_id=v_new) then
    raise exception 'Bu cihaz zaten eşleşmiş. Kurtarma için yeni cihazı kullan.';
  end if;
  select * into v_profile from public.profiles p where p.user_id=v_old;
  if v_new<>v_old then
    insert into public.profiles(user_id,display_name,daily_goal,notifications_enabled)
      values(v_new,v_profile.display_name,v_profile.daily_goal,false)
      on conflict on constraint profiles_pkey do update set display_name=excluded.display_name, daily_goal=excluded.daily_goal, notifications_enabled=false;
    update public.room_members m set user_id=v_new where m.user_id=v_old;
    update public.rooms r set created_by=v_new where r.created_by=v_old;
    update public.water_entries w set user_id=v_new where w.user_id=v_old;
    update private.water_versions w set user_id=v_new where w.user_id=v_old;
    update public.notification_jobs j set sender_user_id=v_new where j.sender_user_id=v_old;
    update public.notification_jobs j set recipient_user_id=v_new where j.recipient_user_id=v_old;
    delete from public.push_subscriptions s where s.user_id=v_old;
    delete from public.profiles p where p.user_id=v_old;
  end if;
  delete from private.recovery_codes c where c.user_id in(v_old,v_new);
  return query select r.id,r.invite_code,v_new,v_profile.display_name,v_profile.daily_goal from public.rooms r where r.id=v_room;
end;
$$;

alter table public.notification_jobs add column if not exists status text not null default 'pending';
alter table public.notification_jobs add column if not exists attempts integer not null default 0;
alter table public.notification_jobs add column if not exists next_attempt_at timestamptz default now();
alter table public.notification_jobs add column if not exists locked_until timestamptz;
alter table public.notification_jobs add column if not exists last_attempt_at timestamptz;
update public.notification_jobs set status=case when error is null then 'sent' else 'failed' end
  where processed_at is not null and status='pending';
update public.notification_jobs set status='failed',error=coalesce(error,'expired'),processed_at=now()
  where processed_at is null and created_at<now()-interval '1 hour';
create index if not exists notification_jobs_pending_idx on public.notification_jobs(status,next_attempt_at);

create or replace function private.prepare_reminder() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.sender_user_id::text, 981));
  if exists(select 1 from public.notification_jobs j where j.sender_user_id=new.sender_user_id and j.created_at>now()-interval '30 seconds') then
    raise exception 'Yeni hatırlatma için 30 saniye bekle.';
  end if;
  new.status:='pending'; new.attempts:=0; new.created_at:=now(); new.processed_at:=null;
  new.error:=null; new.locked_until:=null; new.next_attempt_at:=now(); new.last_attempt_at:=null;
  return new;
end;
$$;
drop trigger if exists su_prepare_reminder on public.notification_jobs;
create trigger su_prepare_reminder before insert on public.notification_jobs for each row execute function private.prepare_reminder();
revoke insert on public.notification_jobs from authenticated;
grant insert(room_id,sender_user_id,recipient_user_id,kind) on public.notification_jobs to authenticated;

create or replace function private.update_push_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  if tg_op='DELETE' then v_uid:=old.user_id; else v_uid:=new.user_id; end if;
  update public.profiles p set notifications_enabled=exists(select 1 from public.push_subscriptions s where s.user_id=v_uid), updated_at=now() where p.user_id=v_uid;
  return null;
end;
$$;
drop trigger if exists su_push_status on public.push_subscriptions;
create trigger su_push_status after insert or update or delete on public.push_subscriptions for each row execute function private.update_push_status();

create or replace function public.claim_push_job(p_id uuid default null)
returns setof public.notification_jobs language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  update public.notification_jobs set status='failed', error='expired', processed_at=now(), locked_until=null
    where status in('pending','retry','processing') and created_at<now()-interval '1 hour';
  update public.notification_jobs set status='failed', error='retry_limit', processed_at=now(), locked_until=null
    where status='processing' and attempts>=4 and locked_until<now();
  select j.id into v_id from public.notification_jobs j
    where (p_id is null or j.id=p_id) and j.attempts<4 and j.processed_at is null
      and ((j.status in('pending','retry') and coalesce(j.next_attempt_at,now())<=now())
        or (j.status='processing' and j.locked_until<now()))
    order by j.created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  return query update public.notification_jobs j set status='processing',attempts=j.attempts+1,
    locked_until=now()+interval '2 minutes',last_attempt_at=now(),error=null
    where j.id=v_id returning j.*;
end;
$$;

create or replace function public.finish_push_job(p_id uuid,p_attempt integer,p_sent boolean,p_error text default null,p_retryable boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_jobs j set
    status=case when p_sent then 'sent' when p_retryable and j.attempts<4 then 'retry' else 'failed' end,
    processed_at=case when p_sent or not p_retryable or j.attempts>=4 then now() else null end,
    error=case when p_sent then null else left(p_error,500) end,
    locked_until=null,
    next_attempt_at=now()+interval '1 minute'*power(2,j.attempts)
    where j.id=p_id and j.attempts=p_attempt and j.status='processing';
end;
$$;

revoke all on function public.su_version(), public.sync_water_changes(uuid,jsonb), public.get_pair_entries(date,date,text),
  public.current_pair(), public.set_recovery_code(text), public.recover_pair(text) from public,anon;
grant execute on function public.su_version(), public.sync_water_changes(uuid,jsonb), public.get_pair_entries(date,date,text),
  public.current_pair(), public.set_recovery_code(text), public.recover_pair(text) to authenticated;
revoke all on function public.claim_push_job(uuid),public.finish_push_job(uuid,integer,boolean,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_push_job(uuid),public.finish_push_job(uuid,integer,boolean,text,boolean) to service_role;
commit;
