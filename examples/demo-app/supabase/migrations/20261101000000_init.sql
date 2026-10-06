-- Demo schema with one seeded issue per supacheck rule. Do not copy.

create table public.notes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  title text,
  body text
);
alter table public.notes enable row level security;
-- select-true-on-private-data: per-user notes readable by everyone
create policy "Enable read access for all users" on public.notes
  for select using (true);

-- grant-write-without-rls: anon can write, RLS never enabled
create table public.orders (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users,
  total numeric
);
grant insert, update on public.orders to anon;

-- rls-disabled-on-exposed-table
create table public.invoices (
  id bigint generated always as identity primary key,
  customer_email text,
  amount numeric
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  action text
);
alter table public.audit_log enable row level security;
-- service-role-policy-without-to: opens inserts to everyone
create policy "Service role can insert audit log" on public.audit_log
  for insert with check (true);

create table public.feedback (
  id bigint generated always as identity primary key,
  author_id uuid references auth.users,
  message text
);
alter table public.feedback enable row level security;
-- rls-policy-always-true-write
create policy "Anyone can update feedback" on public.feedback
  for update to authenticated using (true);

create table public.announcements (
  id bigint generated always as identity primary key,
  title text,
  body text
);
alter table public.announcements enable row level security;
-- team-wide-access-confirm-signup (info) + missing-api-grants-new-table (no grants after 2026-10-30)
create policy "Signed in users read announcements" on public.announcements
  for select to authenticated using (true);

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  role text default 'member'
);
alter table public.profiles enable row level security;
create policy "Users read own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
grant select on public.profiles to authenticated;

-- user-metadata-for-authorization: role copied from user-writable metadata at signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data ->> 'full_name', coalesce(new.raw_user_meta_data ->> 'role', 'member'));
  return new;
end;
$$;

-- definer-function-no-caller-check: anyone can read any user's orders over /rpc
create or replace function public.get_user_orders(p_user uuid)
returns setof public.orders
language sql
security definer
set search_path = ''
as $$
  select * from public.orders where user_id = p_user;
$$;
