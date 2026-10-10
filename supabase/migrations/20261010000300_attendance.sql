create table public.attendance_shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at)
);

create index attendance_shifts_company_started_idx
  on public.attendance_shifts(company_id, started_at desc);
create index attendance_shifts_user_started_idx
  on public.attendance_shifts(user_id, started_at desc);
create unique index attendance_shifts_one_open_per_member_idx
  on public.attendance_shifts(company_id, user_id)
  where ended_at is null;

create table public.attendance_breaks (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.attendance_shifts(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at)
);

create index attendance_breaks_shift_started_idx
  on public.attendance_breaks(shift_id, started_at);
create unique index attendance_breaks_one_open_per_shift_idx
  on public.attendance_breaks(shift_id)
  where ended_at is null;

create or replace function public.close_attendance_on_membership_deactivation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_closed_at timestamptz := coalesce(new.deactivated_at, now());
begin
  if old.active and not new.active then
    update public.attendance_breaks b
      set ended_at = greatest(v_closed_at, b.started_at + interval '1 microsecond')
      from public.attendance_shifts s
      where b.shift_id = s.id
        and s.company_id = new.company_id
        and s.user_id = new.user_id
        and s.ended_at is null
        and b.ended_at is null;

    update public.attendance_shifts s
      set ended_at = greatest(v_closed_at, s.started_at + interval '1 microsecond')
      where s.company_id = new.company_id
        and s.user_id = new.user_id
        and s.ended_at is null;
  end if;
  return new;
end;
$$;

create trigger close_attendance_after_membership_deactivation
  after update of active on public.memberships
  for each row execute function public.close_attendance_on_membership_deactivation();

alter table public.attendance_shifts enable row level security;
alter table public.attendance_breaks enable row level security;

create policy "Members read own attendance and managers read company attendance"
  on public.attendance_shifts for select to authenticated
  using (
    (user_id = (select auth.uid()) and (select public.is_company_member(company_id)))
    or (select public.can_manage_company(company_id))
  );

create policy "Members read own attendance breaks and managers read company breaks"
  on public.attendance_breaks for select to authenticated
  using (
    exists (
      select 1
      from public.attendance_shifts s
      where s.id = shift_id
        and (
          (s.user_id = (select auth.uid()) and (select public.is_company_member(s.company_id)))
          or (select public.can_manage_company(s.company_id))
        )
    )
  );

revoke all on public.attendance_shifts, public.attendance_breaks from anon, authenticated;
grant select on public.attendance_shifts, public.attendance_breaks to authenticated;

create or replace function public.start_attendance(p_company_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift_id uuid;
begin
  if not (select public.is_company_member(p_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;

  insert into public.attendance_shifts(company_id, user_id)
    values (p_company_id, (select auth.uid()))
    returning id into v_shift_id;
  return v_shift_id;
exception
  when unique_violation then
    raise exception 'Už máte spustenú pracovnú zmenu.';
end;
$$;

create or replace function public.start_attendance_break(p_company_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift_id uuid;
  v_break_id uuid;
begin
  if not (select public.is_company_member(p_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;
  select s.id into v_shift_id
    from public.attendance_shifts s
    where s.company_id = p_company_id
      and s.user_id = (select auth.uid())
      and s.ended_at is null
    for update;
  if v_shift_id is null then
    raise exception 'Nemáte spustenú pracovnú zmenu.';
  end if;

  insert into public.attendance_breaks(shift_id)
    values (v_shift_id)
    returning id into v_break_id;
  return v_break_id;
exception
  when unique_violation then
    raise exception 'Prestávka už prebieha.';
end;
$$;

create or replace function public.end_attendance_break(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift_id uuid;
begin
  if not (select public.is_company_member(p_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;
  select s.id into v_shift_id
    from public.attendance_shifts s
    where s.company_id = p_company_id
      and s.user_id = (select auth.uid())
      and s.ended_at is null
    for update;
  if v_shift_id is null then
    raise exception 'Nemáte spustenú pracovnú zmenu.';
  end if;

  update public.attendance_breaks b
    set ended_at = now()
    where b.shift_id = v_shift_id and b.ended_at is null;
  if not found then
    raise exception 'Nemáte spustenú prestávku.';
  end if;
end;
$$;

create or replace function public.end_attendance(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_shift_id uuid;
begin
  if not (select public.is_company_member(p_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;
  select s.id into v_shift_id
    from public.attendance_shifts s
    where s.company_id = p_company_id
      and s.user_id = (select auth.uid())
      and s.ended_at is null
    for update;
  if v_shift_id is null then
    raise exception 'Nemáte spustenú pracovnú zmenu.';
  end if;
  if exists (
    select 1 from public.attendance_breaks b
    where b.shift_id = v_shift_id and b.ended_at is null
  ) then
    raise exception 'Pred ukončením zmeny ukončite prestávku.';
  end if;

  update public.attendance_shifts
    set ended_at = now()
    where id = v_shift_id and ended_at is null;
end;
$$;

revoke all on function public.start_attendance(uuid) from public, anon;
revoke all on function public.start_attendance_break(uuid) from public, anon;
revoke all on function public.end_attendance_break(uuid) from public, anon;
revoke all on function public.end_attendance(uuid) from public, anon;
grant execute on function public.start_attendance(uuid) to authenticated;
grant execute on function public.start_attendance_break(uuid) to authenticated;
grant execute on function public.end_attendance_break(uuid) to authenticated;
grant execute on function public.end_attendance(uuid) to authenticated;
