alter table public.companies
  add column pro_trial_started_at timestamptz,
  add column pro_trial_ends_at timestamptz,
  add constraint companies_pro_trial_dates_check check (
    pro_trial_ends_at is null
    or (pro_trial_started_at is not null and pro_trial_ends_at > pro_trial_started_at)
  );

create or replace function public.start_company_pro_trial(p_company_id uuid)
returns table (pro_trial_started_at timestamptz, pro_trial_ends_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_role text;
  v_plan text;
  v_started_at timestamptz;
begin
  select m.role into v_role
  from public.memberships m
  where m.company_id = p_company_id
    and m.user_id = (select auth.uid())
    and m.active;

  if v_role is distinct from 'OWNER' then
    raise exception 'Skúšobnú verziu môže aktivovať iba vlastník firmy.';
  end if;

  select c.plan, c.pro_trial_started_at into v_plan, v_started_at
  from public.companies c
  where c.id = p_company_id
  for update;

  if not found then
    raise exception 'Firemný priestor sa nenašiel.';
  end if;
  if v_plan <> 'FREE' then
    raise exception 'Skúšobnú verziu Pro možno aktivovať iba pri pláne Free.';
  end if;
  if v_started_at is not null then
    raise exception 'Táto firma už skúšobnú verziu Pro využila.';
  end if;

  return query
  update public.companies c
  set plan = 'PRO',
      pro_trial_started_at = now(),
      pro_trial_ends_at = now() + interval '30 days'
  where c.id = p_company_id
  returning c.pro_trial_started_at, c.pro_trial_ends_at;
end;
$$;

revoke all on function public.start_company_pro_trial(uuid) from public, anon;
grant execute on function public.start_company_pro_trial(uuid) to authenticated;

create or replace function public.sync_company_pro_trial(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.active
  ) then
    raise exception 'K tomuto firemnému priestoru nemáte prístup.';
  end if;

  update public.companies c
  set plan = 'FREE',
      pro_trial_ends_at = null
  where c.id = p_company_id
    and c.plan = 'PRO'
    and c.pro_trial_ends_at <= now();
end;
$$;

revoke all on function public.sync_company_pro_trial(uuid) from public, anon;
grant execute on function public.sync_company_pro_trial(uuid) to authenticated;

create or replace function public.expire_company_pro_trials()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_expired_count integer;
begin
  update public.companies c
  set plan = 'FREE',
      pro_trial_ends_at = null
  where c.plan = 'PRO'
    and c.pro_trial_ends_at <= now();
  get diagnostics v_expired_count = row_count;
  return v_expired_count;
end;
$$;

revoke all on function public.expire_company_pro_trials() from public, anon, authenticated;

create extension if not exists pg_cron;

select cron.schedule(
  'workena-expire-pro-trials',
  '*/5 * * * *',
  'select public.expire_company_pro_trials();'
)
where not exists (
  select 1 from cron.job where jobname = 'workena-expire-pro-trials'
);

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
  set plan = p_plan,
      pro_trial_ends_at = null
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
    set plan = v_plan,
        pro_trial_ends_at = null
    where id = v_company_id;
  end if;
end;
$$;

revoke all on function public.admin_review_payment_request(uuid, boolean) from public, anon;
grant execute on function public.admin_review_payment_request(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
