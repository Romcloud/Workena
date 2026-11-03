create table public.google_calendar_connections (
  company_id uuid primary key references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  sync_token text,
  last_sync_at timestamptz,
  sync_lock_until timestamptz,
  sync_lock_token uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, company_id)
);

create table public.google_work_order_events (
  work_order_id uuid primary key references public.work_orders(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  google_event_id text not null,
  work_order_updated_at timestamptz not null,
  google_updated_at timestamptz not null,
  google_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, google_event_id)
);

create index google_work_order_events_company_idx
  on public.google_work_order_events(company_id);

alter table public.google_calendar_connections enable row level security;
alter table public.google_work_order_events enable row level security;
revoke all on public.google_calendar_connections from public, anon, authenticated;
revoke all on public.google_work_order_events from public, anon, authenticated;
grant all on public.google_calendar_connections to service_role;
grant all on public.google_work_order_events to service_role;

notify pgrst, 'reload schema';
