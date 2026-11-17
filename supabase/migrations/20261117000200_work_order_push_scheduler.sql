create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.dispatch_work_order_push()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'workena_push_function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'workena_push_scheduler_secret';
  if v_url is null or v_secret is null then
    raise exception 'Workena push scheduler secrets are not configured in Vault.';
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := jsonb_build_object('action', 'dispatch'),
    timeout_milliseconds := 120000
  );
end;
$$;
revoke all on function public.dispatch_work_order_push() from public, anon, authenticated;

select cron.schedule('workena-work-order-push', '* * * * *', 'select public.dispatch_work_order_push();')
where not exists (select 1 from cron.job where jobname = 'workena-work-order-push');
