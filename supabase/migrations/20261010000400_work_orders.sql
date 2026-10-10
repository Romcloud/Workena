create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  assignee_id uuid not null references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  title text not null check (char_length(trim(title)) between 2 and 140),
  address text not null check (char_length(trim(address)) between 2 and 250),
  due_date date not null,
  description text not null check (char_length(trim(description)) between 2 and 4000),
  status text not null default 'ASSIGNED' check (status in ('ASSIGNED', 'IN_PROGRESS', 'DONE')),
  employee_note text check (employee_note is null or char_length(employee_note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index work_orders_company_due_date_idx
  on public.work_orders(company_id, due_date, created_at desc);
create index work_orders_assignee_status_idx
  on public.work_orders(assignee_id, status, due_date);

alter table public.work_orders enable row level security;

create policy "Managers read company work orders and employees read assigned work"
  on public.work_orders for select to authenticated
  using (
    (select public.can_manage_company(company_id))
    or (
      assignee_id = (select auth.uid())
      and (select public.is_company_member(company_id))
    )
  );

revoke all on public.work_orders from anon, authenticated;
grant select on public.work_orders to authenticated;

create or replace function public.create_work_order(
  p_company_id uuid,
  p_assignee_id uuid,
  p_title text,
  p_address text,
  p_due_date date,
  p_description text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor_role text;
  v_work_order_id uuid;
begin
  select m.role into v_actor_role
    from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.active;
  if v_actor_role is distinct from 'OWNER' then
    raise exception 'Nové zákazky môže zadávať iba vlastník firmy.';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = p_assignee_id
      and m.role = 'EMPLOYEE'
      and m.active
  ) then
    raise exception 'Vybraný pracovník nie je aktívnym zamestnancom firmy.';
  end if;
  if p_title is null or char_length(trim(p_title)) not between 2 and 140
    or p_address is null or char_length(trim(p_address)) not between 2 and 250
    or p_due_date is null
    or p_description is null or char_length(trim(p_description)) not between 2 and 4000 then
    raise exception 'Skontrolujte názov zákazky, adresu, termín a opis práce.';
  end if;

  insert into public.work_orders(company_id, assignee_id, created_by, title, address, due_date, description)
    values (
      p_company_id,
      p_assignee_id,
      (select auth.uid()),
      trim(p_title),
      trim(p_address),
      p_due_date,
      trim(p_description)
    )
    returning id into v_work_order_id;
  return v_work_order_id;
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
      and w.assignee_id = (select auth.uid())
      and (select public.is_company_member(w.company_id));
  if not found then
    raise exception 'Zákazka neexistuje alebo ju nemôžete upraviť.';
  end if;
end;
$$;

revoke all on function public.create_work_order(uuid, uuid, text, text, date, text) from public, anon;
revoke all on function public.update_assigned_work_order(uuid, text, text) from public, anon;
grant execute on function public.create_work_order(uuid, uuid, text, text, date, text) to authenticated;
grant execute on function public.update_assigned_work_order(uuid, text, text) to authenticated;
