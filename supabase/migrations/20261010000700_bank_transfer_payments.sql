create sequence public.payment_variable_symbol_seq
  start with 1000000000
  maxvalue 9999999999
  no cycle;

create table public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  plan text not null check (plan in ('BASIC', 'PRO', 'TEAM')),
  amount_eur numeric(8, 2) not null check (amount_eur in (19.00, 39.00, 69.00)),
  variable_symbol text not null unique check (variable_symbol ~ '^[0-9]{10}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'CONFIRMED', 'REJECTED')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint payment_requests_plan_amount_check check (
    (plan = 'BASIC' and amount_eur = 19.00)
    or (plan = 'PRO' and amount_eur = 39.00)
    or (plan = 'TEAM' and amount_eur = 69.00)
  )
);

create index payment_requests_company_created_idx
  on public.payment_requests(company_id, created_at desc);
create unique index payment_requests_one_pending_per_company_idx
  on public.payment_requests(company_id)
  where status = 'PENDING';

alter table public.payment_requests enable row level security;

create policy "Company owners read their payment requests"
  on public.payment_requests for select to authenticated
  using (
    exists (
      select 1
      from public.memberships m
      where m.company_id = payment_requests.company_id
        and m.user_id = (select auth.uid())
        and m.role = 'OWNER'
        and m.active
    )
  );

revoke all on public.payment_requests from public, anon, authenticated;
grant select on public.payment_requests to authenticated;
revoke all on sequence public.payment_variable_symbol_seq from public, anon, authenticated;

create or replace function public.create_payment_request(p_company_id uuid, p_plan text)
returns public.payment_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_amount numeric(8, 2);
  v_request public.payment_requests;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  v_amount := case p_plan
    when 'BASIC' then 19.00
    when 'PRO' then 39.00
    when 'TEAM' then 69.00
    else null
  end;

  if v_amount is null then
    raise exception 'Unsupported payment plan';
  end if;

  select m.company_id into v_company_id
  from public.memberships m
  where m.company_id = p_company_id
    and m.user_id = auth.uid()
    and m.role = 'OWNER'
    and m.active
  limit 1;

  if v_company_id is null then
    raise exception 'Only an active company owner can request a payment';
  end if;

  select * into v_request
  from public.payment_requests p
  where p.company_id = v_company_id
    and p.status = 'PENDING';

  if found then
    if v_request.plan <> p_plan then
      raise exception 'There is already a pending payment request for this company';
    end if;
    return v_request;
  end if;

  insert into public.payment_requests (
    company_id,
    requested_by,
    plan,
    amount_eur,
    variable_symbol
  )
  values (
    v_company_id,
    auth.uid(),
    p_plan,
    v_amount,
    lpad(nextval('public.payment_variable_symbol_seq')::text, 10, '0')
  )
  returning * into v_request;

  return v_request;
end;
$$;

revoke all on function public.create_payment_request(uuid, text) from public, anon;
grant execute on function public.create_payment_request(uuid, text) to authenticated;
