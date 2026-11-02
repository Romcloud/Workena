alter table public.work_orders
  drop constraint if exists work_orders_status_check,
  add constraint work_orders_status_check
    check (status in ('ASSIGNED', 'IN_PROGRESS', 'MEASURED', 'WORKING', 'DONE'));

alter table public.work_order_assignees
  add column declined_at timestamptz,
  add column reassigned_at timestamptz;

create or replace function public.accept_work_order_assignment(p_work_order_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.work_order_assignees a
  set accepted_at = coalesce(a.accepted_at, now()),
      declined_at = null
  where a.work_order_id = p_work_order_id
    and a.user_id = (select auth.uid())
    and a.accepted_at is null
    and a.declined_at is null
    and exists (
      select 1 from public.work_orders w
      where w.id = a.work_order_id and w.status <> 'DONE'
    )
    and (select public.is_company_member(a.company_id));
  if not found then
    raise exception 'Zákazka vám nebola pridelená alebo už bola prijatá či odmietnutá.';
  end if;
end;
$$;

create or replace function public.reject_work_order_assignment(p_work_order_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.work_order_assignees a
  set declined_at = now()
  where a.work_order_id = p_work_order_id
    and a.user_id = (select auth.uid())
    and a.accepted_at is null
    and a.declined_at is null
    and exists (
      select 1 from public.work_orders w
      where w.id = a.work_order_id and w.status <> 'DONE'
    )
    and (select public.is_company_member(a.company_id));
  if not found then
    raise exception 'Odmietnuť možno iba zákazku, ktorá čaká na vaše prijatie.';
  end if;
end;
$$;

create or replace function public.reassign_declined_work_order(
  p_work_order_id uuid,
  p_assignee_id uuid
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_plan text;
begin
  select w.company_id into v_company_id
  from public.work_orders w
  where w.id = p_work_order_id
    and w.status <> 'DONE'
  for update;
  if v_company_id is null or not (select public.can_manage_company(v_company_id)) then
    raise exception 'Zákazku môže priradiť iba vlastník alebo vedúci firmy.';
  end if;
  select c.plan into v_plan
  from public.companies c
  where c.id = v_company_id;
  if v_plan = 'BASIC' then
    raise exception 'Balík Basic neumožňuje prideľovať zákazky. Prejdite na balík Pro alebo Team.';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.company_id = v_company_id
      and m.user_id = p_assignee_id
      and m.active
      and (m.role = 'EMPLOYEE' or m.is_employee)
  ) then
    raise exception 'Vybraný pracovník nie je aktívnym zamestnancom firmy.';
  end if;
  if exists (
    select 1 from public.work_order_assignees a
    where a.work_order_id = p_work_order_id
      and a.user_id = p_assignee_id
  ) then
    raise exception 'Vyberte iného zamestnanca, ktorému táto zákazka ešte nebola pridelená.';
  end if;

  insert into public.work_order_assignees(work_order_id, company_id, user_id)
  values (p_work_order_id, v_company_id, p_assignee_id);

  update public.work_order_assignees
  set reassigned_at = now()
  where work_order_id = p_work_order_id
    and declined_at is not null
    and reassigned_at is null;

  update public.work_orders
  set status = case
        when exists (
          select 1 from public.work_order_assignees a
          where a.work_order_id = p_work_order_id
            and a.accepted_at is not null
            and a.declined_at is null
        ) then status
        else 'ASSIGNED'
      end,
      updated_at = now()
  where id = p_work_order_id;
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
  if p_status is null or p_status not in ('IN_PROGRESS', 'MEASURED', 'WORKING')
    or p_employee_note is not null and char_length(p_employee_note) > 2000 then
    raise exception 'Skontrolujte stav zákazky a poznámku.';
  end if;

  update public.work_orders w
  set status = p_status,
      employee_note = nullif(trim(p_employee_note), ''),
      updated_at = now()
  where w.id = p_work_order_id
    and w.status <> 'DONE'
    and (select public.is_company_member(w.company_id))
    and exists (
      select 1 from public.work_order_assignees a
      where a.work_order_id = w.id
        and a.user_id = (select auth.uid())
        and a.accepted_at is not null
        and a.declined_at is null
    );
  if not found then
    raise exception 'Zákazka neexistuje alebo ju nemôžete upraviť.';
  end if;
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
  if p_status is null or p_status not in ('IN_PROGRESS', 'MEASURED', 'WORKING', 'DONE')
    or p_employee_note is not null and char_length(p_employee_note) > 2000
    or p_employee_materials is not null and char_length(p_employee_materials) > 4000
    or p_work_report is not null and char_length(p_work_report) > 4000 then
    raise exception 'Skontrolujte stav zákazky a obsah výkazu.';
  end if;
  if p_status = 'DONE' and char_length(trim(coalesce(p_work_report, ''))) < 2 then
    raise exception 'Pred označením zákazky ako dokončenej vyplňte výkaz práce.';
  end if;

  select w.status into v_status
  from public.work_orders w
  join public.work_order_assignees a on a.work_order_id = w.id
  where w.id = p_work_order_id
    and a.user_id = (select auth.uid())
    and a.accepted_at is not null
    and a.declined_at is null
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

revoke all on function public.reject_work_order_assignment(uuid) from public, anon;
revoke all on function public.reassign_declined_work_order(uuid, uuid) from public, anon;
grant execute on function public.reject_work_order_assignment(uuid) to authenticated;
grant execute on function public.reassign_declined_work_order(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
