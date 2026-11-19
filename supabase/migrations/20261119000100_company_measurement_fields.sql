create table public.company_measurement_fields (
  company_id uuid primary key references public.companies(id) on delete cascade,
  fields jsonb not null default '[]'::jsonb check (
    jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 30
  ),
  updated_at timestamptz not null default now(),
  check (pg_column_size(fields) <= 32768)
);

alter table public.company_measurement_fields enable row level security;

create policy "Company members read measurement fields"
  on public.company_measurement_fields for select to authenticated
  using ((select public.is_company_member(company_id)));

create policy "Company owners manage measurement fields"
  on public.company_measurement_fields for all to authenticated
  using ((select public.is_company_owner(company_id)))
  with check ((select public.is_company_owner(company_id)));

grant select, insert, update, delete on public.company_measurement_fields to authenticated;
revoke all on public.company_measurement_fields from public, anon;

create or replace function public.validate_company_measurement_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_field jsonb;
  v_option jsonb;
  v_seen_ids text[] := array[]::text[];
  v_seen_options text[];
begin
  for v_field in select value from jsonb_array_elements(new.fields)
  loop
    if jsonb_typeof(v_field) <> 'object'
      or coalesce(v_field ->> 'id', '') !~ '^[A-Za-z0-9_-]{1,64}$'
      or nullif(trim(v_field ->> 'label'), '') is null
      or char_length(v_field ->> 'label') > 80
      or coalesce(v_field ->> 'type', '') not in ('text', 'number', 'select', 'boolean')
      or coalesce(v_field ->> 'scope', '') not in ('measurement', 'window')
      or jsonb_typeof(v_field -> 'required') is distinct from 'boolean'
      or jsonb_typeof(v_field -> 'active') is distinct from 'boolean' then
      raise exception 'Skontrolujte názov, typ a umiestnenie každého parametra.';
    end if;
    if v_field ->> 'id' = any(v_seen_ids) then
      raise exception 'Identifikátory parametrov sa nesmú opakovať.';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_field ->> 'id');

    if v_field ->> 'type' = 'select' then
      if jsonb_typeof(v_field -> 'options') is distinct from 'array'
        or jsonb_array_length(v_field -> 'options') = 0
        or jsonb_array_length(v_field -> 'options') > 50 then
        raise exception 'Každý výberový parameter musí mať 1 až 50 možností.';
      end if;
      v_seen_options := array[]::text[];
      for v_option in select value from jsonb_array_elements(v_field -> 'options')
      loop
        if jsonb_typeof(v_option) <> 'object'
          or nullif(trim(v_option ->> 'value'), '') is null
          or char_length(v_option ->> 'value') > 100
          or nullif(trim(v_option ->> 'label'), '') is null
          or char_length(v_option ->> 'label') > 100
          or v_option ->> 'value' = any(v_seen_options) then
          raise exception 'Skontrolujte hodnoty a popisy možností výberového parametra.';
        end if;
        v_seen_options := array_append(v_seen_options, v_option ->> 'value');
      end loop;
    end if;
  end loop;
  return new;
end;
$$;

create trigger company_measurement_fields_validate
  before insert or update on public.company_measurement_fields
  for each row execute function public.validate_company_measurement_fields();

revoke all on function public.validate_company_measurement_fields() from public, anon, authenticated;

alter table public.work_order_measurements
  add column custom_fields jsonb not null default '{}'::jsonb;

create or replace function public.save_measurement_custom_fields(
  p_measurement_id uuid,
  p_custom_fields jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record public.work_order_measurements%rowtype;
  v_fields jsonb;
  v_field jsonb;
  v_value jsonb;
  v_window_values jsonb;
  v_index integer;
  v_status text;
begin
  select * into v_record from public.work_order_measurements
    where id = p_measurement_id for update;
  if v_record.id is null or not (select public.is_company_member(v_record.company_id)) then
    raise exception 'Zameranie neexistuje alebo k nemu nemáte prístup.';
  end if;
  if v_record.work_order_id is not null then
    select status into v_status
      from public.work_orders
      where id = v_record.work_order_id and company_id = v_record.company_id;
    if v_status = 'DONE' then
      raise exception 'Zameranie dokončenej zákazky už nemožno upraviť.';
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
  select fields into v_fields from public.company_measurement_fields
    where company_id = v_record.company_id;
  v_fields := coalesce(v_fields, '[]'::jsonb);
  if jsonb_typeof(p_custom_fields) is distinct from 'object'
    or jsonb_typeof(p_custom_fields -> 'configured') is distinct from 'boolean'
    or jsonb_typeof(p_custom_fields -> 'values') is distinct from 'object'
    or jsonb_typeof(p_custom_fields -> 'windows') is distinct from 'array'
    or jsonb_array_length(p_custom_fields -> 'windows') <> jsonb_array_length(v_record.windows)
    or pg_column_size(p_custom_fields) > 65536 then
    raise exception 'Skontrolujte vlastné parametre zamerania.';
  end if;
  if p_custom_fields -> 'configured' = 'false'::jsonb
    and exists (
      select 1 from jsonb_array_elements(v_fields) field
      where coalesce((field ->> 'active')::boolean, true)
    ) then
    raise exception 'Pre túto firmu sú nakonfigurované vlastné parametre.';
  end if;

  if p_custom_fields -> 'configured' = 'true'::jsonb then
  for v_field in select value from jsonb_array_elements(v_fields)
  loop
    if coalesce((v_field ->> 'active')::boolean, true) is false then
      continue;
    end if;
    if v_field ->> 'scope' = 'measurement' then
      v_value := p_custom_fields -> 'values' -> (v_field ->> 'id');
      if coalesce((v_field ->> 'required')::boolean, false)
        and (v_value is null or v_value = 'null'::jsonb or v_value = '""'::jsonb) then
        raise exception 'Vyplňte povinný parameter „%“.', v_field ->> 'label';
      end if;
      if v_value is not null and v_value <> 'null'::jsonb then
        if v_field ->> 'type' = 'boolean' and jsonb_typeof(v_value) <> 'boolean'
          or v_field ->> 'type' in ('text', 'number', 'select') and jsonb_typeof(v_value) <> 'string'
          or v_field ->> 'type' = 'number' and coalesce(v_value #>> '{}', '') !~ '^-?[0-9]+([.,][0-9]+)?$'
          or v_field ->> 'type' = 'text' and char_length(v_value #>> '{}') > 1000
          or v_field ->> 'type' = 'select' and not exists (
            select 1 from jsonb_array_elements(coalesce(v_field -> 'options', '[]'::jsonb)) as option_row(value)
            where option_row.value ->> 'value' = v_value #>> '{}'
          ) then
          raise exception 'Neplatná hodnota parametra „%“.', v_field ->> 'label';
        end if;
      end if;
    elsif v_field ->> 'scope' = 'window' then
      for v_index in 0..jsonb_array_length(p_custom_fields -> 'windows') - 1
      loop
        v_window_values := p_custom_fields -> 'windows' -> v_index;
        v_value := v_window_values -> (v_field ->> 'id');
        if coalesce((v_field ->> 'required')::boolean, false)
          and (v_value is null or v_value = 'null'::jsonb or v_value = '""'::jsonb) then
          raise exception 'Vyplňte povinný parameter „%“ pri každom okne/miestnosti.', v_field ->> 'label';
        end if;
        if v_value is not null and v_value <> 'null'::jsonb then
          if v_field ->> 'type' = 'boolean' and jsonb_typeof(v_value) <> 'boolean'
            or v_field ->> 'type' in ('text', 'number', 'select') and jsonb_typeof(v_value) <> 'string'
            or v_field ->> 'type' = 'number' and coalesce(v_value #>> '{}', '') !~ '^-?[0-9]+([.,][0-9]+)?$'
            or v_field ->> 'type' = 'text' and char_length(v_value #>> '{}') > 1000
            or v_field ->> 'type' = 'select' and not exists (
              select 1 from jsonb_array_elements(coalesce(v_field -> 'options', '[]'::jsonb)) as option_row(value)
              where option_row.value ->> 'value' = v_value #>> '{}'
            ) then
            raise exception 'Neplatná hodnota parametra „%“ pri okne/miestnosti.', v_field ->> 'label';
          end if;
        end if;
      end loop;
    end if;
  end loop;
  end if;

  update public.work_order_measurements
    set custom_fields = p_custom_fields
    where id = p_measurement_id;
end;
$$;

revoke all on function public.save_measurement_custom_fields(uuid, jsonb) from public, anon;
grant execute on function public.save_measurement_custom_fields(uuid, jsonb) to authenticated;

insert into public.company_measurement_fields (company_id, fields)
select company.id, '[
  {"id":"control_type","label":"Typ ovládania","type":"select","scope":"measurement","required":true,"active":true,"options":[{"value":"MANUAL","label":"Manuál"},{"value":"IO","label":"iO"},{"value":"WT","label":"WT"},{"value":"SOLAR","label":"Solar"},{"value":"TAHOMA","label":"Tahoma"}]},
  {"id":"color","label":"Farba","type":"text","scope":"measurement","required":true,"active":true},
  {"id":"box_type","label":"Typ boxu","type":"select","scope":"measurement","required":true,"active":true,"options":[{"value":"SURFACE","label":"Priznaný"},{"value":"RECESSED","label":"Podomietkový"}]},
  {"id":"reveal_type","label":"Typ špalety","type":"select","scope":"measurement","required":true,"active":true,"options":[{"value":"STRAIGHT","label":"Rovná"},{"value":"OPEN","label":"Otvorená"},{"value":"OTHER","label":"Iná"}]},
  {"id":"side_panels","label":"Bočnice","type":"boolean","scope":"measurement","required":false,"active":true},
  {"id":"controls","label":"Ovládače","type":"select","scope":"measurement","required":true,"active":true,"options":[{"value":"NONE","label":"Nie"},{"value":"1","label":"1"},{"value":"2","label":"2"},{"value":"3","label":"3"},{"value":"4","label":"4"},{"value":"5","label":"5"},{"value":"OTHER","label":"Iné"}]},
  {"id":"controls_other","label":"Ovládač – popis","type":"text","scope":"measurement","required":false,"active":true},
  {"id":"guide_type","label":"Typ vodiacej lišty","type":"select","scope":"window","required":true,"active":true,"options":[{"value":"S","label":"Typ S"},{"value":"Z","label":"Typ Z"},{"value":"O","label":"Typ O"},{"value":"STF","label":"Typ STF"},{"value":"STF2","label":"Typ STF2"}]}
]'::jsonb
from public.companies company
where lower(trim(company.name)) = lower('Rolevo s.r.o.')
on conflict (company_id) do nothing;

update public.work_order_measurements measurement
set custom_fields = jsonb_build_object(
  'configured', true,
  'values', jsonb_build_object(
    'control_type', measurement.control_type,
    'color', measurement.color,
    'box_type', measurement.box_type,
    'reveal_type', measurement.reveal_type,
    'side_panels', measurement.side_panels,
    'controls', measurement.controls,
    'controls_other', coalesce(measurement.controls_other, '')
  ),
  'windows', (
    select coalesce(jsonb_agg(jsonb_build_object('guide_type', window_row.value -> 'guide_type')), '[]'::jsonb)
    from jsonb_array_elements(measurement.windows) window_row(value)
  )
)
from public.companies company
where measurement.company_id = company.id
  and lower(trim(company.name)) = lower('Rolevo s.r.o.');

notify pgrst, 'reload schema';
