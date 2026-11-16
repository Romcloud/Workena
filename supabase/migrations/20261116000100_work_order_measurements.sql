create table public.work_order_measurements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  control_type text not null check (control_type in ('MANUAL', 'IO', 'WT', 'SOLAR', 'TAHOMA')),
  color text not null check (char_length(trim(color)) between 1 and 120),
  box_type text not null check (box_type in ('SURFACE', 'RECESSED')),
  reveal_type text not null check (reveal_type in ('STRAIGHT', 'OPEN', 'OTHER')),
  side_panels boolean not null,
  controls text not null check (controls in ('NONE', '1', '2', '3', '4', '5', 'OTHER')),
  controls_other text check (controls_other is null or char_length(trim(controls_other)) <= 120),
  windows jsonb not null,
  customer_email text check (
    customer_email is null
    or char_length(customer_email) <= 254
  ),
  customer_phone text check (customer_phone is null or char_length(customer_phone) <= 40),
  created_at timestamptz not null default now()
);

create index work_order_measurements_company_order_idx
  on public.work_order_measurements(company_id, work_order_id, created_at desc);

alter table public.work_order_measurements enable row level security;

create policy "Assigned employees and managers read work order measurements"
  on public.work_order_measurements for select to authenticated
  using (
    (select public.can_manage_company(company_id))
    or (
      (select public.is_company_member(company_id))
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
  );

revoke all on public.work_order_measurements from anon, authenticated;
grant select on public.work_order_measurements to authenticated;

create or replace function public.create_work_order_measurement(
  p_work_order_id uuid,
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
  v_status text;
  v_measurement_id uuid;
begin
  select order_row.company_id, order_row.status
    into v_company_id, v_status
    from public.work_orders order_row
    where order_row.id = p_work_order_id
    for update;

  if v_company_id is null or not (select public.is_company_member(v_company_id)) then
    raise exception 'Zákazka neexistuje alebo k nej nemáte prístup.';
  end if;
  if v_status = 'DONE' then
    raise exception 'K dokončenej zákazke už nemožno pridať nové zameranie.';
  end if;
  if not (select public.can_manage_company(v_company_id))
    and not exists (
      select 1
      from public.work_order_assignees assignment
      where assignment.work_order_id = p_work_order_id
        and assignment.company_id = v_company_id
        and assignment.user_id = (select auth.uid())
        and assignment.accepted_at is not null
        and assignment.declined_at is null
    ) then
    raise exception 'Zameranie môže pridať iba vedenie alebo prijatý pracovník zákazky.';
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
    work_order_id,
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
    p_work_order_id,
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

revoke all on function public.create_work_order_measurement(
  uuid, text, text, text, text, boolean, text, text, jsonb, text, text
) from public, anon;
grant execute on function public.create_work_order_measurement(
  uuid, text, text, text, text, boolean, text, text, jsonb, text, text
) to authenticated;

notify pgrst, 'reload schema';
