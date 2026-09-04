-- Supabase SQL Editor içinde tek seferde çalıştır.
-- Bu dosya iki kişilik eşleşme, ortak geçmiş ve bildirim kuyruklarını kurar.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 30),
  daily_goal integer not null default 2500 check (daily_goal between 500 and 6000),
  notifications_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  invite_code text not null unique check (char_length(invite_code) = 12),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.water_entries (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null check (char_length(client_id) between 1 and 80),
  amount integer not null check (amount between 1 and 10000),
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, client_id)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'drink_water' check (kind = 'drink_water'),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  check (sender_user_id <> recipient_user_id)
);

create index if not exists water_entries_room_recorded_idx
  on public.water_entries (room_id, recorded_at desc);
create index if not exists notification_jobs_recipient_idx
  on public.notification_jobs (recipient_user_id, created_at desc);
create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

create or replace function public.is_room_member(p_room_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members
    where room_id = p_room_id and user_id = p_user_id
  );
$$;

create or replace function public.shares_room(p_other_user_id uuid, p_current_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members mine
    join public.room_members theirs on theirs.room_id = mine.room_id
    where mine.user_id = p_current_user_id
      and theirs.user_id = p_other_user_id
  );
$$;

create or replace function public.create_pair(p_display_name text)
returns table (room_id uuid, invite_code text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_room_id uuid;
  v_invite_code text;
  v_name text := trim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
begin
  if v_user_id is null then
    raise exception 'Oturum bulunamadı.';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception 'İsim 1 ile 30 karakter arasında olmalı.';
  end if;

  insert into public.profiles (user_id, display_name)
  values (v_user_id, v_name)
  on conflict (user_id) do update
    set display_name = excluded.display_name, updated_at = now();

  select rm.room_id, r.invite_code
    into v_room_id, v_invite_code
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.user_id = v_user_id
  limit 1;

  if v_room_id is not null then
    return query select v_room_id, v_invite_code;
    return;
  end if;

  loop
    v_invite_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    begin
      insert into public.rooms (invite_code, created_by)
      values (v_invite_code, v_user_id)
      returning id into v_room_id;
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;

  insert into public.room_members (room_id, user_id)
  values (v_room_id, v_user_id);

  return query select v_room_id, v_invite_code;
end;
$$;

create or replace function public.join_pair(p_invite_code text, p_display_name text)
returns table (room_id uuid, invite_code text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_room_id uuid;
  v_existing_room_id uuid;
  v_invite_code text := upper(regexp_replace(coalesce(p_invite_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_name text := trim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
  v_member_count integer;
begin
  if v_user_id is null then
    raise exception 'Oturum bulunamadı.';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception 'İsim 1 ile 30 karakter arasında olmalı.';
  end if;
  if char_length(v_invite_code) <> 12 then
    raise exception 'Davet kodu bulunamadı.';
  end if;

  select r.id
    into v_room_id
  from public.rooms r
  where r.invite_code = v_invite_code
  for update;

  if v_room_id is null then
    raise exception 'Davet kodu bulunamadı.';
  end if;

  select rm.room_id
    into v_existing_room_id
  from public.room_members rm
  where rm.user_id = v_user_id
  limit 1;

  if v_existing_room_id is not null and v_existing_room_id <> v_room_id then
    raise exception 'Bu cihaz zaten başka bir eşleşmede.';
  end if;

  insert into public.profiles (user_id, display_name)
  values (v_user_id, v_name)
  on conflict (user_id) do update
    set display_name = excluded.display_name, updated_at = now();

  if v_existing_room_id = v_room_id then
    return query select v_room_id, v_invite_code;
    return;
  end if;

  select count(*)::integer
    into v_member_count
  from public.room_members
  where room_members.room_id = v_room_id;

  if v_member_count >= 2 then
    raise exception 'Bu eşleşmede iki kişi zaten var.';
  end if;

  insert into public.room_members (room_id, user_id)
  values (v_room_id, v_user_id);

  return query select v_room_id, v_invite_code;
end;
$$;

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.water_entries enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_jobs enable row level security;

drop policy if exists "profiles_pair_select" on public.profiles;
create policy "profiles_pair_select"
  on public.profiles for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.shares_room(user_id, (select auth.uid()))
  );

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update"
  on public.profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "rooms_member_select" on public.rooms;
create policy "rooms_member_select"
  on public.rooms for select to authenticated
  using (public.is_room_member(id, (select auth.uid())));

drop policy if exists "room_members_pair_select" on public.room_members;
create policy "room_members_pair_select"
  on public.room_members for select to authenticated
  using (public.is_room_member(room_id, (select auth.uid())));

drop policy if exists "water_entries_pair_select" on public.water_entries;
create policy "water_entries_pair_select"
  on public.water_entries for select to authenticated
  using (public.is_room_member(room_id, (select auth.uid())));

drop policy if exists "water_entries_self_insert" on public.water_entries;
create policy "water_entries_self_insert"
  on public.water_entries for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_room_member(room_id, (select auth.uid()))
  );

drop policy if exists "water_entries_self_update" on public.water_entries;
create policy "water_entries_self_update"
  on public.water_entries for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and public.is_room_member(room_id, (select auth.uid()))
  );

drop policy if exists "water_entries_self_delete" on public.water_entries;
create policy "water_entries_self_delete"
  on public.water_entries for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_self_select" on public.push_subscriptions;
create policy "push_subscriptions_self_select"
  on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_self_insert" on public.push_subscriptions;
create policy "push_subscriptions_self_insert"
  on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_self_update" on public.push_subscriptions;
create policy "push_subscriptions_self_update"
  on public.push_subscriptions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "push_subscriptions_self_delete" on public.push_subscriptions;
create policy "push_subscriptions_self_delete"
  on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "notification_jobs_sender_select" on public.notification_jobs;
create policy "notification_jobs_sender_select"
  on public.notification_jobs for select to authenticated
  using (sender_user_id = (select auth.uid()));

drop policy if exists "notification_jobs_pair_insert" on public.notification_jobs;
create policy "notification_jobs_pair_insert"
  on public.notification_jobs for insert to authenticated
  with check (
    sender_user_id = (select auth.uid())
    and sender_user_id <> recipient_user_id
    and public.is_room_member(room_id, sender_user_id)
    and public.is_room_member(room_id, recipient_user_id)
  );

revoke all on public.profiles, public.rooms, public.room_members, public.water_entries,
  public.push_subscriptions, public.notification_jobs from anon;
grant select, insert, update, delete on public.profiles, public.rooms, public.room_members,
  public.water_entries, public.push_subscriptions, public.notification_jobs to authenticated;

revoke all on function public.create_pair(text) from public;
revoke all on function public.join_pair(text, text) from public;
revoke all on function public.is_room_member(uuid, uuid) from public;
revoke all on function public.shares_room(uuid, uuid) from public;
grant execute on function public.create_pair(text) to authenticated;
grant execute on function public.join_pair(text, text) to authenticated;
grant execute on function public.is_room_member(uuid, uuid) to authenticated;
grant execute on function public.shares_room(uuid, uuid) to authenticated;
