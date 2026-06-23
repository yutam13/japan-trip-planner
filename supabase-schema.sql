-- =====================================================================
--  Japan / Trip Planner — Supabase schema, RLS, triggers, RPCs
--  Paste this WHOLE file into:  Supabase Dashboard → SQL Editor → New query → Run
--  Safe to re-run (idempotent where practical).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
--  Tables
-- ---------------------------------------------------------------------

-- Mirror of auth.users we are allowed to read for display / sharing.
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  avatar_url   text,
  created_at   timestamptz default now()
);

-- One row per trip. The whole planner lives in `content` (JSONB).
create table if not exists public.trips (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  title      text not null default 'Untitled trip',
  content    jsonb not null default '{}'::jsonb,   -- { trip, days, customSections, locations }
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id),
  created_at timestamptz default now()
);
create index if not exists trips_owner_idx on public.trips(owner_id);

-- Roles for membership.
do $$ begin
  create type public.trip_role as enum ('owner','editor','viewer');
exception when duplicate_object then null; end $$;

create table if not exists public.trip_members (
  trip_id  uuid references public.trips(id) on delete cascade,
  user_id  uuid references auth.users(id) on delete cascade,
  role     public.trip_role not null default 'viewer',
  added_at timestamptz default now(),
  primary key (trip_id, user_id)
);
create index if not exists trip_members_user_idx on public.trip_members(user_id);

-- Invitations: email invite (email set) or open share link (email null).
create table if not exists public.trip_invites (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid references public.trips(id) on delete cascade,
  email       text,
  role        public.trip_role not null default 'viewer',
  token       text unique not null default encode(gen_random_bytes(16),'hex'),
  created_by  uuid references auth.users(id),
  created_at  timestamptz default now(),
  expires_at  timestamptz,
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz
);
create index if not exists trip_invites_trip_idx on public.trip_invites(trip_id);

-- ---------------------------------------------------------------------
--  Helper functions (SECURITY DEFINER → bypass RLS, no recursion)
-- ---------------------------------------------------------------------
create or replace function public.is_trip_member(t uuid, u uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (select 1 from public.trip_members where trip_id = t and user_id = u);
$$;

create or replace function public.trip_role_of(t uuid, u uuid)
returns public.trip_role language sql security definer stable
set search_path = public as $$
  select role from public.trip_members where trip_id = t and user_id = u;
$$;

-- Look up a user id by email WITHOUT exposing the profiles table.
create or replace function public.find_profile_by_email(p_email text)
returns table (id uuid, display_name text, avatar_url text)
language sql security definer stable
set search_path = public as $$
  select p.id, p.display_name, p.avatar_url
  from public.profiles p
  where lower(p.email) = lower(p_email)
  limit 1;
$$;

-- Accept an invitation token: add the current user as a member.
create or replace function public.accept_invite(p_token text)
returns uuid language plpgsql security definer
set search_path = public as $$
declare
  inv public.trip_invites;
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into inv from public.trip_invites where token = p_token;
  if inv.id is null then
    raise exception 'Invite not found';
  end if;
  if inv.expires_at is not null and inv.expires_at < now() then
    raise exception 'Invite expired';
  end if;

  insert into public.trip_members (trip_id, user_id, role)
  values (inv.trip_id, uid, inv.role)
  on conflict (trip_id, user_id)
    do update set role = excluded.role;

  update public.trip_invites
    set accepted_by = uid, accepted_at = now()
    where id = inv.id and accepted_by is null;

  return inv.trip_id;
end;
$$;

-- ---------------------------------------------------------------------
--  Triggers: auto-create profile, auto-add owner membership
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name',
             split_part(new.email,'@',1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(public.profiles.display_name, excluded.display_name),
        avatar_url   = coalesce(excluded.avatar_url, public.profiles.avatar_url);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.handle_new_trip()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.trip_members (trip_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (trip_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_trip_created on public.trips;
create trigger on_trip_created
  after insert on public.trips
  for each row execute function public.handle_new_trip();

-- Keep updated_at fresh on content writes.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trips_touch on public.trips;
create trigger trips_touch before update on public.trips
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.trips         enable row level security;
alter table public.trip_members  enable row level security;
alter table public.trip_invites  enable row level security;

-- profiles: only your own row (sharing lookups go through find_profile_by_email RPC)
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid());

-- trips
drop policy if exists trips_select on public.trips;
create policy trips_select on public.trips
  for select using (owner_id = auth.uid() or public.is_trip_member(id, auth.uid()));
drop policy if exists trips_insert on public.trips;
create policy trips_insert on public.trips
  for insert with check (owner_id = auth.uid());
drop policy if exists trips_update on public.trips;
create policy trips_update on public.trips
  for update using (
    owner_id = auth.uid()
    or public.trip_role_of(id, auth.uid()) in ('owner','editor')
  );
drop policy if exists trips_delete on public.trips;
create policy trips_delete on public.trips
  for delete using (owner_id = auth.uid());

-- trip_members
drop policy if exists members_select on public.trip_members;
create policy members_select on public.trip_members
  for select using (public.is_trip_member(trip_id, auth.uid()));
drop policy if exists members_write on public.trip_members;
create policy members_write on public.trip_members
  for all using (
    exists (select 1 from public.trips t where t.id = trip_id and t.owner_id = auth.uid())
  )
  with check (
    exists (select 1 from public.trips t where t.id = trip_id and t.owner_id = auth.uid())
  );

-- trip_invites: only the trip owner manages invites
drop policy if exists invites_owner on public.trip_invites;
create policy invites_owner on public.trip_invites
  for all using (
    exists (select 1 from public.trips t where t.id = trip_id and t.owner_id = auth.uid())
  )
  with check (
    exists (select 1 from public.trips t where t.id = trip_id and t.owner_id = auth.uid())
  );

-- ---------------------------------------------------------------------
--  Realtime: stream trip row changes to subscribed clients
-- ---------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.trips;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.trip_members;
exception when duplicate_object then null; end $$;

-- Done.
