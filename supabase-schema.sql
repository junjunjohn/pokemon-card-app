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
