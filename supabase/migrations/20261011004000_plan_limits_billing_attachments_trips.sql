-- Large feature batch:
--   1) Absence requests gain an optional file attachment (storage bucket + metadata RPC).
--   2) Company billing details for invoicing.
--   3) Per-plan limits: employee headcount, number of companies an owner may run,
--      and work-order assignment gating for the Basic tier.
--   4) Vehicle trips gain intermediate stops and an optional different return destination.

-- 1) Absence attachments -----------------------------------------------------

alter table public.absence_requests
  add column attachment_path text,
  add column attachment_file_name text check (
    attachment_file_name is null or char_length(attachment_file_name) between 1 and 255
  ),
  add column attachment_mime_type text check (
    attachment_mime_type is null or attachment_mime_type in (
      'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
    )
  ),
  add column attachment_size_bytes integer check (
    attachment_size_bytes is null or attachment_size_bytes between 1 and 8388608
  );

create or replace function public.attach_absence_file(
  p_absence_id uuid,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes integer
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_file_name is null or char_length(p_file_name) not between 1 and 255
    or p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
    or p_size_bytes is null or p_size_bytes not between 1 and 8388608 then
    raise exception 'Neplatná príloha.';
  end if;

  update public.absence_requests
  set attachment_path = p_storage_path,
      attachment_file_name = p_file_name,
      attachment_mime_type = p_mime_type,
      attachment_size_bytes = p_size_bytes,
      updated_at = now()
  where id = p_absence_id
    and user_id = (select auth.uid());
  if not found then
    raise exception 'Žiadosť sa nenašla alebo k nej nemôžete pridať prílohu.';
  end if;
end;
$$;

revoke all on function public.attach_absence_file(uuid, text, text, text, integer) from public, anon;
grant execute on function public.attach_absence_file(uuid, text, text, text, integer) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'absence-attachments', 'absence-attachments', false, 8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Members view own absence files and managers view company files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'absence-attachments'
    and exists (
      select 1 from public.absence_requests a
      where a.company_id::text = (storage.foldername(name))[1]
        and a.id::text = (storage.foldername(name))[2]
        and (
          a.user_id = (select auth.uid())
          or (select public.can_manage_company(a.company_id))
        )
    )
  );

create policy "Requesters upload their own absence files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'absence-attachments'
    and exists (
      select 1 from public.absence_requests a
      where a.company_id::text = (storage.foldername(name))[1]
        and a.id::text = (storage.foldername(name))[2]
        and a.user_id = (select auth.uid())
    )
  );

create policy "Requesters remove their own absence files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'absence-attachments'
    and exists (
      select 1 from public.absence_requests a
      where a.company_id::text = (storage.foldername(name))[1]
        and a.id::text = (storage.foldername(name))[2]
        and a.user_id = (select auth.uid())
    )
  );

-- 2) Company billing details -------------------------------------------------

alter table public.companies
  add column billing_name text check (billing_name is null or char_length(billing_name) <= 200),
  add column billing_ico text check (billing_ico is null or char_length(billing_ico) <= 20),
  add column billing_dic text check (billing_dic is null or char_length(billing_dic) <= 20),
  add column billing_ic_dph text check (billing_ic_dph is null or char_length(billing_ic_dph) <= 20),
  add column billing_address text check (billing_address is null or char_length(billing_address) <= 400);

create or replace function public.update_company_billing_details(
  p_company_id uuid,
  p_billing_name text,
  p_billing_ico text,
  p_billing_dic text,
  p_billing_ic_dph text,
  p_billing_address text
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (select public.can_manage_company(p_company_id)) then
    raise exception 'Fakturačné údaje môže upraviť iba vlastník alebo vedúci firmy.';
  end if;
  if (p_billing_name is not null and char_length(p_billing_name) > 200)
    or (p_billing_ico is not null and char_length(p_billing_ico) > 20)
    or (p_billing_dic is not null and char_length(p_billing_dic) > 20)
    or (p_billing_ic_dph is not null and char_length(p_billing_ic_dph) > 20)
    or (p_billing_address is not null and char_length(p_billing_address) > 400) then
    raise exception 'Skontrolujte dĺžku fakturačných údajov.';
  end if;

  update public.companies
  set billing_name = nullif(trim(p_billing_name), ''),
      billing_ico = nullif(trim(p_billing_ico), ''),
      billing_dic = nullif(trim(p_billing_dic), ''),
      billing_ic_dph = nullif(trim(p_billing_ic_dph), ''),
      billing_address = nullif(trim(p_billing_address), '')
  where id = p_company_id;
  if not found then
    raise exception 'Firma sa nenašla.';
  end if;
end;
$$;

revoke all on function public.update_company_billing_details(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.update_company_billing_details(uuid, text, text, text, text, text) to authenticated;

-- 3) Per-plan limits ----------------------------------------------------------

create or replace function public.plan_employee_limit(p_plan text)
returns integer
language sql immutable
as $$
  select case p_plan
    when 'FREE' then 2
    when 'BASIC' then 10
    when 'PRO' then 30
    else null -- TEAM: unlimited
  end;
$$;

create or replace function public.plan_company_limit(p_plan text)
returns integer
language sql immutable
as $$
  select case p_plan
    when 'FREE' then 2
    when 'BASIC' then 2
    when 'PRO' then 3
    when 'TEAM' then 5
    else 2
  end;
$$;

create or replace function public.add_company_member(
  p_company_id uuid,
  p_email text,
  p_role text default 'EMPLOYEE'
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor_role text;
  v_member_id uuid;
  v_user_id uuid;
  v_email text;
  v_full_name text;
  v_plan text;
  v_active_employee_count integer;
  v_employee_limit integer;
  v_existing_role text;
  v_existing_active boolean;
  v_requested_email text := lower(trim(p_email));
begin
  select c.plan into v_plan
    from public.companies c
    where c.id = p_company_id
    for update;
  if v_plan is null then
    raise exception 'Firemný priestor sa nenašiel.';
  end if;

  select m.role into v_actor_role
    from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.active;

  if v_actor_role is null or v_actor_role not in ('OWNER', 'MANAGER') then
    raise exception 'Na správu členov nemáte oprávnenie.';
  end if;
  if p_role is null or p_role not in ('MANAGER', 'EMPLOYEE')
    or (p_role = 'MANAGER' and v_actor_role <> 'OWNER') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;
  if v_requested_email = '' or char_length(v_requested_email) > 320 then
    raise exception 'Zadajte platnú e-mailovú adresu.';
  end if;

  select u.id, lower(u.email), nullif(trim(u.raw_user_meta_data ->> 'full_name'), '')
    into v_user_id, v_email, v_full_name
    from auth.users u
    where lower(u.email) = v_requested_email;
  if v_user_id is null then
    raise exception 'Používateľ sa ešte neprihlásil do aplikácie cez Google.';
  end if;

  select m.role, m.active
    into v_existing_role, v_existing_active
    from public.memberships m
    where m.company_id = p_company_id and m.user_id = v_user_id;
  if v_existing_active is true then
    raise exception 'Tento používateľ už je členom firmy.';
  end if;
  if v_existing_role = 'OWNER'
    or (v_existing_active is false and v_actor_role = 'MANAGER' and v_existing_role is distinct from 'EMPLOYEE')
    or (v_existing_role = 'MANAGER' and p_role <> 'MANAGER') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;

  if p_role = 'EMPLOYEE' then
    v_employee_limit := public.plan_employee_limit(v_plan);
    if v_employee_limit is not null then
      select count(*)::integer into v_active_employee_count
        from public.memberships m
        where m.company_id = p_company_id and m.role = 'EMPLOYEE' and m.active;
      if v_active_employee_count >= v_employee_limit then
        raise exception 'Balík % umožňuje najviac % zamestnancov. Pre viac zamestnancov prejdite na vyšší balík.', v_plan, v_employee_limit;
      end if;
    end if;
  end if;

  insert into public.memberships as existing_membership(company_id, user_id, email, full_name, role, active, deactivated_at)
    values (p_company_id, v_user_id, v_email, v_full_name, p_role, true, null)
    on conflict (company_id, user_id) do update
      set email = excluded.email,
          full_name = excluded.full_name,
          role = excluded.role,
          active = true,
          deactivated_at = null
      where existing_membership.active = false
    returning id into v_member_id;
  if v_member_id is null then
    raise exception 'Používateľa sa nepodarilo pridať do firmy.';
  end if;
  return v_member_id;
end;
$$;

create or replace function public.create_company(p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_owned_count integer;
  v_best_plan text;
  v_limit integer;
begin
  if p_name is null or char_length(trim(p_name)) not between 2 and 120 then
    raise exception 'Zadajte platný názov firmy.';
  end if;

  select count(*)::integer into v_owned_count
    from public.memberships m
    where m.user_id = (select auth.uid()) and m.role = 'OWNER' and m.active;

  select c.plan into v_best_plan
    from public.memberships m
    join public.companies c on c.id = m.company_id
    where m.user_id = (select auth.uid()) and m.role = 'OWNER' and m.active
    order by case c.plan when 'TEAM' then 4 when 'PRO' then 3 when 'BASIC' then 2 else 1 end desc
    limit 1;

  v_limit := public.plan_company_limit(coalesce(v_best_plan, 'FREE'));
  if v_owned_count >= v_limit then
    raise exception 'Pri aktuálnej licencii môžete vlastniť najviac % firiem. Pre ďalšiu firmu je potrebná vyššia licencia.', v_limit;
  end if;

  insert into public.companies(name, created_by)
    values (trim(p_name), (select auth.uid())) returning id into v_company_id;
  insert into public.memberships(company_id, user_id, email, full_name, role, active)
  select v_company_id, u.id, lower(u.email), nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), 'OWNER', true
  from auth.users u
  where u.id = (select auth.uid());
  return v_company_id;
end;
$$;

create or replace function public.create_work_order_multi(
  p_company_id uuid,
  p_assignee_ids uuid[],
  p_title text,
  p_address text,
  p_due_date date,
  p_description text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_work_order_id uuid;
  v_primary_assignee uuid;
  v_actor_role text;
  v_plan text;
begin
  select m.role into v_actor_role
  from public.memberships m
  where m.company_id = p_company_id
    and m.user_id = (select auth.uid())
    and m.active;
  if v_actor_role is null then
    raise exception 'Nemáte aktívne členstvo v tejto firme.';
  end if;

  select c.plan into v_plan from public.companies c where c.id = p_company_id;
  if v_plan = 'BASIC' then
    raise exception 'Balík Basic neumožňuje prideľovať zákazky. Prejdite na balík Pro alebo Team.';
  end if;

  if v_actor_role = 'EMPLOYEE' then
    if p_assignee_ids is null or cardinality(p_assignee_ids) <> 1
      or p_assignee_ids[1] <> (select auth.uid()) then
      raise exception 'Zamestnanec môže zákazku v kalendári vytvoriť iba sám pre seba.';
    end if;
  elsif v_actor_role not in ('OWNER', 'MANAGER') then
    raise exception 'Zákazky môže priraďovať iba vlastník alebo vedúci firmy.';
  end if;
  if p_assignee_ids is null or cardinality(p_assignee_ids) not between 1 and 50
    or exists (
      select 1
      from unnest(p_assignee_ids) as selected(user_id)
      left join public.memberships m
        on m.company_id = p_company_id
        and m.user_id = selected.user_id
        and m.role = 'EMPLOYEE'
        and m.active
      where m.user_id is null
    )
    or cardinality(p_assignee_ids) <> (
      select count(distinct selected.user_id)
      from unnest(p_assignee_ids) as selected(user_id)
    ) then
    raise exception 'Vyberte aspoň jedného aktívneho zamestnanca firmy bez duplicít.';
  end if;
  if p_title is null or char_length(trim(p_title)) not between 2 and 140
    or p_address is null or char_length(trim(p_address)) not between 2 and 250
    or p_due_date is null
    or p_description is null or char_length(trim(p_description)) not between 2 and 4000 then
    raise exception 'Skontrolujte názov zákazky, adresu, termín a opis práce.';
  end if;

  v_primary_assignee := p_assignee_ids[1];
  insert into public.work_orders(company_id, assignee_id, created_by, title, address, due_date, description)
  values (p_company_id, v_primary_assignee, (select auth.uid()), trim(p_title), trim(p_address), p_due_date, trim(p_description))
  returning id into v_work_order_id;

  insert into public.work_order_assignees(work_order_id, company_id, user_id, accepted_at)
  select v_work_order_id, p_company_id, selected.user_id,
    case when v_actor_role = 'EMPLOYEE' then now() else null end
  from unnest(p_assignee_ids) as selected(user_id);
  return v_work_order_id;
end;
$$;

-- 4) Vehicle trip stops and a different return destination -------------------

alter table public.vehicle_trips
  add column stops text[] not null default '{}',
  add column return_destination text check (
    return_destination is null or char_length(trim(return_destination)) between 2 and 250
  );

drop function if exists public.create_vehicle_trip(uuid, uuid, date, text, text, boolean, numeric, numeric, text, text);

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
  p_note text,
  p_stops text[] default '{}',
  p_return_destination text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_trip_id uuid;
  v_stops text[];
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
  if p_distance_source <> 'MANUAL' and p_calculated_one_way_km is null then
    raise exception 'Pre výpočet podľa mapy chýba vzdialenosť trasy.';
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
    is_round_trip, calculated_one_way_km, distance_km, distance_source, note,
    stops, return_destination
  )
  values (
    p_company_id, (select auth.uid()), p_work_order_id, p_trip_date, trim(p_origin),
    trim(p_destination), coalesce(p_is_round_trip, false), p_calculated_one_way_km,
    p_distance_km, p_distance_source, nullif(trim(p_note), ''),
    coalesce(v_stops, '{}'), nullif(trim(p_return_destination), '')
  )
  returning id into v_trip_id;
  return v_trip_id;
end;
$$;

revoke all on function public.create_vehicle_trip(uuid, uuid, date, text, text, boolean, numeric, numeric, text, text, text[], text) from public, anon;
grant execute on function public.create_vehicle_trip(uuid, uuid, date, text, text, boolean, numeric, numeric, text, text, text[], text) to authenticated;

notify pgrst, 'reload schema';
