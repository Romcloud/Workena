-- Add an ACCOUNTANT role: can view and edit company-wide attendance and access
-- exports/reports, but cannot manage members, work orders, billing, or licensing.

alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships
  add constraint memberships_role_check check (role in ('OWNER', 'MANAGER', 'EMPLOYEE', 'ACCOUNTANT'));

create or replace function public.can_manage_attendance(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.role in ('OWNER', 'MANAGER', 'ACCOUNTANT')
  );
$$;

revoke all on function public.can_manage_attendance(uuid) from public, anon;
grant execute on function public.can_manage_attendance(uuid) to authenticated;

-- Roster visibility: accountants need to see the whole company roster.
drop policy if exists "Active members read own membership and managers read company roster" on public.memberships;
create policy "Active members read own membership and managers read company roster"
  on public.memberships for select to authenticated
  using (
    (user_id = (select auth.uid()) and active)
    or (select public.can_manage_attendance(company_id))
  );

-- Attendance shifts/breaks: accountants can view and edit company-wide attendance.
drop policy if exists "Members read own attendance and managers read company attendance" on public.attendance_shifts;
create policy "Members read own attendance and managers read company attendance"
  on public.attendance_shifts for select to authenticated
  using (
    (user_id = (select auth.uid()) and (select public.is_company_member(company_id)))
    or (select public.can_manage_attendance(company_id))
  );

drop policy if exists "Members read own attendance breaks and managers read company breaks" on public.attendance_breaks;
create policy "Members read own attendance breaks and managers read company breaks"
  on public.attendance_breaks for select to authenticated
  using (
    exists (
      select 1
      from public.attendance_shifts s
      where s.id = shift_id
        and (
          (s.user_id = (select auth.uid()) and (select public.is_company_member(s.company_id)))
          or (select public.can_manage_attendance(s.company_id))
        )
    )
  );

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
    or (v_user_id <> (select auth.uid()) and not (select public.can_manage_attendance(v_company_id))) then
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

create or replace function public.delete_attendance_shift(p_shift_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_user_id uuid;
  v_source_work_entry_id uuid;
begin
  select s.company_id, s.user_id, s.source_work_entry_id
  into v_company_id, v_user_id, v_source_work_entry_id
  from public.attendance_shifts s
  where s.id = p_shift_id
  for update;
  if v_company_id is null then
    raise exception 'Dochádzkový záznam neexistuje.';
  end if;
  if not (select public.is_company_member(v_company_id))
    or (v_user_id <> (select auth.uid()) and not (select public.can_manage_attendance(v_company_id))) then
    raise exception 'Tento dochádzkový záznam nemôžete vymazať.';
  end if;
  if v_source_work_entry_id is not null then
    raise exception 'Dochádzka vytvorená z pracovného záznamu sa vymazáva cez pôvodný pracovný záznam.';
  end if;

  delete from public.attendance_shifts where id = p_shift_id;
end;
$$;

-- Work entries feed attendance history too: accountants need the same visibility/edit rights.
drop policy if exists "Active members read own work entries and managers read company entries" on public.work_entries;
create policy "Active members read own work entries and managers read company entries"
  on public.work_entries for select to authenticated
  using (
    (user_id = (select auth.uid()) and (select public.is_company_member(company_id)))
    or (select public.can_manage_attendance(company_id))
  );

drop policy if exists "Active authors edit pending entries and managers edit company entries" on public.work_entries;
create policy "Active authors edit pending entries and managers edit company entries"
  on public.work_entries for update to authenticated
  using (
    (user_id = (select auth.uid()) and status in ('PENDING', 'REJECTED') and (select public.is_company_member(company_id)))
    or (select public.can_manage_attendance(company_id))
  )
  with check (
    (user_id = (select auth.uid()) and status in ('PENDING', 'REJECTED') and (select public.is_company_member(company_id)))
    or (select public.can_manage_attendance(company_id))
  );

drop policy if exists "Active authors delete pending entries and managers delete company entries" on public.work_entries;
create policy "Active authors delete pending entries and managers delete company entries"
  on public.work_entries for delete to authenticated
  using (
    (user_id = (select auth.uid()) and status = 'PENDING' and (select public.is_company_member(company_id)))
    or (select public.can_manage_attendance(company_id))
  );

-- Reports/exports data: vehicle trips and work orders company-wide visibility for accountants.
drop policy if exists "Members read own trips and managers read company trips" on public.vehicle_trips;
create policy "Members read own trips and managers read company trips"
  on public.vehicle_trips for select to authenticated
  using (
    (user_id = (select auth.uid()) and (select public.is_company_member(company_id)))
    or (select public.can_manage_attendance(company_id))
  );

drop policy if exists "Managers and assigned employees read work orders" on public.work_orders;
create policy "Managers and assigned employees read work orders"
  on public.work_orders for select to authenticated
  using (
    (select public.can_manage_attendance(company_id))
    or exists (
      select 1 from public.work_order_assignees a
      where a.work_order_id = work_orders.id
        and a.company_id = work_orders.company_id
        and a.user_id = (select auth.uid())
        and (select public.is_company_member(a.company_id))
    )
  );

-- Let owners/managers grant or revoke accountant rights for an existing employee.
create or replace function public.update_member_role(p_membership_id uuid, p_new_role text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor_role text;
  v_target_role text;
  v_company_id uuid;
begin
  if p_new_role not in ('EMPLOYEE', 'ACCOUNTANT') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;

  select actor.role, target.role, target.company_id
    into v_actor_role, v_target_role, v_company_id
    from public.memberships target
    join public.memberships actor
      on actor.company_id = target.company_id and actor.user_id = (select auth.uid())
    where target.id = p_membership_id;

  if v_actor_role is null or v_actor_role not in ('OWNER', 'MANAGER') then
    raise exception 'Na správu rolí nemáte oprávnenie.';
  end if;
  if v_target_role is null or v_target_role not in ('EMPLOYEE', 'ACCOUNTANT') then
    raise exception 'Túto rolu nemôžete zmeniť.';
  end if;

  update public.memberships
  set role = p_new_role
  where id = p_membership_id and company_id = v_company_id;
  if not found then
    raise exception 'Člena sa nepodarilo nájsť.';
  end if;
end;
$$;

revoke all on function public.update_member_role(uuid, text) from public, anon;
grant execute on function public.update_member_role(uuid, text) to authenticated;

-- Allow inviting a member directly as an accountant, and keep employee-limit
-- accounting consistent (accountants occupy an employee-tier seat).
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
  if p_role is null or p_role not in ('MANAGER', 'EMPLOYEE', 'ACCOUNTANT')
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
    or (v_existing_active is false and v_actor_role = 'MANAGER' and v_existing_role is distinct from 'EMPLOYEE' and v_existing_role is distinct from 'ACCOUNTANT')
    or (v_existing_role = 'MANAGER' and p_role <> 'MANAGER') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;

  if p_role in ('EMPLOYEE', 'ACCOUNTANT') then
    v_employee_limit := public.plan_employee_limit(v_plan);
    if v_employee_limit is not null then
      select count(*)::integer into v_active_employee_count
        from public.memberships m
        where m.company_id = p_company_id and m.role in ('EMPLOYEE', 'ACCOUNTANT') and m.active;
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

notify pgrst, 'reload schema';
