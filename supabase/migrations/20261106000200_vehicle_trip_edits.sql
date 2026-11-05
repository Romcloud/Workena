create function public.update_vehicle_trip(
  p_trip_id uuid,
  p_work_order_id uuid,
  p_trip_date date,
  p_origin text,
  p_destination text,
  p_is_round_trip boolean,
  p_calculated_one_way_km numeric,
  p_distance_km numeric,
  p_distance_source text,
  p_note text,
  p_stops text[],
  p_return_destination text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_stops text[];
begin
  select company_id into v_company_id
  from public.vehicle_trips
  where id = p_trip_id and user_id = (select auth.uid())
  for update;
  if not found then
    raise exception 'Záznam jazdy neexistuje alebo ho nemôžete upraviť.';
  end if;
  if not (select public.is_company_member(v_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;
  if p_trip_date is null
    or p_origin is null or char_length(trim(p_origin)) not between 2 and 250
    or p_destination is null or char_length(trim(p_destination)) not between 2 and 250
    or p_distance_km is null or p_distance_km <= 0 or p_distance_km > 2000
    or p_distance_source is null or p_distance_source not in ('MAP', 'MANUAL', 'MAP_EDITED')
    or p_calculated_one_way_km is not null and p_calculated_one_way_km not between 0.01 and 1000
    or p_note is not null and char_length(p_note) > 2000 then
    raise exception 'Skontrolujte adresy, dátum, kilometre a poznámku k jazde.';
  end if;
  if p_distance_source <> 'MANUAL' and p_calculated_one_way_km is null then
    raise exception 'Pre výpočet podľa mapy chýba vzdialenosť trasy.';
  end if;
  if not coalesce(p_is_round_trip, false) and p_return_destination is not null then
    raise exception 'Iný cieľ pri návrate možno zadať iba pri spiatočnej jazde.';
  end if;
  if p_return_destination is not null and char_length(trim(p_return_destination)) not between 2 and 250 then
    raise exception 'Skontrolujte iný cieľ pri návrate.';
  end if;
  if p_stops is not null and cardinality(p_stops) > 0 then
    if cardinality(p_stops) > 10 then
      raise exception 'Najviac 10 zastávok na jednu jazdu.';
    end if;
    select array_agg(nullif(trim(stop), ''))
      into v_stops
      from unnest(p_stops) as stop
      where nullif(trim(stop), '') is not null;
    if exists (select 1 from unnest(v_stops) as s where char_length(s) not between 2 and 250) then
      raise exception 'Skontrolujte adresy zastávok.';
    end if;
  else
    v_stops := '{}';
  end if;
  if p_work_order_id is not null and not exists (
    select 1 from public.work_orders w
    where w.id = p_work_order_id and w.company_id = v_company_id
      and (
        w.assignee_id = (select auth.uid())
        or exists (
          select 1 from public.work_order_assignees a
          where a.work_order_id = w.id and a.user_id = (select auth.uid())
        )
      )
      and (select public.is_company_member(w.company_id))
  ) then
    raise exception 'Vybraná zákazka neexistuje alebo vám nie je priradená.';
  end if;

  update public.vehicle_trips
  set work_order_id = p_work_order_id,
      trip_date = p_trip_date,
      origin = trim(p_origin),
      destination = trim(p_destination),
      is_round_trip = coalesce(p_is_round_trip, false),
      calculated_one_way_km = p_calculated_one_way_km,
      distance_km = p_distance_km,
      distance_source = p_distance_source,
      note = nullif(trim(p_note), ''),
      stops = coalesce(v_stops, '{}'),
      return_destination = nullif(trim(p_return_destination), '')
  where id = p_trip_id and user_id = (select auth.uid());
  return p_trip_id;
end;
$$;

create function public.delete_vehicle_trip(p_trip_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id
  from public.vehicle_trips
  where id = p_trip_id and user_id = (select auth.uid());
  if not found then
    raise exception 'Záznam jazdy neexistuje alebo ho nemôžete vymazať.';
  end if;
  if not (select public.is_company_member(v_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;

  delete from public.vehicle_trips
  where id = p_trip_id and user_id = (select auth.uid());
end;
$$;

revoke all on function public.update_vehicle_trip(uuid, uuid, date, text, text, boolean, numeric, numeric, text, text, text[], text) from public, anon;
grant execute on function public.update_vehicle_trip(uuid, uuid, date, text, text, boolean, numeric, numeric, text, text, text[], text) to authenticated;
revoke all on function public.delete_vehicle_trip(uuid) from public, anon;
grant execute on function public.delete_vehicle_trip(uuid) to authenticated;

notify pgrst, 'reload schema';
