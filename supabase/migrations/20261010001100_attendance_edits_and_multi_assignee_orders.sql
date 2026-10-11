create table public.work_order_assignees (
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (work_order_id, user_id)
);

insert into public.work_order_assignees(work_order_id, company_id, user_id)
select id, company_id, assignee_id
from public.work_orders
on conflict (work_order_id, user_id) do nothing;

create index work_order_assignees_user_idx
  on public.work_order_assignees(user_id, work_order_id);

alter table public.companies
  add column selected_plan text check (selected_plan is null or selected_plan in ('BASIC', 'PRO', 'TEAM'));

create or replace function public.select_company_plan(p_company_id uuid, p_plan text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_plan is null or p_plan not in ('BASIC', 'PRO', 'TEAM') then
    raise exception 'Vyberte platný balík.';
  end if;
  if not (select public.can_manage_company(p_company_id)) then
    raise exception 'Balík môže vybrať iba vlastník alebo vedúci firmy.';
  end if;
  update public.companies
  set selected_plan = p_plan
  where id = p_company_id;
  if not found then
    raise exception 'Firemný priestor sa nenašiel.';
  end if;
end;
$$;

alter table public.work_order_assignees enable row level security;
create policy "Managers and assigned employees read assignments"
  on public.work_order_assignees for select to authenticated
  using (
    (select public.can_manage_company(company_id))
    or (
      user_id = (select auth.uid())
      and (select public.is_company_member(company_id))
    )
  );
revoke all on public.work_order_assignees from anon, authenticated;
grant select on public.work_order_assignees to authenticated;

drop policy if exists "Managers read company work orders and employees read assigned work"
  on public.work_orders;
create policy "Managers and assigned employees read work orders"
  on public.work_orders for select to authenticated
  using (
    (select public.can_manage_company(company_id))
    or exists (
      select 1 from public.work_order_assignees a
      where a.work_order_id = work_orders.id
        and a.company_id = work_orders.company_id
        and a.user_id = (select auth.uid())
        and (select public.is_company_member(a.company_id))
    )
  );

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
begin
  select m.role into v_actor_role
  from public.memberships m
  where m.company_id = p_company_id
    and m.user_id = (select auth.uid())
    and m.active;
  if v_actor_role not in ('OWNER', 'MANAGER') then
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

  insert into public.work_order_assignees(work_order_id, company_id, user_id)
  select v_work_order_id, p_company_id, selected.user_id
  from unnest(p_assignee_ids) as selected(user_id);
  return v_work_order_id;
end;
$$;

create or replace function public.create_work_order(
  p_company_id uuid,
  p_assignee_id uuid,
  p_title text,
  p_address text,
  p_due_date date,
  p_description text
)
returns uuid
language sql security definer set search_path = ''
as $$
  select public.create_work_order_multi(
    p_company_id, array[p_assignee_id], p_title, p_address, p_due_date, p_description
  );
$$;

create or replace function public.accept_work_order_assignment(p_work_order_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.work_order_assignees a
  set accepted_at = coalesce(a.accepted_at, now())
  where a.work_order_id = p_work_order_id
    and a.user_id = (select auth.uid())
    and (select public.is_company_member(a.company_id));
  if not found then
    raise exception 'Zákazka vám nebola priradená alebo už nemáte prístup.';
  end if;
end;
$$;

create or replace function public.update_assigned_work_order(
  p_work_order_id uuid,
  p_status text,
  p_employee_note text
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('IN_PROGRESS', 'DONE')
    or p_employee_note is not null and char_length(p_employee_note) > 2000 then
    raise exception 'Skontrolujte stav zákazky a poznámku.';
  end if;

  update public.work_orders w
  set status = p_status,
      employee_note = nullif(trim(p_employee_note), ''),
      updated_at = now()
  where w.id = p_work_order_id
    and (select public.is_company_member(w.company_id))
    and exists (
      select 1 from public.work_order_assignees a
      where a.work_order_id = w.id and a.user_id = (select auth.uid())
        and a.accepted_at is not null
    );
  if not found then
    raise exception 'Zákazka neexistuje alebo ju nemôžete upraviť.';
  end if;
end;
$$;

drop policy if exists "Managers and assigned employees read work order photos"
  on public.work_order_photos;
create policy "Managers and assigned employees read work order photos"
  on public.work_order_photos for select to authenticated
  using (
    (select public.can_manage_company(company_id))
    or exists (
      select 1 from public.work_order_assignees a
      where a.work_order_id = work_order_photos.work_order_id
        and a.company_id = work_order_photos.company_id
        and a.user_id = (select auth.uid())
        and a.accepted_at is not null
        and (select public.is_company_member(a.company_id))
    )
  );

drop policy if exists "Managers and assigned employees view work order photos" on storage.objects;
create policy "Managers and assigned employees view work order photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'work-order-photos'
    and exists (
      select 1 from public.work_orders w
      where w.company_id::text = (storage.foldername(name))[1]
        and w.id::text = (storage.foldername(name))[2]
        and (
          (select public.can_manage_company(w.company_id))
          or exists (
            select 1 from public.work_order_assignees a
            where a.work_order_id = w.id and a.user_id = (select auth.uid())
              and a.accepted_at is not null
              and (select public.is_company_member(a.company_id))
          )
        )
    )
  );

drop policy if exists "Assigned employees upload work order photos" on storage.objects;
create policy "Assigned employees upload work order photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'work-order-photos'
    and (storage.foldername(name))[3] in ('before', 'after')
    and exists (
      select 1 from public.work_orders w
      join public.work_order_assignees a on a.work_order_id = w.id
      where w.company_id::text = (storage.foldername(name))[1]
        and w.id::text = (storage.foldername(name))[2]
        and a.user_id = (select auth.uid())
        and a.accepted_at is not null
        and (select public.is_company_member(a.company_id))
    )
  );

drop policy if exists "Managers and assigned employees remove work order photos" on storage.objects;
create policy "Managers and assigned employees remove work order photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'work-order-photos'
    and exists (
      select 1 from public.work_orders w
      where w.company_id::text = (storage.foldername(name))[1]
        and w.id::text = (storage.foldername(name))[2]
        and (
          (select public.can_manage_company(w.company_id))
          or exists (
            select 1 from public.work_order_assignees a
            where a.work_order_id = w.id and a.user_id = (select auth.uid())
              and a.accepted_at is not null
              and (select public.is_company_member(a.company_id))
          )
        )
    )
  );

create or replace function public.add_work_order_photo(
  p_work_order_id uuid,
  p_phase text,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes integer
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_photo_id uuid;
  v_phase_folder text;
  v_photo_count integer;
begin
  if p_phase is null or p_phase not in ('BEFORE', 'AFTER')
    or p_file_name is null or char_length(p_file_name) not between 1 and 255
    or p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
    or p_size_bytes is null or p_size_bytes not between 1 and 8388608 then
    raise exception 'Fotografia má neplatný typ, názov alebo veľkosť.';
  end if;

  select w.company_id into v_company_id
  from public.work_orders w
  join public.work_order_assignees a on a.work_order_id = w.id
  where w.id = p_work_order_id
    and a.user_id = (select auth.uid())
    and a.accepted_at is not null
    and (select public.is_company_member(w.company_id))
  for update of w;
  if v_company_id is null then
    raise exception 'Zákazka neexistuje alebo k nej nemáte prístup.';
  end if;

  v_phase_folder := case p_phase when 'BEFORE' then 'before' else 'after' end;
  if p_storage_path !~ (
    '^' || v_company_id::text || '/' || p_work_order_id::text || '/' || v_phase_folder || '/[^/]+$'
  ) then
    raise exception 'Cesta fotografie nezodpovedá zákazke.';
  end if;

  select count(*)::integer into v_photo_count
  from public.work_order_photos p
  where p.work_order_id = p_work_order_id and p.phase = p_phase;
  if v_photo_count >= 10 then
    raise exception 'Ku každej fáze zákazky môžete pridať najviac 10 fotografií.';
  end if;

  insert into public.work_order_photos(
    company_id, work_order_id, phase, storage_path, file_name, mime_type, size_bytes
  )
  values (v_company_id, p_work_order_id, p_phase, p_storage_path, p_file_name, p_mime_type, p_size_bytes)
  returning id into v_photo_id;
  return v_photo_id;
end;
$$;

create or replace function public.submit_work_order_report(
  p_work_order_id uuid,
  p_status text,
  p_employee_note text,
  p_employee_materials text,
  p_work_report text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_status text;
begin
  if p_status is null or p_status not in ('IN_PROGRESS', 'DONE')
    or p_employee_note is not null and char_length(p_employee_note) > 2000
    or p_employee_materials is not null and char_length(p_employee_materials) > 4000
    or p_work_report is not null and char_length(p_work_report) > 4000 then
    raise exception 'Skontrolujte stav zákazky a obsah výkazu.';
  end if;
  if p_status = 'DONE' and char_length(trim(coalesce(p_work_report, ''))) < 2 then
    raise exception 'Pred označením zákazky ako hotovej vyplňte výkaz práce.';
  end if;

  select w.status into v_status
  from public.work_orders w
  join public.work_order_assignees a on a.work_order_id = w.id
  where w.id = p_work_order_id
    and a.user_id = (select auth.uid())
    and a.accepted_at is not null
    and (select public.is_company_member(w.company_id))
  for update of w;
  if v_status is null then
    raise exception 'Zákazka neexistuje alebo ju nemôžete upraviť.';
  end if;
  if v_status = 'DONE' and p_status <> 'DONE' then
    raise exception 'Dokončenú zákazku už nemožno vrátiť do rozpracovaného stavu.';
  end if;

  update public.work_orders
  set status = p_status,
      employee_note = nullif(trim(p_employee_note), ''),
      employee_materials = nullif(trim(p_employee_materials), ''),
      work_report = nullif(trim(p_work_report), ''),
      report_submitted_at = case when p_status = 'DONE' then now() else report_submitted_at end,
      updated_at = now()
  where id = p_work_order_id;
end;
$$;

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
    select 1
    from public.work_order_assignees a
    where a.work_order_id = p_work_order_id
      and a.company_id = p_company_id
      and a.user_id = (select auth.uid())
      and a.accepted_at is not null
      and (select public.is_company_member(a.company_id))
  ) then
    raise exception 'Vybraná zákazka neexistuje alebo ste ju neprijali.';
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

create or replace function public.update_attendance_shift(
  p_shift_id uuid,
  p_started_at timestamptz,
  p_ended_at timestamptz
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_user_id uuid;
  v_source_work_entry_id uuid;
begin
  if p_started_at is null or (p_ended_at is not null and p_ended_at <= p_started_at) then
    raise exception 'Začiatok a koniec zmeny nie sú platné.';
  end if;

  select s.company_id, s.user_id, s.source_work_entry_id
  into v_company_id, v_user_id, v_source_work_entry_id
  from public.attendance_shifts s
  where s.id = p_shift_id
  for update;
  if v_company_id is null then
    raise exception 'Dochádzkový záznam neexistuje.';
  end if;
  if not (select public.is_company_member(v_company_id))
    or (v_user_id <> (select auth.uid()) and not (select public.can_manage_company(v_company_id))) then
    raise exception 'Tento dochádzkový záznam nemôžete upraviť.';
  end if;
  if v_source_work_entry_id is not null then
    raise exception 'Dochádzka vytvorená z pracovného záznamu sa upravuje cez pôvodný pracovný záznam.';
  end if;
  if exists (
    select 1
    from public.attendance_breaks b
    where b.shift_id = p_shift_id
      and (
        b.started_at < p_started_at
        or (p_ended_at is not null and (
          b.ended_at is null or b.ended_at > p_ended_at
        ))
      )
  ) then
    raise exception 'Čas zmeny musí obsahovať všetky zaznamenané prestávky.';
  end if;

  update public.attendance_shifts
  set started_at = p_started_at, ended_at = p_ended_at
  where id = p_shift_id;
end;
$$;

revoke all on function public.create_work_order_multi(uuid, uuid[], text, text, date, text) from public, anon;
revoke all on function public.accept_work_order_assignment(uuid) from public, anon;
revoke all on function public.update_attendance_shift(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.select_company_plan(uuid, text) from public, anon;
grant execute on function public.create_work_order_multi(uuid, uuid[], text, text, date, text) to authenticated;
grant execute on function public.accept_work_order_assignment(uuid) to authenticated;
grant execute on function public.update_attendance_shift(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.select_company_plan(uuid, text) to authenticated;

notify pgrst, 'reload schema';
