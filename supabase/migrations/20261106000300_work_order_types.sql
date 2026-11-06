alter table public.work_orders
  add column work_type text not null default 'INSTALLATION'
  check (work_type in ('MEASUREMENT', 'INSTALLATION', 'REPAIR', 'OTHER'));

update public.work_orders
  set work_type = 'MEASUREMENT'
  where status = 'MEASURED';

create function public.create_work_order_with_type(
  p_company_id uuid,
  p_assignee_ids uuid[],
  p_title text,
  p_address text,
  p_due_date date,
  p_description text,
  p_contact_phone text,
  p_starts_at time,
  p_ends_at time,
  p_work_type text,
  p_time_to_arrange boolean default false
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_work_order_id uuid;
begin
  if p_work_type is null or p_work_type not in ('MEASUREMENT', 'INSTALLATION', 'REPAIR', 'OTHER') then
    raise exception 'Vyberte platný typ zákazky.';
  end if;

  v_work_order_id := public.create_work_order_with_details(
    p_company_id,
    p_assignee_ids,
    p_title,
    p_address,
    p_due_date,
    p_description,
    p_contact_phone,
    p_starts_at,
    p_ends_at,
    p_time_to_arrange
  );

  update public.work_orders
    set work_type = p_work_type
    where id = v_work_order_id;

  return v_work_order_id;
end;
$$;

revoke all on function public.create_work_order_with_type(uuid, uuid[], text, text, date, text, text, time, time, text, boolean) from public, anon;
grant execute on function public.create_work_order_with_type(uuid, uuid[], text, text, date, text, text, time, time, text, boolean) to authenticated;
