-- Run inside a transaction after the push migration; roll back the transaction afterwards.
do $test$
declare
  v_user uuid := gen_random_uuid();
  v_company uuid := gen_random_uuid();
  v_order uuid := gen_random_uuid();
  v_subscription uuid;
  v_disabled_subscription uuid;
  v_job_id bigint;
  v_now timestamp := date_trunc('hour', now() at time zone 'Europe/Bratislava') + interval '1 hour';
  v_first_count integer;
begin
  insert into auth.users(id, email) values (v_user, v_user::text || '@example.invalid');
  insert into public.companies(id, name, created_by) values (v_company, 'Push test', v_user);
  insert into public.memberships(company_id, user_id, email, role, active)
    values (v_company, v_user, v_user::text || '@example.invalid', 'EMPLOYEE', true);
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth_key, assignment_enabled, reminder_enabled)
    values (v_user, 'https://fcm.googleapis.com/' || v_user::text, repeat('a', 87), repeat('a', 22), true, true)
    returning id into v_subscription;
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth_key)
    values (v_user, 'https://fcm.googleapis.com/disabled-' || v_user::text, repeat('a', 87), repeat('a', 22))
    returning id into v_disabled_subscription;
  insert into public.work_orders(id, company_id, assignee_id, created_by, title, address, description, due_date, starts_at, ends_at)
    values (v_order, v_company, v_user, v_user, 'Push test', 'Push test', 'Push test',
      v_now::date, v_now::time, (v_now + interval '1 minute')::time);
  insert into public.work_order_assignees(work_order_id, company_id, user_id)
    values (v_order, v_company, v_user);
  if (select count(*) from public.push_notification_jobs where subscription_id = v_subscription and kind = 'ASSIGNMENT') <> 1 then
    raise exception 'Assignment notification not queued';
  end if;
  if exists (select 1 from public.push_notification_jobs where subscription_id = v_disabled_subscription) then
    raise exception 'Notification queued without opt-in';
  end if;
  select count(*) into v_first_count from public.claim_work_order_push_jobs() where subscription_id = v_subscription;
  if v_first_count <> 2 then raise exception 'Expected one assignment and one reminder, got %', v_first_count; end if;
  if exists (select 1 from public.claim_work_order_push_jobs() where subscription_id = v_subscription) then
    raise exception 'Jobs were claimed twice';
  end if;
  select id into v_job_id from public.push_notification_jobs where subscription_id = v_subscription and kind = 'ASSIGNMENT';
  perform public.finish_work_order_push_job(v_job_id, 'sent', null);
  if not exists (select 1 from public.push_notification_jobs where id = v_job_id and delivered_at is not null) then
    raise exception 'Successful delivery was not recorded';
  end if;
  update public.work_orders set status = 'DONE' where id = v_order;
  update public.push_notification_jobs set claimed_until = null where subscription_id = v_subscription and kind = 'REMINDER';
  if exists (select 1 from public.claim_work_order_push_jobs() where subscription_id = v_subscription) then
    raise exception 'Completed work order produced a notification';
  end if;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  begin
    perform public.save_push_subscription('https://invalid.example/path', repeat('a', 87), repeat('a', 22), true, true);
    raise exception 'Invalid endpoint accepted';
  exception when others then
    if sqlerrm <> 'Neplatné nastavenie push notifikácií.' then raise; end if;
  end;
  if has_function_privilege('authenticated', 'public.claim_work_order_push_jobs()', 'execute') then
    raise exception 'Authenticated users can claim jobs';
  end if;
end;
$test$;
