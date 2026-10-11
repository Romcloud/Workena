-- Platform administration: a small set of people (not tied to any company)
-- who can see every registered company and assign/change its license plan.

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from public, anon, authenticated;

create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa where pa.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- Allow richer license tiers on the company itself, matching the payment plans
-- (previously only FREE/PRO existed, which collapsed BASIC/TEAM into nothing).
alter table public.companies
  drop constraint if exists companies_plan_check;
alter table public.companies
  add constraint companies_plan_check check (plan in ('FREE', 'BASIC', 'PRO', 'TEAM'));

create or replace function public.admin_list_companies()
returns table (
  company_id uuid,
  name text,
  created_at timestamptz,
  plan text,
  selected_plan text,
  owner_email text,
  owner_name text,
  member_count integer,
  pending_payment_id uuid,
  pending_payment_plan text,
  pending_payment_amount numeric,
  pending_payment_variable_symbol text,
  pending_payment_created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Prístup odmietnutý.';
  end if;

  return query
  select
    c.id,
    c.name,
    c.created_at,
    c.plan,
    c.selected_plan,
    owner.email,
    owner.full_name,
    coalesce(cnt.member_count, 0),
    pr.id,
    pr.plan,
    pr.amount_eur,
    pr.variable_symbol,
    pr.created_at
  from public.companies c
  left join lateral (
    select m.email, m.full_name
    from public.memberships m
    where m.company_id = c.id and m.role = 'OWNER'
    order by m.created_at asc
    limit 1
  ) owner on true
  left join lateral (
    select count(*)::integer as member_count
    from public.memberships m2
    where m2.company_id = c.id and m2.active
  ) cnt on true
  left join lateral (
    select p.id, p.plan, p.amount_eur, p.variable_symbol, p.created_at
    from public.payment_requests p
    where p.company_id = c.id and p.status = 'PENDING'
    order by p.created_at desc
    limit 1
  ) pr on true
  order by c.created_at desc;
end;
$$;

revoke all on function public.admin_list_companies() from public, anon;
grant execute on function public.admin_list_companies() to authenticated;

create or replace function public.admin_set_company_plan(p_company_id uuid, p_plan text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Prístup odmietnutý.';
  end if;
  if p_plan is null or p_plan not in ('FREE', 'BASIC', 'PRO', 'TEAM') then
    raise exception 'Neplatný plán.';
  end if;

  update public.companies
  set plan = p_plan
  where id = p_company_id;

  if not found then
    raise exception 'Firma sa nenašla.';
  end if;
end;
$$;

revoke all on function public.admin_set_company_plan(uuid, text) from public, anon;
grant execute on function public.admin_set_company_plan(uuid, text) to authenticated;

create or replace function public.admin_review_payment_request(p_request_id uuid, p_approve boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_plan text;
begin
  if not public.is_platform_admin() then
    raise exception 'Prístup odmietnutý.';
  end if;

  select company_id, plan into v_company_id, v_plan
  from public.payment_requests
  where id = p_request_id and status = 'PENDING'
  for update;

  if v_company_id is null then
    raise exception 'Žiadosť o platbu sa nenašla alebo už bola spracovaná.';
  end if;

  update public.payment_requests
  set status = case when p_approve then 'CONFIRMED' else 'REJECTED' end,
      reviewed_at = now()
  where id = p_request_id;

  if p_approve then
    update public.companies
    set plan = v_plan
    where id = v_company_id;
  end if;
end;
$$;

revoke all on function public.admin_review_payment_request(uuid, boolean) from public, anon;
grant execute on function public.admin_review_payment_request(uuid, boolean) to authenticated;

-- Seed the first platform administrator.
insert into public.platform_admins (user_id)
select id from auth.users where lower(email) = lower('info@rovolt.sk')
on conflict do nothing;

notify pgrst, 'reload schema';
