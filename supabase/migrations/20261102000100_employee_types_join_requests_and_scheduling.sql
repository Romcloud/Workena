alter table public.memberships
  add column if not exists is_external boolean not null default false,
  add column if not exists is_minor boolean not null default false;

alter table public.memberships
  add constraint memberships_employee_traits_check check (
    (not is_external or role = 'EMPLOYEE')
    and (not is_minor or (role = 'EMPLOYEE' or is_employee))
    and (not (is_external and is_minor))
  );

alter table public.attendance_shifts
  add column if not exists note text;

alter table public.work_orders
  add column if not exists time_to_arrange boolean not null default false;

update public.work_orders
  set starts_at = null, ends_at = null, time_to_arrange = true
  where (starts_at is null) <> (ends_at is null)
    or starts_at is not null and ends_at <= starts_at;

alter table public.work_orders
  drop constraint if exists work_orders_time_range,
  add constraint work_orders_time_range check (
    (time_to_arrange and starts_at is null and ends_at is null)
    or (not time_to_arrange and starts_at is null and ends_at is null)
    or (not time_to_arrange and starts_at is not null and ends_at is not null and ends_at > starts_at)
  );

create table public.company_join_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACCEPTED', 'REJECTED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create index company_join_requests_company_status_created_idx
  on public.company_join_requests(company_id, status, created_at);

create or replace function public.require_employee_time_tracking()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.memberships m
    where m.company_id = new.company_id
      and m.user_id = new.user_id
      and m.active
      and (m.role = 'EMPLOYEE' or m.is_employee)
  ) then
    raise exception 'Dochádzku a pracovný čas môže evidovať iba člen s právom zamestnanca.';
  end if;
  return new;
end;
$$;

create trigger require_employee_for_attendance_shift
  before insert or update of company_id, user_id on public.attendance_shifts
  for each row execute function public.require_employee_time_tracking();

create trigger require_employee_for_work_entry
  before insert or update of company_id, user_id on public.work_entries
  for each row execute function public.require_employee_time_tracking();

alter table public.company_join_requests enable row level security;
revoke all on public.company_join_requests from anon, authenticated;
grant select on public.company_join_requests to authenticated;

create policy "Users read own requests and managers read company requests"
  on public.company_join_requests for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.can_manage_company(company_id))
  );

drop function public.add_company_member(uuid, text, text);
create function public.add_company_member(
  p_company_id uuid,
  p_email text,
  p_role text default 'EMPLOYEE',
  p_is_employee boolean default false,
  p_is_external boolean default false,
  p_is_minor boolean default false
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
  v_is_employee boolean;
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
  v_is_employee := p_role = 'EMPLOYEE' or coalesce(p_is_employee, false);
  if p_is_external and p_role <> 'EMPLOYEE' then
    raise exception 'Príznak externého zamestnanca možno použiť iba pri roli Zamestnanec.';
  end if;
  if p_is_minor and (not v_is_employee or p_is_external) then
    raise exception 'Mladistvého možno označiť iba pri internom zamestnancovi.';
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
    or (v_existing_active is false and v_actor_role = 'MANAGER' and v_existing_role not in ('EMPLOYEE', 'ACCOUNTANT'))
    or (v_existing_role = 'MANAGER' and p_role <> 'MANAGER') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;

  if v_is_employee then
    v_employee_limit := public.plan_employee_limit(v_plan);
    if v_employee_limit is not null then
      select count(*)::integer into v_active_employee_count
        from public.memberships m
        where m.company_id = p_company_id and m.active
          and (m.role = 'EMPLOYEE' or (m.role = 'ACCOUNTANT' and m.is_employee));
      if v_active_employee_count >= v_employee_limit then
        raise exception 'Balík % umožňuje najviac % zamestnancov. Pre viac zamestnancov prejdite na vyšší balík.', v_plan, v_employee_limit;
      end if;
    end if;
  end if;

  insert into public.memberships as existing_membership(
    company_id, user_id, email, full_name, role, is_employee, is_external, is_minor, active, deactivated_at
  )
    values (
      p_company_id, v_user_id, v_email, v_full_name, p_role,
      v_is_employee, coalesce(p_is_external, false), coalesce(p_is_minor, false), true, null
    )
    on conflict (company_id, user_id) do update
      set email = excluded.email,
          full_name = excluded.full_name,
          role = excluded.role,
          is_employee = excluded.is_employee,
          is_external = excluded.is_external,
          is_minor = excluded.is_minor,
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

drop function public.update_member_permissions(uuid, boolean, boolean);
create function public.update_member_permissions(
  p_membership_id uuid,
  p_is_employee boolean,
  p_is_salesperson boolean,
  p_is_external boolean,
  p_is_minor boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_target_user_id uuid;
  v_target_role text;
  v_is_employee boolean;
begin
  select target.company_id, target.user_id, target.role
    into v_company_id, v_target_user_id, v_target_role
    from public.memberships target
    where target.id = p_membership_id and target.active;

  if v_company_id is null or not (select public.can_manage_company(v_company_id)) then
    raise exception 'Oprávnenia člena môže upraviť iba vlastník alebo vedúci firmy.';
  end if;
  if v_target_role = 'OWNER' and v_target_user_id <> (select auth.uid()) then
    raise exception 'Práva iného vlastníka nemožno upraviť.';
  end if;
  if p_is_external and v_target_role <> 'EMPLOYEE' then
    raise exception 'Príznak externého zamestnanca možno použiť iba pri roli Zamestnanec.';
  end if;
  v_is_employee := v_target_role = 'EMPLOYEE' or coalesce(p_is_employee, false);
  if p_is_minor and (not v_is_employee or coalesce(p_is_external, false)) then
    raise exception 'Mladistvého možno označiť iba pri internom zamestnancovi.';
  end if;

  update public.memberships
    set is_employee = v_is_employee,
        is_salesperson = coalesce(p_is_salesperson, false),
        is_external = coalesce(p_is_external, false),
        is_minor = coalesce(p_is_minor, false)
    where id = p_membership_id;
end;
$$;

create or replace function public.update_member_role(p_membership_id uuid, p_new_role text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor_role text;
  v_target_role text;
  v_company_id uuid;
  v_target_is_employee boolean;
  v_plan text;
  v_employee_limit integer;
  v_employee_count integer;
begin
  if p_new_role not in ('EMPLOYEE', 'ACCOUNTANT') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;
  select actor.role, target.role, target.company_id, target.is_employee
    into v_actor_role, v_target_role, v_company_id, v_target_is_employee
    from public.memberships target
    join public.memberships actor
      on actor.company_id = target.company_id and actor.user_id = (select auth.uid())
    where target.id = p_membership_id and target.active and actor.active;
  if v_actor_role is null or v_actor_role not in ('OWNER', 'MANAGER') then
    raise exception 'Na správu rolí nemáte oprávnenie.';
  end if;
  if v_target_role is null or v_target_role not in ('EMPLOYEE', 'ACCOUNTANT') then
    raise exception 'Túto rolu nemôžete zmeniť.';
  end if;
  if p_new_role = 'EMPLOYEE' and v_target_role = 'ACCOUNTANT' and not coalesce(v_target_is_employee, false) then
    select c.plan into v_plan
      from public.companies c where c.id = v_company_id for update;
    v_employee_limit := public.plan_employee_limit(v_plan);
    if v_employee_limit is not null then
      select count(*)::integer into v_employee_count
        from public.memberships m
        where m.company_id = v_company_id and m.active
          and (m.role = 'EMPLOYEE' or (m.role = 'ACCOUNTANT' and m.is_employee));
      if v_employee_count >= v_employee_limit then
        raise exception 'Balík % umožňuje najviac % zamestnancov. Pre viac zamestnancov prejdite na vyšší balík.', v_plan, v_employee_limit;
      end if;
    end if;
  end if;

  update public.memberships
    set role = p_new_role,
        is_employee = (p_new_role = 'EMPLOYEE' or is_employee),
        is_external = case when p_new_role = 'ACCOUNTANT' then false else is_external end,
        is_minor = case when p_new_role = 'ACCOUNTANT' and not is_employee then false else is_minor end
    where id = p_membership_id and company_id = v_company_id;
  if not found then
    raise exception 'Člena sa nepodarilo nájsť.';
  end if;
end;
$$;

create or replace function public.search_companies_for_join(p_name text)
returns table(company_id uuid, company_name text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Pre vyhľadávanie sa prihláste.';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 2 and 120 then
    raise exception 'Zadajte aspoň dva znaky názvu firmy.';
  end if;
  return query
    select c.id, c.name
    from public.companies c
    where position(lower(trim(p_name)) in lower(c.name)) > 0
    order by c.name
    limit 10;
end;
$$;

create or replace function public.request_company_join(p_company_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_request_id uuid;
  v_user_email text;
  v_full_name text;
begin
  if (select auth.uid()) is null then
    raise exception 'Pre odoslanie žiadosti sa prihláste.';
  end if;
  select lower(u.email), nullif(trim(u.raw_user_meta_data ->> 'full_name'), '')
    into v_user_email, v_full_name
    from auth.users u where u.id = (select auth.uid());
  if v_user_email is null then
    raise exception 'V účte chýba e-mailová adresa.';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id) then
    raise exception 'Vybraná firma neexistuje.';
  end if;
  if exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id and m.user_id = (select auth.uid()) and m.active
  ) then
    raise exception 'V tejto firme už máte aktívny prístup.';
  end if;

  insert into public.company_join_requests(company_id, user_id, email, full_name, status, updated_at)
    values (p_company_id, (select auth.uid()), v_user_email, v_full_name, 'PENDING', now())
    on conflict (company_id, user_id) do update
      set email = excluded.email,
          full_name = excluded.full_name,
          status = 'PENDING',
          created_at = now(),
          updated_at = now()
      where public.company_join_requests.status <> 'PENDING'
    returning id into v_request_id;
  if v_request_id is null then
    select r.id into v_request_id
      from public.company_join_requests r
      where r.company_id = p_company_id
        and r.user_id = (select auth.uid())
        and r.status = 'PENDING';
  end if;
  return v_request_id;
end;
$$;

create or replace function public.review_company_join_request(p_request_id uuid, p_approve boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_request public.company_join_requests%rowtype;
  v_plan text;
  v_employee_count integer;
  v_employee_limit integer;
begin
  select * into v_request
    from public.company_join_requests r
    where r.id = p_request_id
    for update;
  if v_request.id is null or v_request.status <> 'PENDING'
    or not (select public.can_manage_company(v_request.company_id)) then
    raise exception 'Žiadosť už nie je dostupná alebo ju nemôžete spracovať.';
  end if;

  if coalesce(p_approve, false) then
    select c.plan into v_plan from public.companies c where c.id = v_request.company_id for update;
    v_employee_limit := public.plan_employee_limit(v_plan);
    if v_employee_limit is not null then
      select count(*)::integer into v_employee_count
        from public.memberships m
        where m.company_id = v_request.company_id and m.active
          and (m.role = 'EMPLOYEE' or (m.role = 'ACCOUNTANT' and m.is_employee));
      if v_employee_count >= v_employee_limit then
        raise exception 'Balík % umožňuje najviac % zamestnancov. Pre viac zamestnancov prejdite na vyšší balík.', v_plan, v_employee_limit;
      end if;
    end if;

    insert into public.memberships as existing_membership(
      company_id, user_id, email, full_name, role, is_employee, active, deactivated_at
    )
      values (
        v_request.company_id, v_request.user_id, v_request.email, v_request.full_name,
        'EMPLOYEE', true, true, null
      )
      on conflict (company_id, user_id) do update
        set email = excluded.email,
            full_name = excluded.full_name,
            role = 'EMPLOYEE',
            is_employee = true,
            is_external = false,
            is_minor = false,
            active = true,
            deactivated_at = null
        where existing_membership.active = false;
    if not exists (
      select 1 from public.memberships m
      where m.company_id = v_request.company_id
        and m.user_id = v_request.user_id and m.active
    ) then
      raise exception 'Používateľa sa nepodarilo pridať do firmy.';
    end if;
    update public.company_join_requests
      set status = 'ACCEPTED', updated_at = now()
      where id = p_request_id;
  else
    update public.company_join_requests
      set status = 'REJECTED', updated_at = now()
      where id = p_request_id;
  end if;
end;
$$;

drop function public.update_work_order_details(uuid, text, text, date, text, text, time, time);
create function public.update_work_order_details(
  p_work_order_id uuid,
  p_title text,
  p_address text,
  p_due_date date,
  p_description text,
  p_contact_phone text,
  p_starts_at time,
  p_ends_at time,
  p_time_to_arrange boolean default false
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_creator_id uuid;
begin
  select w.company_id, w.created_by into v_company_id, v_creator_id
    from public.work_orders w where w.id = p_work_order_id;
  if v_company_id is null
    or not (select public.is_company_member(v_company_id))
    or (not (select public.can_manage_company(v_company_id))
      and v_creator_id is distinct from (select auth.uid())) then
    raise exception 'Zákazku môže upraviť iba vedúci alebo jej tvorca.';
  end if;
  if p_title is null or char_length(trim(p_title)) not between 2 and 140
    or p_address is null or char_length(trim(p_address)) not between 2 and 250
    or p_due_date is null
    or p_description is null or char_length(trim(p_description)) not between 2 and 4000
    or p_contact_phone is not null and char_length(trim(p_contact_phone)) > 40
    or (p_time_to_arrange and (p_starts_at is not null or p_ends_at is not null))
    or ((p_starts_at is null) <> (p_ends_at is null))
    or p_starts_at is not null and p_ends_at <= p_starts_at then
    raise exception 'Skontrolujte názov, adresu, termín, opis, telefón a čas zákazky.';
  end if;

  update public.work_orders
    set title = trim(p_title),
        address = trim(p_address),
        due_date = p_due_date,
        description = trim(p_description),
        contact_phone = nullif(trim(p_contact_phone), ''),
        starts_at = p_starts_at,
        ends_at = p_ends_at,
        time_to_arrange = coalesce(p_time_to_arrange, false),
        updated_at = now()
    where id = p_work_order_id;
end;
$$;

drop function public.create_work_order_with_details(uuid, uuid[], text, text, date, text, text, time, time);
create function public.create_work_order_with_details(
  p_company_id uuid,
  p_assignee_ids uuid[],
  p_title text,
  p_address text,
  p_due_date date,
  p_description text,
  p_contact_phone text,
  p_starts_at time,
  p_ends_at time,
  p_time_to_arrange boolean default false
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_work_order_id uuid;
  v_actor_role text;
  v_actor_is_employee boolean;
  v_plan text;
begin
  if p_contact_phone is not null and char_length(trim(p_contact_phone)) > 40
    or (p_time_to_arrange and (p_starts_at is not null or p_ends_at is not null))
    or ((p_starts_at is null) <> (p_ends_at is null))
    or p_starts_at is not null and p_ends_at <= p_starts_at then
    raise exception 'Skontrolujte telefón a časový interval zákazky.';
  end if;
  select m.role, m.is_employee into v_actor_role, v_actor_is_employee
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
  if v_actor_role = 'ACCOUNTANT' and not coalesce(v_actor_is_employee, false) then
    raise exception 'Zákazku môže vytvoriť iba zamestnanec, vlastník alebo vedúci firmy.';
  end if;
  if (v_actor_role = 'EMPLOYEE' or coalesce(v_actor_is_employee, false))
    and v_actor_role not in ('OWNER', 'MANAGER')
    and (
      p_assignee_ids is null or cardinality(p_assignee_ids) <> 1
      or p_assignee_ids[1] <> (select auth.uid())
    ) then
    raise exception 'Zamestnanec môže vytvoriť zákazku iba sám pre seba.';
  end if;
  if p_assignee_ids is null or cardinality(p_assignee_ids) not between 1 and 50
    or exists (
      select 1 from unnest(p_assignee_ids) as selected(user_id)
      where not (select public.is_company_employee(p_company_id, selected.user_id))
    )
    or cardinality(p_assignee_ids) <> (
      select count(distinct selected.user_id)
      from unnest(p_assignee_ids) as selected(user_id)
    ) then
    raise exception 'Vyberte aktívnych zamestnancov firmy bez duplicít.';
  end if;
  if p_title is null or char_length(trim(p_title)) not between 2 and 140
    or p_address is null or char_length(trim(p_address)) not between 2 and 250
    or p_due_date is null
    or p_description is null or char_length(trim(p_description)) not between 2 and 4000 then
    raise exception 'Skontrolujte názov zákazky, adresu, termín a opis práce.';
  end if;

  insert into public.work_orders(
    company_id, assignee_id, created_by, title, address, due_date, description,
    contact_phone, starts_at, ends_at, time_to_arrange
  )
  values (
    p_company_id, p_assignee_ids[1], (select auth.uid()), trim(p_title), trim(p_address),
    p_due_date, trim(p_description), nullif(trim(p_contact_phone), ''),
    p_starts_at, p_ends_at, coalesce(p_time_to_arrange, false)
  )
  returning id into v_work_order_id;

  insert into public.work_order_assignees(work_order_id, company_id, user_id, accepted_at)
  select v_work_order_id, p_company_id, selected.user_id,
    case when selected.user_id = (select auth.uid())
      and (v_actor_role = 'EMPLOYEE' or coalesce(v_actor_is_employee, false)) then now() else null end
  from unnest(p_assignee_ids) as selected(user_id);
  return v_work_order_id;
end;
$$;

create or replace function public.update_work_order_schedule(
  p_work_order_id uuid,
  p_due_date date,
  p_starts_at time,
  p_ends_at time,
  p_time_to_arrange boolean default false
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  select w.company_id into v_company_id
    from public.work_orders w where w.id = p_work_order_id;
  if v_company_id is null
    or not (select public.is_company_member(v_company_id))
    or not exists (
      select 1 from public.work_order_assignees a
      where a.work_order_id = p_work_order_id
        and a.company_id = v_company_id
        and a.user_id = (select auth.uid())
        and a.accepted_at is not null
    ) then
    raise exception 'Termín zákazky môže upraviť iba zamestnanec, ktorý ju prijal.';
  end if;
  if p_due_date is null
    or (p_time_to_arrange and (p_starts_at is not null or p_ends_at is not null))
    or ((p_starts_at is null) <> (p_ends_at is null))
    or p_starts_at is not null and p_ends_at <= p_starts_at then
    raise exception 'Skontrolujte dátum a čas zákazky.';
  end if;

  update public.work_orders
    set due_date = p_due_date,
        starts_at = p_starts_at,
        ends_at = p_ends_at,
        time_to_arrange = coalesce(p_time_to_arrange, false),
        updated_at = now()
    where id = p_work_order_id and status <> 'DONE';
  if not found then
    raise exception 'Dokončenú zákazku už nemožno preplánovať.';
  end if;
end;
$$;

drop function public.end_attendance(uuid);
create function public.end_attendance(p_company_id uuid, p_lunch_break boolean default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift_id uuid;
  v_started_at timestamptz;
  v_is_employee boolean;
  v_is_external boolean;
  v_is_minor boolean;
  v_threshold interval;
  v_ended_at timestamptz := now();
  v_has_recorded_break boolean;
begin
  if not (select public.is_company_member(p_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;
  select (m.role = 'EMPLOYEE' or m.is_employee), m.is_external, m.is_minor
    into v_is_employee, v_is_external, v_is_minor
    from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.active;
  select s.id, s.started_at into v_shift_id, v_started_at
    from public.attendance_shifts s
    where s.company_id = p_company_id
      and s.user_id = (select auth.uid())
      and s.ended_at is null
    for update;
  if v_shift_id is null then
    raise exception 'Nemáte spustenú pracovnú zmenu.';
  end if;
  if exists (
    select 1 from public.attendance_breaks b
    where b.shift_id = v_shift_id and b.ended_at is null
  ) then
    raise exception 'Pred ukončením zmeny ukončite prestávku.';
  end if;

  select exists (
    select 1 from public.attendance_breaks b where b.shift_id = v_shift_id
  ) into v_has_recorded_break;
  v_threshold := case when coalesce(v_is_minor, false) then interval '4 hours 30 minutes' else interval '6 hours' end;

  if coalesce(v_is_employee, false)
    and not coalesce(v_is_external, false)
    and not v_has_recorded_break
    and v_ended_at - v_started_at >= v_threshold then
    if p_lunch_break is null then
      raise exception 'Potvrďte, či ste počas zmeny mali 30-minútovú prestávku na obed.';
    end if;
    if p_lunch_break then
      insert into public.attendance_breaks(shift_id, started_at, ended_at)
        values (v_shift_id, greatest(v_started_at, v_ended_at - interval '30 minutes'), v_ended_at);
    else
      update public.attendance_shifts
        set note = concat_ws(E'\n', nullif(note, ''), 'Prestávka na obed nebola čerpaná.')
        where id = v_shift_id;
    end if;
  end if;

  update public.attendance_shifts
    set ended_at = v_ended_at
    where id = v_shift_id and ended_at is null;
end;
$$;

revoke all on function public.add_company_member(uuid, text, text, boolean, boolean, boolean) from public, anon;
revoke all on function public.update_member_permissions(uuid, boolean, boolean, boolean, boolean) from public, anon;
revoke all on function public.search_companies_for_join(text) from public, anon;
revoke all on function public.request_company_join(uuid) from public, anon;
revoke all on function public.review_company_join_request(uuid, boolean) from public, anon;
revoke all on function public.update_work_order_details(uuid, text, text, date, text, text, time, time, boolean) from public, anon;
revoke all on function public.create_work_order_with_details(uuid, uuid[], text, text, date, text, text, time, time, boolean) from public, anon;
revoke all on function public.update_work_order_schedule(uuid, date, time, time, boolean) from public, anon;
revoke all on function public.end_attendance(uuid, boolean) from public, anon;
grant execute on function public.add_company_member(uuid, text, text, boolean, boolean, boolean) to authenticated;
grant execute on function public.update_member_permissions(uuid, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.search_companies_for_join(text) to authenticated;
grant execute on function public.request_company_join(uuid) to authenticated;
grant execute on function public.review_company_join_request(uuid, boolean) to authenticated;
grant execute on function public.update_work_order_details(uuid, text, text, date, text, text, time, time, boolean) to authenticated;
grant execute on function public.create_work_order_with_details(uuid, uuid[], text, text, date, text, text, time, time, boolean) to authenticated;
grant execute on function public.update_work_order_schedule(uuid, date, time, time, boolean) to authenticated;
grant execute on function public.end_attendance(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
