create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  assignment_enabled boolean not null default false,
  reminder_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select on public.push_subscriptions to authenticated;
create policy "Users read own push subscriptions" on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));

create table public.push_notification_jobs (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('ASSIGNMENT', 'REMINDER')),
  event_key text not null,
  scheduled_start timestamptz,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  claimed_until timestamptz,
  attempts integer not null default 0,
  delivered_at timestamptz,
  last_error text,
  unique (subscription_id, work_order_id, kind, event_key)
);

alter table public.push_notification_jobs enable row level security;
revoke all on public.push_notification_jobs from public, anon, authenticated;
create index push_notification_jobs_pending_idx on public.push_notification_jobs(next_attempt_at)
  where delivered_at is null and attempts < 5;

create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth_key text,
  p_assignment_enabled boolean, p_reminder_enabled boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or p_endpoint is null or char_length(p_endpoint) > 2048
    or p_endpoint !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[^./]+\.push\.apple\.com|[^./]+\.notify\.windows\.com)/'
    or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{80,100}$'
    or p_auth_key is null or p_auth_key !~ '^[A-Za-z0-9_-]{20,30}$'
    or p_assignment_enabled is null or p_reminder_enabled is null then
    raise exception 'Neplatné nastavenie push notifikácií.';
  end if;
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth_key, assignment_enabled, reminder_enabled)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth_key, p_assignment_enabled, p_reminder_enabled)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth_key = excluded.auth_key,
    assignment_enabled = excluded.assignment_enabled, reminder_enabled = excluded.reminder_enabled
  where push_subscriptions.user_id = auth.uid();
  if not found then
    raise exception 'Toto zariadenie je priradené k inému účtu. Odhláste sa z neho a skúste znova.';
  end if;
end;
$$;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where user_id = auth.uid() and endpoint = p_endpoint;
$$;

revoke all on function public.save_push_subscription(text,text,text,boolean,boolean) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text,text,text,boolean,boolean) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;

create or replace function public.queue_work_order_assignment_push()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.push_notification_jobs(subscription_id, company_id, work_order_id, user_id, kind, event_key)
    select s.id, new.company_id, new.work_order_id, new.user_id, 'ASSIGNMENT', 'assigned'
    from public.push_subscriptions s where s.user_id = new.user_id and s.assignment_enabled
    on conflict do nothing;
  return new;
end;
$$;
create trigger queue_work_order_assignment_push after insert on public.work_order_assignees
  for each row execute function public.queue_work_order_assignment_push();
revoke all on function public.queue_work_order_assignment_push() from public, anon, authenticated;

create or replace function public.claim_work_order_push_jobs()
returns table(job_id bigint, subscription_id uuid, endpoint text, p256dh text, auth_key text, kind text)
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.push_notification_jobs(subscription_id, company_id, work_order_id, user_id, kind, event_key, scheduled_start)
  select s.id, w.company_id, w.id, a.user_id, 'REMINDER',
    extract(epoch from timing.start_at)::text, timing.start_at
  from public.work_orders w
  join public.work_order_assignees a on a.work_order_id = w.id and a.company_id = w.company_id
  join public.memberships m on m.company_id = a.company_id and m.user_id = a.user_id and m.active
  join public.push_subscriptions s on s.user_id = a.user_id and s.reminder_enabled
  cross join lateral (
    select (w.due_date + coalesce(w.starts_at, time '08:00')) at time zone 'Europe/Bratislava' as start_at
  ) timing
  where w.status <> 'DONE' and a.declined_at is null
    and ((w.starts_at is not null and now() >= timing.start_at - interval '1 hour' and now() < timing.start_at)
      or (w.starts_at is null and now() >= timing.start_at and now() < timing.start_at + interval '1 hour'))
  on conflict do nothing;

  return query
  with pending as (
    select j.id
    from public.push_notification_jobs j
    join public.push_subscriptions s on s.id = j.subscription_id and s.user_id = j.user_id
    join public.work_orders w on w.id = j.work_order_id and w.company_id = j.company_id and w.status <> 'DONE'
    join public.work_order_assignees a on a.work_order_id = j.work_order_id and a.user_id = j.user_id
      and a.company_id = j.company_id and a.declined_at is null
    join public.memberships m on m.company_id = j.company_id and m.user_id = j.user_id and m.active
    where j.delivered_at is null and j.attempts < 5 and j.next_attempt_at <= now()
      and (j.claimed_until is null or j.claimed_until < now())
      and ((j.kind = 'ASSIGNMENT' and s.assignment_enabled and j.created_at > now() - interval '1 day')
        or (j.kind = 'REMINDER' and s.reminder_enabled
          and j.scheduled_start = ((w.due_date + coalesce(w.starts_at, time '08:00')) at time zone 'Europe/Bratislava')
          and now() < j.scheduled_start + case when w.starts_at is null then interval '1 hour' else interval '0' end))
    order by j.id for update of j skip locked limit 100
  ), claimed as (
    update public.push_notification_jobs j set claimed_until = now() + interval '5 minutes', attempts = j.attempts + 1
    from pending where j.id = pending.id
    returning j.id, j.subscription_id, j.kind
  )
  select c.id, s.id, s.endpoint, s.p256dh, s.auth_key, c.kind
  from claimed c join public.push_subscriptions s on s.id = c.subscription_id;
end;
$$;

create or replace function public.finish_work_order_push_job(p_job_id bigint, p_status text, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_subscription_id uuid;
begin
  if p_status not in ('sent', 'expired', 'retry') then raise exception 'Neplatný stav notifikácie.'; end if;
  if p_status = 'expired' then
    select subscription_id into v_subscription_id from public.push_notification_jobs where id = p_job_id;
    delete from public.push_subscriptions where id = v_subscription_id;
  else
    update public.push_notification_jobs set
      delivered_at = case when p_status = 'sent' then now() else null end,
      claimed_until = null, next_attempt_at = now() + interval '2 minutes',
      last_error = case when p_status = 'retry' then left(p_error, 300) else null end
    where id = p_job_id;
  end if;
end;
$$;
revoke all on function public.claim_work_order_push_jobs() from public, anon, authenticated;
revoke all on function public.finish_work_order_push_job(bigint,text,text) from public, anon, authenticated;
grant execute on function public.claim_work_order_push_jobs() to service_role;
grant execute on function public.finish_work_order_push_job(bigint,text,text) to service_role;

notify pgrst, 'reload schema';
