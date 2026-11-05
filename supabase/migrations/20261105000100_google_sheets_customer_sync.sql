create table public.google_sheets_customer_connections (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  web_app_url text,
  shared_secret text not null,
  snapshot jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  sync_lock_until timestamptz,
  sync_lock_token uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

create table public.google_sheets_customer_deletions (
  customer_id uuid not null,
  company_id uuid not null,
  salesperson_id uuid not null,
  deleted_at timestamptz not null default now(),
  primary key (customer_id, company_id)
);

alter table public.google_sheets_customer_connections enable row level security;
alter table public.google_sheets_customer_deletions enable row level security;
revoke all on public.google_sheets_customer_connections from public, anon, authenticated;
revoke all on public.google_sheets_customer_deletions from public, anon, authenticated;
grant all on public.google_sheets_customer_connections to service_role;
grant all on public.google_sheets_customer_deletions to service_role;

create or replace function public.track_google_sheets_customer_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.google_sheets_customer_deletions(customer_id, company_id, salesperson_id, deleted_at)
  values (old.id, old.company_id, old.salesperson_id, now())
  on conflict (customer_id, company_id)
  do update set salesperson_id = excluded.salesperson_id, deleted_at = excluded.deleted_at;
  return old;
end;
$$;

revoke all on function public.track_google_sheets_customer_deletion() from public, anon, authenticated;

create trigger customers_track_google_sheets_deletion
  before delete on public.customers
  for each row execute function public.track_google_sheets_customer_deletion();

create or replace function public.clear_google_sheets_deletions_for_company()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.google_sheets_customer_deletions where company_id = old.id;
  return old;
end;
$$;

revoke all on function public.clear_google_sheets_deletions_for_company() from public, anon, authenticated;

create trigger companies_clear_google_sheets_deletions
  after delete on public.companies
  for each row execute function public.clear_google_sheets_deletions_for_company();

notify pgrst, 'reload schema';
