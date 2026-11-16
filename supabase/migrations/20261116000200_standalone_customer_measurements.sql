alter table public.work_order_measurements
  alter column work_order_id drop not null,
  add column customer_id uuid references public.customers(id) on delete cascade;

alter table public.work_order_measurements
  add constraint work_order_measurements_order_or_customer_check
  check (work_order_id is not null or customer_id is not null);

create index work_order_measurements_customer_idx
  on public.work_order_measurements(company_id, customer_id, created_at desc)
  where customer_id is not null;

drop policy "Assigned employees and managers read work order measurements"
  on public.work_order_measurements;

create policy "Assigned employees managers and salespeople read measurements"
  on public.work_order_measurements for select to authenticated
  using (
    (work_order_id is not null and (select public.can_manage_company(company_id)))
    or (
      work_order_id is not null
      and (select public.is_company_member(company_id))
      and exists (
        select 1
        from public.work_order_assignees assignment
        where assignment.work_order_id = work_order_measurements.work_order_id
          and assignment.company_id = work_order_measurements.company_id
          and assignment.user_id = (select auth.uid())
          and assignment.accepted_at is not null
          and assignment.declined_at is null
      )
    )
    or (
      customer_id is not null
      and exists (
        select 1
        from public.customers customer
        where customer.id = work_order_measurements.customer_id
          and customer.company_id = work_order_measurements.company_id
          and (
            (customer.salesperson_id = (select auth.uid())
              and (select public.is_company_salesperson(customer.company_id, (select auth.uid()))))
            or (select public.is_company_owner(customer.company_id))
          )
      )
    )
  );

create or replace function public.create_customer_measurement(
  p_customer_id uuid,
  p_control_type text,
  p_color text,
  p_box_type text,
  p_reveal_type text,
  p_side_panels boolean,
  p_controls text,
  p_controls_other text,
  p_windows jsonb,
  p_customer_email text,
  p_customer_phone text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_measurement_id uuid;
begin
  select customer.company_id
    into v_company_id
    from public.customers customer
    where customer.id = p_customer_id
      and (
        (customer.salesperson_id = (select auth.uid())
        and (select public.is_company_salesperson(customer.company_id, (select auth.uid()))))
        or (select public.is_company_owner(customer.company_id))
      );

  if v_company_id is null or not (select public.is_company_member(v_company_id)) then
    raise exception 'Zákazník neexistuje alebo k nemu nemáte prístup.';
  end if;
  if p_control_type is null or p_control_type not in ('MANUAL', 'IO', 'WT', 'SOLAR', 'TAHOMA')
    or p_color is null or char_length(trim(p_color)) not between 1 and 120
    or p_box_type is null or p_box_type not in ('SURFACE', 'RECESSED')
    or p_reveal_type is null or p_reveal_type not in ('STRAIGHT', 'OPEN', 'OTHER')
    or p_side_panels is null
    or p_controls is null or p_controls not in ('NONE', '1', '2', '3', '4', '5', 'OTHER')
    or p_controls_other is not null and char_length(trim(p_controls_other)) > 120
    or p_controls = 'OTHER' and char_length(trim(coalesce(p_controls_other, ''))) = 0
    or p_customer_email is not null and char_length(trim(p_customer_email)) > 254
    or p_customer_email is not null and trim(p_customer_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_customer_phone is not null and char_length(trim(p_customer_phone)) > 40 then
    raise exception 'Skontrolujte vyplnené údaje zamerania.';
  end if;

  if jsonb_typeof(p_windows) is distinct from 'array' then
    raise exception 'Pridajte aspoň jedno platné okno alebo miestnosť.';
  end if;
  if jsonb_array_length(p_windows) not between 1 and 50
    or exists (
      select 1
      from jsonb_array_elements(p_windows) as window_row(value)
      where jsonb_typeof(window_row.value) is distinct from 'object'
        or nullif(trim(window_row.value ->> 'room'), '') is null
        or char_length(trim(window_row.value ->> 'room')) > 160
        or coalesce(window_row.value ->> 'width', '') !~ '^[1-9][0-9]{0,4}$'
        or coalesce(window_row.value ->> 'height', '') !~ '^[1-9][0-9]{0,4}$'
        or coalesce(window_row.value ->> 'guide_type', '') not in ('S', 'Z', 'O', 'STF', 'STF2')
        or char_length(coalesce(window_row.value ->> 'note', '')) > 1000
    ) then
    raise exception 'Skontrolujte názov, rozmery a vodiacu lištu každého okna.';
  end if;

  insert into public.work_order_measurements (
    company_id,
    customer_id,
    created_by,
    control_type,
    color,
    box_type,
    reveal_type,
    side_panels,
    controls,
    controls_other,
    windows,
    customer_email,
    customer_phone
  )
  values (
    v_company_id,
    p_customer_id,
    (select auth.uid()),
    p_control_type,
    trim(p_color),
    p_box_type,
    p_reveal_type,
    p_side_panels,
    p_controls,
    nullif(trim(p_controls_other), ''),
    p_windows,
    nullif(trim(p_customer_email), ''),
    nullif(trim(p_customer_phone), '')
  )
  returning id into v_measurement_id;

  return v_measurement_id;
end;
$$;

revoke all on function public.create_customer_measurement(
  uuid, text, text, text, text, boolean, text, text, jsonb, text, text
) from public, anon;
grant execute on function public.create_customer_measurement(
  uuid, text, text, text, text, boolean, text, text, jsonb, text, text
) to authenticated;

create or replace function public.update_measurement(
  p_measurement_id uuid,
  p_control_type text,
  p_color text,
  p_box_type text,
  p_reveal_type text,
  p_side_panels boolean,
  p_controls text,
  p_controls_other text,
  p_windows jsonb,
  p_customer_email text,
  p_customer_phone text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.work_order_measurements%rowtype;
  v_status text;
begin
  select * into v_record from public.work_order_measurements
    where id = p_measurement_id for update;
  if v_record.id is null or not (select public.is_company_member(v_record.company_id)) then
    raise exception 'Zameranie neexistuje alebo k nemu nemáte prístup.';
  end if;
  if v_record.work_order_id is not null then
    select status into v_status from public.work_orders
      where id = v_record.work_order_id and company_id = v_record.company_id for update;
    if v_status is null or v_status = 'DONE' then
      raise exception 'Zameranie dokončenej zákazky nemožno upraviť.';
    end if;
    if not (select public.can_manage_company(v_record.company_id))
      and not exists (
        select 1 from public.work_order_assignees assignment
        where assignment.work_order_id = v_record.work_order_id
          and assignment.company_id = v_record.company_id
          and assignment.user_id = (select auth.uid())
          and assignment.accepted_at is not null and assignment.declined_at is null
      ) then
      raise exception 'Zameranie môže upraviť iba vedenie alebo prijatý pracovník zákazky.';
    end if;
  elsif not exists (
    select 1 from public.customers customer
    where customer.id = v_record.customer_id and customer.company_id = v_record.company_id
      and ((select public.is_company_owner(customer.company_id))
        or (customer.salesperson_id = (select auth.uid())
          and (select public.is_company_salesperson(customer.company_id, (select auth.uid())))))
  ) then
    raise exception 'K zákazníkovi tohto zamerania nemáte prístup.';
  end if;

  if p_control_type is null or p_control_type not in ('MANUAL', 'IO', 'WT', 'SOLAR', 'TAHOMA')
    or p_color is null or char_length(trim(p_color)) not between 1 and 120
    or p_box_type is null or p_box_type not in ('SURFACE', 'RECESSED')
    or p_reveal_type is null or p_reveal_type not in ('STRAIGHT', 'OPEN', 'OTHER')
    or p_side_panels is null
    or p_controls is null or p_controls not in ('NONE', '1', '2', '3', '4', '5', 'OTHER')
    or p_controls_other is not null and char_length(trim(p_controls_other)) > 120
    or p_controls = 'OTHER' and char_length(trim(coalesce(p_controls_other, ''))) = 0
    or p_customer_email is not null and char_length(trim(p_customer_email)) > 254
    or p_customer_email is not null and trim(p_customer_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_customer_phone is not null and char_length(trim(p_customer_phone)) > 40 then
    raise exception 'Skontrolujte vyplnené údaje zamerania.';
  end if;
  if jsonb_typeof(p_windows) is distinct from 'array' then
    raise exception 'Pridajte aspoň jedno platné okno alebo miestnosť.';
  end if;
  if jsonb_array_length(p_windows) not between 1 and 50
    or exists (
      select 1 from jsonb_array_elements(p_windows) as window_row(value)
      where jsonb_typeof(window_row.value) is distinct from 'object'
        or nullif(trim(window_row.value ->> 'room'), '') is null
        or char_length(trim(window_row.value ->> 'room')) > 160
        or coalesce(window_row.value ->> 'width', '') !~ '^[1-9][0-9]{0,4}$'
        or coalesce(window_row.value ->> 'height', '') !~ '^[1-9][0-9]{0,4}$'
        or coalesce(window_row.value ->> 'guide_type', '') not in ('S', 'Z', 'O', 'STF', 'STF2')
        or char_length(coalesce(window_row.value ->> 'note', '')) > 1000
    ) then
    raise exception 'Skontrolujte názov, rozmery a vodiacu lištu každého okna.';
  end if;

  update public.work_order_measurements set
    control_type = p_control_type, color = trim(p_color), box_type = p_box_type,
    reveal_type = p_reveal_type, side_panels = p_side_panels, controls = p_controls,
    controls_other = nullif(trim(p_controls_other), ''), windows = p_windows,
    customer_email = nullif(trim(p_customer_email), ''), customer_phone = nullif(trim(p_customer_phone), '')
  where id = p_measurement_id;
end;
$$;

revoke all on function public.update_measurement(
  uuid, text, text, text, text, boolean, text, text, jsonb, text, text
) from public, anon;
grant execute on function public.update_measurement(
  uuid, text, text, text, text, boolean, text, text, jsonb, text, text
) to authenticated;

notify pgrst, 'reload schema';
