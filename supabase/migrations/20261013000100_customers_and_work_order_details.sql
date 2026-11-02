alter table public.memberships
  add column if not exists is_employee boolean not null default false,
  add column if not exists is_salesperson boolean not null default false;

alter table public.work_orders
  add column if not exists contact_phone text,
  add column if not exists starts_at time,
  add column if not exists ends_at time,
  add constraint work_orders_contact_phone_length check (
    contact_phone is null or char_length(contact_phone) <= 40
  ),
  add constraint work_orders_time_range check (
    (starts_at is null and ends_at is null)
    or (starts_at is not null and ends_at is not null and ends_at > starts_at)
  );

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  salesperson_id uuid not null references auth.users(id) on delete cascade,
  customer_date date not null default current_date,
  full_name text not null check (char_length(trim(full_name)) between 2 and 160),
  location text not null check (char_length(trim(location)) between 2 and 250),
  lead_source text not null check (char_length(trim(lead_source)) between 1 and 160),
  product text not null check (char_length(trim(product)) between 1 and 200),
  quote_sent_date date,
  contact_details text not null check (char_length(trim(contact_details)) between 2 and 400),
  estimated_price numeric(12, 2) check (estimated_price is null or estimated_price >= 0),
  status text not null default 'NO_RESPONSE'
    check (status in ('APPROVED', 'REJECTED', 'NO_RESPONSE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);

create index customers_company_salesperson_date_idx
  on public.customers(company_id, salesperson_id, customer_date desc);

alter table public.customers enable row level security;
revoke all on public.customers from anon, authenticated;
grant select, insert, update, delete on public.customers to authenticated;

create or replace function public.is_company_employee(p_company_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = p_user_id
      and m.active
      and (m.role = 'EMPLOYEE' or m.is_employee)
  );
$$;

create or replace function public.is_company_salesperson(p_company_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = p_user_id
      and m.active
      and m.is_salesperson
  );
$$;

create or replace function public.is_company_owner(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.active
      and m.role = 'OWNER'
  );
$$;

create policy "Salespeople read own customers and owners read company customers"
  on public.customers for select to authenticated
  using (
    (salesperson_id = (select auth.uid())
      and (select public.is_company_salesperson(company_id, (select auth.uid()))))
    or (select public.is_company_owner(company_id))
  );

create policy "Salespeople and owners create customers"
  on public.customers for insert to authenticated
  with check (
    (
      salesperson_id = (select auth.uid())
      and (select public.is_company_salesperson(company_id, (select auth.uid())))
    )
    or (
      (select public.is_company_owner(company_id))
      and (select public.is_company_salesperson(company_id, salesperson_id))
    )
  );

create policy "Salespeople edit own customers and owners edit company customers"
  on public.customers for update to authenticated
  using (
    (salesperson_id = (select auth.uid())
      and (select public.is_company_salesperson(company_id, (select auth.uid()))))
    or (select public.is_company_owner(company_id))
  )
  with check (
    (
      salesperson_id = (select auth.uid())
      and (select public.is_company_salesperson(company_id, (select auth.uid())))
    )
    or (
      (select public.is_company_owner(company_id))
      and (select public.is_company_salesperson(company_id, salesperson_id))
    )
  );

create policy "Salespeople delete own customers and owners delete company customers"
  on public.customers for delete to authenticated
  using (
    (salesperson_id = (select auth.uid())
      and (select public.is_company_salesperson(company_id, (select auth.uid()))))
    or (select public.is_company_owner(company_id))
  );

create or replace function public.update_member_permissions(
  p_membership_id uuid,
  p_is_employee boolean,
  p_is_salesperson boolean
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_target_user_id uuid;
  v_target_role text;
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

  update public.memberships
    set is_employee = (v_target_role = 'EMPLOYEE' or coalesce(p_is_employee, false)),
        is_salesperson = coalesce(p_is_salesperson, false)
    where id = p_membership_id;
end;
$$;

create or replace function public.update_work_order_details(
  p_work_order_id uuid,
  p_title text,
  p_address text,
  p_due_date date,
  p_description text,
  p_contact_phone text,
  p_starts_at time,
  p_ends_at time
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
    or (p_starts_at is null) <> (p_ends_at is null)
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
        updated_at = now()
    where id = p_work_order_id;
end;
$$;

create function public.create_work_order_with_details(
  p_company_id uuid,
  p_assignee_ids uuid[],
  p_title text,
  p_address text,
  p_due_date date,
  p_description text,
  p_contact_phone text,
  p_starts_at time,
  p_ends_at time
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
    or (p_starts_at is null) <> (p_ends_at is null)
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
    company_id, assignee_id, created_by, title, address, due_date, description, contact_phone, starts_at, ends_at
  )
  values (
    p_company_id, p_assignee_ids[1], (select auth.uid()), trim(p_title), trim(p_address),
    p_due_date, trim(p_description), nullif(trim(p_contact_phone), ''), p_starts_at, p_ends_at
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

create function public.complete_work_order(p_work_order_id uuid)
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
    raise exception 'Zákazku môže dokončiť iba vedúci alebo jej tvorca.';
  end if;
  update public.work_orders
    set status = 'DONE', updated_at = now()
    where id = p_work_order_id;
end;
$$;

create or replace function public.delete_work_order(p_work_order_id uuid)
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
    raise exception 'Zákazku môže vymazať iba vedúci alebo jej tvorca.';
  end if;
  delete from public.work_orders where id = p_work_order_id;
end;
$$;

drop function public.create_company(text);

create function public.create_company(
  p_name text,
  p_billing_name text,
  p_billing_ico text,
  p_billing_dic text,
  p_billing_ic_dph text,
  p_billing_address text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_owned_count integer;
  v_best_plan text;
  v_limit integer;
begin
  if p_name is null or char_length(trim(p_name)) not between 2 and 120
    or p_billing_name is null or char_length(trim(p_billing_name)) not between 2 and 200
    or p_billing_ico is null or char_length(trim(p_billing_ico)) not between 1 and 20
    or p_billing_dic is null or char_length(trim(p_billing_dic)) not between 1 and 20
    or p_billing_address is null or char_length(trim(p_billing_address)) not between 2 and 400
    or p_billing_ic_dph is not null and char_length(trim(p_billing_ic_dph)) > 20 then
    raise exception 'Vyplňte názov firmy a všetky povinné fakturačné údaje.';
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

  insert into public.companies(
    name, created_by, billing_name, billing_ico, billing_dic, billing_ic_dph, billing_address
  )
  values (
    trim(p_name), (select auth.uid()), trim(p_billing_name), trim(p_billing_ico),
    trim(p_billing_dic), nullif(trim(p_billing_ic_dph), ''), trim(p_billing_address)
  )
  returning id into v_company_id;

  insert into public.memberships(company_id, user_id, email, full_name, role, active)
  select v_company_id, u.id, lower(u.email), nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), 'OWNER', true
  from auth.users u
  where u.id = (select auth.uid());
  return v_company_id;
end;
$$;

revoke all on function public.is_company_employee(uuid, uuid) from public, anon;
revoke all on function public.is_company_salesperson(uuid, uuid) from public, anon;
revoke all on function public.is_company_owner(uuid) from public, anon;
revoke all on function public.update_member_permissions(uuid, boolean, boolean) from public, anon;
revoke all on function public.update_work_order_details(uuid, text, text, date, text, text, time, time) from public, anon;
revoke all on function public.create_work_order_with_details(uuid, uuid[], text, text, date, text, text, time, time) from public, anon;
revoke all on function public.complete_work_order(uuid) from public, anon;
revoke all on function public.delete_work_order(uuid) from public, anon;
revoke all on function public.create_company(text, text, text, text, text, text) from public, anon;
grant execute on function public.is_company_employee(uuid, uuid) to authenticated;
grant execute on function public.is_company_salesperson(uuid, uuid) to authenticated;
grant execute on function public.is_company_owner(uuid) to authenticated;
grant execute on function public.update_member_permissions(uuid, boolean, boolean) to authenticated;
grant execute on function public.update_work_order_details(uuid, text, text, date, text, text, time, time) to authenticated;
grant execute on function public.create_work_order_with_details(uuid, uuid[], text, text, date, text, text, time, time) to authenticated;
grant execute on function public.complete_work_order(uuid) to authenticated;
grant execute on function public.delete_work_order(uuid) to authenticated;
grant execute on function public.create_company(text, text, text, text, text, text) to authenticated;

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
    if exists (select 1 from unnest(v_stops) as stop where char_length(stop) not between 2 and 250) then
      raise exception 'Skontrolujte adresy zastávok.';
    end if;
  else
    v_stops := '{}';
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
      join public.work_orders w on w.id = a.work_order_id and w.company_id = a.company_id
      where a.work_order_id = p_work_order_id
        and a.company_id = p_company_id
        and a.user_id = (select auth.uid())
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
