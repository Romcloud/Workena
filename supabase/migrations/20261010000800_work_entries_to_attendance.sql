alter table public.attendance_shifts
  add column source_work_entry_id uuid unique
    references public.work_entries(id) on delete cascade;

create or replace function public.sync_work_entry_to_attendance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_work_date date := (new.worked_at at time zone 'Europe/Bratislava')::date;
  v_new_lock_key bigint := hashtextextended(
    new.company_id::text || ':' || new.user_id::text || ':' || to_char(v_work_date, 'YYYY-MM-DD'),
    0
  );
  v_old_lock_key bigint;
begin
  if tg_op = 'UPDATE' then
    v_old_lock_key := hashtextextended(
      old.company_id::text || ':' || old.user_id::text || ':' ||
        to_char((old.worked_at at time zone 'Europe/Bratislava')::date, 'YYYY-MM-DD'),
      0
    );
    if v_old_lock_key < v_new_lock_key then
      perform pg_advisory_xact_lock(v_old_lock_key);
      perform pg_advisory_xact_lock(v_new_lock_key);
    elsif v_old_lock_key > v_new_lock_key then
      perform pg_advisory_xact_lock(v_new_lock_key);
      perform pg_advisory_xact_lock(v_old_lock_key);
    else
      perform pg_advisory_xact_lock(v_new_lock_key);
    end if;
  else
    perform pg_advisory_xact_lock(v_new_lock_key);
  end if;

  if exists (
    select 1
    from public.attendance_shifts s
    where s.company_id = new.company_id
      and s.user_id = new.user_id
      and s.source_work_entry_id is null
      and (s.started_at at time zone 'Europe/Bratislava')::date = v_work_date
  ) then
    delete from public.attendance_shifts s
    where s.source_work_entry_id = new.id;
    return new;
  end if;

  insert into public.attendance_shifts (
    company_id,
    user_id,
    started_at,
    ended_at,
    source_work_entry_id
  )
  values (
    new.company_id,
    new.user_id,
    new.worked_at,
    new.worked_at + make_interval(secs => new.hours::double precision * 3600),
    new.id
  )
  on conflict (source_work_entry_id) do update
    set company_id = excluded.company_id,
        user_id = excluded.user_id,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at;

  return new;
end;
$$;

revoke all on function public.sync_work_entry_to_attendance() from public, anon, authenticated;

create trigger sync_work_entry_attendance
  after insert or update of company_id, user_id, worked_at, hours
  on public.work_entries
  for each row execute function public.sync_work_entry_to_attendance();

insert into public.attendance_shifts (
  company_id,
  user_id,
  started_at,
  ended_at,
  source_work_entry_id
)
select
  e.company_id,
  e.user_id,
  e.worked_at,
  e.worked_at + make_interval(secs => e.hours::double precision * 3600),
  e.id
from public.work_entries e
where not exists (
  select 1
  from public.attendance_shifts s
  where s.company_id = e.company_id
    and s.user_id = e.user_id
    and s.source_work_entry_id is null
    and (s.started_at at time zone 'Europe/Bratislava')::date =
      (e.worked_at at time zone 'Europe/Bratislava')::date
)
on conflict (source_work_entry_id) do nothing;

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
