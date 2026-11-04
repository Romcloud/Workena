alter table public.google_calendar_connections
  drop constraint google_calendar_connections_pkey,
  add primary key (company_id, user_id);

alter table public.google_work_order_events
  add column user_id uuid;

update public.google_work_order_events as event_mapping
set user_id = connection.user_id
from public.google_calendar_connections as connection
where connection.company_id = event_mapping.company_id;

update public.google_work_order_events as event_mapping
set user_id = (
  select membership.user_id
  from public.memberships as membership
  where membership.company_id = event_mapping.company_id
    and membership.role = 'OWNER'
  order by membership.active desc, membership.created_at
  limit 1
)
where event_mapping.user_id is null;

alter table public.google_work_order_events
  alter column user_id set not null,
  add constraint google_work_order_events_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  drop constraint google_work_order_events_pkey,
  drop constraint google_work_order_events_company_id_google_event_id_key,
  add primary key (company_id, user_id, work_order_id),
  add constraint google_work_order_events_calendar_event_key
    unique (company_id, user_id, google_event_id);

create index google_work_order_events_user_idx
  on public.google_work_order_events(company_id, user_id);

notify pgrst, 'reload schema';
