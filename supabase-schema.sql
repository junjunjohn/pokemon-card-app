-- Run this once in Supabase: Dashboard → SQL Editor → paste → Run.
-- Sets up username/password auth entirely inside Postgres — no email
-- anywhere, no dependency on Supabase's Auth service or its email sending.

-- Enables crypt()/gen_salt() for secure password hashing. Supabase installs
-- this into the "extensions" schema, not "public" — hence the search_path
-- on the functions below includes both.
create extension if not exists pgcrypto;

-- Row Level Security is enabled with NO policies for anon/authenticated,
-- so this table is completely unreachable directly from the browser client.
-- The only way in is through the two SECURITY DEFINER functions below,
-- which run with elevated privileges and expose nothing but a safe,
-- narrow signup/login surface.
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists users_username_lower_idx
  on public.users (lower(username));

alter table public.users enable row level security;

-- Create a new account. Raises an exception (surfaced to the client as an
-- RPC error) on invalid input or a taken username.
create or replace function public.signup_user(p_username text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  if p_username is null or length(p_username) < 3 or length(p_username) > 40 then
    raise exception 'Username must be 3–40 characters.';
  end if;
  if p_username !~ '^[a-zA-Z0-9_.-]+$' then
    raise exception 'Username can only contain letters, numbers, underscore, dot, and dash.';
  end if;
  if p_password is null or length(p_password) < 6 then
    raise exception 'Password must be at least 6 characters.';
  end if;

  if exists (select 1 from public.users where lower(username) = lower(p_username)) then
    raise exception 'That username is already taken.';
  end if;

  insert into public.users (username, password_hash)
  values (p_username, extensions.crypt(p_password, extensions.gen_salt('bf')))
  returning id into v_id;

  return json_build_object('id', v_id, 'username', p_username);
end;
$$;

-- Verify credentials. Returns {id, username} on success; raises a generic
-- error on failure without revealing whether the username exists at all.
create or replace function public.login_user(p_username text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.users;
begin
  select * into v_user from public.users where lower(username) = lower(p_username);

  if v_user.id is null or v_user.password_hash <> extensions.crypt(p_password, v_user.password_hash) then
    raise exception 'Invalid username or password.';
  end if;

  return json_build_object('id', v_user.id, 'username', v_user.username);
end;
$$;

-- Let the publishable/anon key call these two functions — but grant NOTHING
-- directly on the users table itself (no select/insert/update/delete grants).
grant execute on function public.signup_user(text, text) to anon;
grant execute on function public.login_user(text, text) to anon;

-- ============================================================
-- Session tokens + portfolio (added for the "My Portfolio" tab)
-- ============================================================
--
-- Our custom login has no real session — the client just remembers a
-- username in localStorage, which was fine when the only thing behind
-- login was public price data. A portfolio holds actual per-person data,
-- so it needs real protection: a session_token (opaque, unguessable uuid)
-- issued at login/signup, required on every portfolio action, checked
-- server-side before touching that user's rows. It doesn't expire on its
-- own — logging in again rotates it — which is a real simplification vs.
-- a proper auth system, but is a large step up from trusting a bare
-- username with no verification at all.

alter table public.users add column if not exists session_token uuid;

create or replace function public.signup_user(p_username text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
  v_token uuid;
begin
  if p_username is null or length(p_username) < 3 or length(p_username) > 40 then
    raise exception 'Username must be 3–40 characters.';
  end if;
  if p_username !~ '^[a-zA-Z0-9_.-]+$' then
    raise exception 'Username can only contain letters, numbers, underscore, dot, and dash.';
  end if;
  if p_password is null or length(p_password) < 6 then
    raise exception 'Password must be at least 6 characters.';
  end if;

  if exists (select 1 from public.users where lower(username) = lower(p_username)) then
    raise exception 'That username is already taken.';
  end if;

  v_token := gen_random_uuid();

  insert into public.users (username, password_hash, session_token)
  values (p_username, extensions.crypt(p_password, extensions.gen_salt('bf')), v_token)
  returning id into v_id;

  return json_build_object('id', v_id, 'username', p_username, 'session_token', v_token);
end;
$$;

create or replace function public.login_user(p_username text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.users;
  v_token uuid;
begin
  select * into v_user from public.users where lower(username) = lower(p_username);

  if v_user.id is null or v_user.password_hash <> extensions.crypt(p_password, v_user.password_hash) then
    raise exception 'Invalid username or password.';
  end if;

  v_token := gen_random_uuid();
  update public.users set session_token = v_token where id = v_user.id;

  return json_build_object('id', v_user.id, 'username', v_user.username, 'session_token', v_token);
end;
$$;

-- Resolves a session_token to a user id, or raises. Called at the top of
-- every portfolio function below — nothing touches portfolio_cards without
-- a valid token.
create or replace function public.current_user_id(p_session_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_session_token is null then
    raise exception 'Not logged in.';
  end if;
  select id into v_id from public.users where session_token = p_session_token;
  if v_id is null then
    raise exception 'Session expired — please log in again.';
  end if;
  return v_id;
end;
$$;

create table if not exists public.portfolio_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  card_id text not null,
  card_name text not null,
  card_image text,
  set_name text,
  added_at timestamptz not null default now(),
  unique (user_id, card_id)
);

alter table public.portfolio_cards enable row level security;
-- No policies added on purpose — same locked-down pattern as public.users.
-- Only reachable through the SECURITY DEFINER functions below.

create or replace function public.add_portfolio_card(
  p_session_token uuid, p_card_id text, p_card_name text, p_card_image text, p_set_name text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  v_user_id := public.current_user_id(p_session_token);

  if p_card_id is null or p_card_name is null then
    raise exception 'Missing card details.';
  end if;

  insert into public.portfolio_cards (user_id, card_id, card_name, card_image, set_name)
  values (v_user_id, p_card_id, p_card_name, p_card_image, p_set_name)
  on conflict (user_id, card_id) do nothing;

  return json_build_object('ok', true);
end;
$$;

create or replace function public.remove_portfolio_card(p_session_token uuid, p_card_id text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  v_user_id := public.current_user_id(p_session_token);
  delete from public.portfolio_cards where user_id = v_user_id and card_id = p_card_id;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.get_portfolio(p_session_token uuid)
returns setof public.portfolio_cards
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  v_user_id := public.current_user_id(p_session_token);
  return query
    select * from public.portfolio_cards where user_id = v_user_id order by added_at desc;
end;
$$;

grant execute on function public.current_user_id(uuid) to anon;
grant execute on function public.add_portfolio_card(uuid, text, text, text, text) to anon;
grant execute on function public.remove_portfolio_card(uuid, text) to anon;
grant execute on function public.get_portfolio(uuid) to anon;

-- ============================================================
-- Shared Top Picks cache (reduces load on the flaky external API)
-- ============================================================
-- Card price data is public — no user association, no protection beyond
-- basic sanity needed. A single row (id = 1) holds the last successful
-- 20-card scan; whichever visitor's browser succeeds at fetching fresh
-- data writes it back here, so later visitors read from our own reliable
-- database instead of hitting the flaky upstream API directly.

create table if not exists public.cached_top_picks (
  id int primary key default 1,
  cards jsonb not null,
  fetched_at timestamptz not null default now(),
  constraint cached_top_picks_singleton check (id = 1)
);

alter table public.cached_top_picks enable row level security;

drop policy if exists "Anyone can read the shared cache" on public.cached_top_picks;
create policy "Anyone can read the shared cache"
  on public.cached_top_picks for select
  to anon
  using (true);

create or replace function public.refresh_top_picks_cache(p_cards jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_cards is null or jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) = 0 then
    raise exception 'No cards provided.';
  end if;

  insert into public.cached_top_picks (id, cards, fetched_at)
  values (1, p_cards, now())
  on conflict (id) do update set cards = excluded.cards, fetched_at = excluded.fetched_at;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.refresh_top_picks_cache(jsonb) to anon;
