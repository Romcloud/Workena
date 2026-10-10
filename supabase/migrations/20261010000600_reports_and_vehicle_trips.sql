create table public.vehicle_trips (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  work_order_id uuid references public.work_orders(id) on delete set null,
  trip_date date not null default current_date,
  origin text not null check (char_length(trim(origin)) between 2 and 250),
  destination text not null check (char_length(trim(destination)) between 2 and 250),
  is_round_trip boolean not null default false,
  calculated_one_way_km numeric(8, 2) check (
    calculated_one_way_km is null or calculated_one_way_km between 0.01 and 1000
  ),
  distance_km numeric(8, 2) not null check (distance_km > 0 and distance_km <= 2000),
  distance_source text not null check (distance_source in ('MAP', 'MANUAL', 'MAP_EDITED')),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  constraint vehicle_trips_work_order_id_fkey
    foreign key (work_order_id) references public.work_orders(id) on delete set null
);

create index vehicle_trips_company_date_idx
  on public.vehicle_trips(company_id, trip_date desc);
create index vehicle_trips_user_date_idx
  on public.vehicle_trips(user_id, trip_date desc);
create index vehicle_trips_order_date_idx
  on public.vehicle_trips(work_order_id, trip_date desc);

alter table public.vehicle_trips enable row level security;

create policy "Members read own trips and managers read company trips"
  on public.vehicle_trips for select to authenticated
  using (
    (user_id = (select auth.uid()) and (select public.is_company_member(company_id)))
    or (select public.can_manage_company(company_id))
  );

revoke all on public.vehicle_trips from anon, authenticated;
grant select on public.vehicle_trips to authenticated;

create or replace function public.create_vehicle_trip(
  p_company_id uuid,
  p_work_order_id uuid,
  p_trip_date date,
  p_origin text,
  p_destination text,
  p_is_round_trip boolean,
  p_calculated_one_way_km numeric,
  p_distance_km numeric,
  p_distance_source text,
  p_note text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_trip_id uuid;
begin
  if not (select public.is_company_member(p_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;
  if p_trip_date is null
    or p_origin is null or char_length(trim(p_origin)) not between 2 and 250
    or p_destination is null or char_length(trim(p_destination)) not between 2 and 250
    or p_distance_km is null or p_distance_km <= 0 or p_distance_km > 2000
    or p_distance_source is null or p_distance_source not in ('MAP', 'MANUAL', 'MAP_EDITED')
    or p_calculated_one_way_km is not null and p_calculated_one_way_km <= 0
    or p_note is not null and char_length(p_note) > 2000 then
    raise exception 'Skontrolujte adresy, dátum, kilometre a poznámku k jazde.';
  end if;
  if p_distance_source <> 'MANUAL' and p_calculated_one_way_km is null then
    raise exception 'Pre výpočet podľa mapy chýba vzdialenosť trasy.';
  end if;
  if p_distance_source = 'MAP'
    and p_distance_km <> round(
      p_calculated_one_way_km * case when coalesce(p_is_round_trip, false) then 2 else 1 end,
      2
    ) then
    raise exception 'Kilometre z mapy nezodpovedajú jednosmernej alebo spiatočnej trase.';
  end if;
  if p_work_order_id is not null and not exists (
    select 1 from public.work_orders w
    where w.id = p_work_order_id and w.company_id = p_company_id
      and w.assignee_id = (select auth.uid())
      and (select public.is_company_member(w.company_id))
  ) then
    raise exception 'Vybraná zákazka neexistuje alebo vám nie je priradená.';
  end if;

  insert into public.vehicle_trips(
    company_id, user_id, work_order_id, trip_date, origin, destination,
    is_round_trip, calculated_one_way_km, distance_km, distance_source, note
  )
  values (
    p_company_id, (select auth.uid()), p_work_order_id, p_trip_date, trim(p_origin),
    trim(p_destination), coalesce(p_is_round_trip, false), p_calculated_one_way_km,
    p_distance_km, p_distance_source, nullif(trim(p_note), '')
  )
  returning id into v_trip_id;
  return v_trip_id;
end;
$$;

revoke all on function public.create_vehicle_trip(uuid, uuid, date, text, text, boolean, numeric, numeric, text, text) from public, anon;
grant execute on function public.create_vehicle_trip(uuid, uuid, date, text, text, boolean, numeric, numeric, text, text) to authenticated;
