alter table public.work_orders
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists customer_name text check (
    customer_name is null or char_length(trim(customer_name)) between 2 and 160
  );

create index if not exists work_orders_customer_id_idx
  on public.work_orders(customer_id);

create or replace function public.sync_work_order_customer_names()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.full_name is distinct from old.full_name then
    update public.work_orders
      set customer_name = new.full_name
      where customer_id = new.id
        and company_id = new.company_id;
  end if;
  return new;
end;
$$;

drop trigger if exists customers_sync_work_order_names on public.customers;
create trigger customers_sync_work_order_names
  after update of full_name on public.customers
  for each row
  execute function public.sync_work_order_customer_names();

drop function if exists public.create_work_order_with_type(
  uuid, uuid[], text, text, date, text, text, time, time, text, boolean
);

create or replace function public.create_work_order_with_type(
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
  p_time_to_arrange boolean default false,
  p_customer_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_work_order_id uuid;
  v_customer_name text;
begin
  if p_work_type is null or p_work_type not in ('MEASUREMENT', 'INSTALLATION', 'REPAIR', 'OTHER') then
    raise exception 'Vyberte platný typ zákazky.';
  end if;

  if p_customer_id is not null then
    select customer.full_name into v_customer_name
      from public.customers customer
      where customer.id = p_customer_id
        and customer.company_id = p_company_id;
    if not found then
      raise exception 'Vybraný zákazník nepatrí do tejto firmy alebo už neexistuje.';
    end if;
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
    set work_type = p_work_type,
        customer_id = p_customer_id,
        customer_name = v_customer_name
    where id = v_work_order_id;

  return v_work_order_id;
end;
$$;

revoke all on function public.create_work_order_with_type(
  uuid, uuid[], text, text, date, text, text, time, time, text, boolean, uuid
) from public, anon;
grant execute on function public.create_work_order_with_type(
  uuid, uuid[], text, text, date, text, text, time, time, text, boolean, uuid
) to authenticated;

notify pgrst, 'reload schema';
