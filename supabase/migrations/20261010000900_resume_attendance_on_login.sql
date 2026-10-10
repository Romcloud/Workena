create or replace function public.start_attendance(p_company_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift_id uuid;
  v_started_at timestamptz := now();
  v_work_date date := (now() at time zone 'Europe/Bratislava')::date;
begin
  if not (select public.is_company_member(p_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_company_id::text || ':' || (select auth.uid())::text || ':' ||
      to_char(v_work_date, 'YYYY-MM-DD'),
    0
  ));

  select s.id into v_shift_id
  from public.attendance_shifts s
  where s.company_id = p_company_id
    and s.user_id = (select auth.uid())
    and s.ended_at is null
  for update;

  if v_shift_id is not null then
    delete from public.attendance_shifts s
    where s.company_id = p_company_id
      and s.user_id = (select auth.uid())
      and s.source_work_entry_id is not null
      and (s.started_at at time zone 'Europe/Bratislava')::date = v_work_date;
    return v_shift_id;
  end if;

  delete from public.attendance_shifts s
  where s.company_id = p_company_id
    and s.user_id = (select auth.uid())
    and s.source_work_entry_id is not null
    and (s.started_at at time zone 'Europe/Bratislava')::date = v_work_date;

  insert into public.attendance_shifts(company_id, user_id, started_at)
    values (p_company_id, (select auth.uid()), v_started_at)
    returning id into v_shift_id;
  return v_shift_id;
exception
  when unique_violation then
    raise exception 'Už máte spustenú pracovnú zmenu.';
end;
$$;

notify pgrst, 'reload schema';
