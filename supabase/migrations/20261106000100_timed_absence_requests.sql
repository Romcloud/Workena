alter table public.absence_requests
  add column start_time time,
  add column end_time time,
  add constraint absence_requests_time_pair check (
    (start_time is null and end_time is null)
    or (start_time is not null and end_time is not null)
  ),
  add constraint absence_requests_timed_single_day check (
    start_time is null or start_date = end_date
  ),
  add constraint absence_requests_time_range check (
    start_time is null or end_time > start_time
  );

create function public.create_absence_request(
  p_company_id uuid,
  p_type text,
  p_start_date date,
  p_end_date date,
  p_note text,
  p_start_time time,
  p_end_time time
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_absence_id uuid;
begin
  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'Pri časovo obmedzenej neprítomnosti vyplňte čas od aj do.';
  end if;
  if p_start_time is not null and p_end_date <> p_start_date then
    raise exception 'Časovo obmedzená neprítomnosť musí byť zadaná pre jeden deň.';
  end if;
  if p_start_time is not null and p_end_time <= p_start_time then
    raise exception 'Čas do musí byť neskôr ako čas od.';
  end if;
  v_absence_id := public.create_absence_request(
    p_company_id, p_type, p_start_date, p_end_date, p_note
  );
  update public.absence_requests
  set start_time = p_start_time, end_time = p_end_time
  where id = v_absence_id;
  return v_absence_id;
end;
$$;

revoke all on function public.create_absence_request(uuid, text, date, date, text, time, time) from public, anon;
grant execute on function public.create_absence_request(uuid, text, date, date, text, time, time) to authenticated;

notify pgrst, 'reload schema';
