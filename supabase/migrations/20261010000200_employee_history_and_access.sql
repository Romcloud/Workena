alter table public.memberships
  add column if not exists active boolean not null default true,
  add column if not exists deactivated_at timestamptz;

alter table public.companies
  add column if not exists plan text not null default 'FREE'
  check (plan in ('FREE', 'PRO'));

create or replace function public.is_company_member(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.active
  );
$$;

create or replace function public.can_manage_company(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.active
      and m.role in ('OWNER', 'MANAGER')
  );
$$;

create or replace function public.resubmit_work_entry(p_entry_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.work_entries e
    set status = 'PENDING',
        review_note = null,
        reviewed_at = null,
        reviewed_by = null,
        updated_at = now()
    where e.id = p_entry_id
      and e.user_id = (select auth.uid())
      and e.status = 'REJECTED'
      and (select public.is_company_member(e.company_id));
  if not found then
    raise exception 'Záznam neexistuje alebo ho nemôžete znova odoslať.';
  end if;
end;
$$;

create or replace function public.can_upload_work_entry(p_entry_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.work_entries e
    where e.id = p_entry_id
      and (select public.is_company_member(e.company_id))
      and (
        public.can_manage_company(e.company_id)
        or (e.user_id = (select auth.uid()) and e.status in ('PENDING', 'REJECTED'))
      )
  );
$$;

create or replace function public.add_company_member(
  p_company_id uuid,
  p_email text,
  p_role text default 'EMPLOYEE'
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor_role text;
  v_member_id uuid;
  v_user_id uuid;
  v_email text;
  v_full_name text;
  v_plan text;
  v_active_employee_count integer;
  v_existing_role text;
  v_existing_active boolean;
  v_requested_email text := lower(trim(p_email));
begin
  select c.plan into v_plan
    from public.companies c
    where c.id = p_company_id
    for update;
  if v_plan is null then
    raise exception 'Firemný priestor sa nenašiel.';
  end if;

  select m.role into v_actor_role
    from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.active;

  if v_actor_role is null or v_actor_role not in ('OWNER', 'MANAGER') then
    raise exception 'Na správu členov nemáte oprávnenie.';
  end if;
  if p_role is null or p_role not in ('MANAGER', 'EMPLOYEE')
    or (p_role = 'MANAGER' and v_actor_role <> 'OWNER') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;
  if v_requested_email = '' or char_length(v_requested_email) > 320 then
    raise exception 'Zadajte platnú e-mailovú adresu.';
  end if;

  select u.id, lower(u.email), nullif(trim(u.raw_user_meta_data ->> 'full_name'), '')
    into v_user_id, v_email, v_full_name
    from auth.users u
    where lower(u.email) = v_requested_email;
  if v_user_id is null then
    raise exception 'Používateľ sa ešte neprihlásil do aplikácie cez Google.';
  end if;

  select m.role, m.active
    into v_existing_role, v_existing_active
    from public.memberships m
    where m.company_id = p_company_id and m.user_id = v_user_id;
  if v_existing_active is true then
    raise exception 'Tento používateľ už je členom firmy.';
  end if;
  if v_existing_role = 'OWNER'
    or (v_existing_active is false and v_actor_role = 'MANAGER' and v_existing_role is distinct from 'EMPLOYEE')
    or (v_existing_role = 'MANAGER' and p_role <> 'MANAGER') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;

  if p_role = 'EMPLOYEE' and v_plan = 'FREE' then
    select count(*)::integer into v_active_employee_count
      from public.memberships m
      where m.company_id = p_company_id and m.role = 'EMPLOYEE' and m.active;
    if v_active_employee_count >= 2 then
      raise exception 'Bezplatný plán umožňuje najviac 2 zamestnancov. Pre viac zamestnancov je dostupný Workena Pro za 50 € ročne.';
    end if;
  end if;

  insert into public.memberships as existing_membership(company_id, user_id, email, full_name, role, active, deactivated_at)
    values (p_company_id, v_user_id, v_email, v_full_name, p_role, true, null)
    on conflict (company_id, user_id) do update
      set email = excluded.email,
          full_name = excluded.full_name,
          role = excluded.role,
          active = true,
          deactivated_at = null
      where existing_membership.active = false
    returning id into v_member_id;
  if v_member_id is null then
    raise exception 'Používateľa sa nepodarilo pridať do firmy.';
  end if;
  return v_member_id;
end;
$$;

create or replace function public.remove_company_member(p_membership_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor_role text;
  v_target_role text;
  v_company_id uuid;
begin
  select actor.role, target.role, target.company_id
    into v_actor_role, v_target_role, v_company_id
    from public.memberships target
    join public.memberships actor
      on actor.company_id = target.company_id
      and actor.user_id = (select auth.uid())
      and actor.active
    where target.id = p_membership_id and target.active;

  if v_actor_role is null or v_target_role is null
    or v_target_role = 'OWNER'
    or (v_actor_role = 'MANAGER' and v_target_role <> 'EMPLOYEE')
    or v_actor_role not in ('OWNER', 'MANAGER') then
    raise exception 'Tohto člena nemôžete odstrániť.';
  end if;

  update public.memberships
    set active = false, deactivated_at = now()
    where id = p_membership_id and company_id = v_company_id and active;
end;
$$;

drop policy if exists "Members read own membership and managers read company roster" on public.memberships;
create policy "Active members read own membership and managers read company roster"
  on public.memberships for select to authenticated
  using (
    (user_id = (select auth.uid()) and active)
    or (select public.can_manage_company(company_id))
  );

drop policy if exists "Members read own work entries and managers read company entries" on public.work_entries;
create policy "Active members read own work entries and managers read company entries"
  on public.work_entries for select to authenticated
  using (
    (user_id = (select auth.uid()) and (select public.is_company_member(company_id)))
    or (select public.can_manage_company(company_id))
  );

drop policy if exists "Authors edit pending entries and managers edit company entries" on public.work_entries;
create policy "Active authors edit pending entries and managers edit company entries"
  on public.work_entries for update to authenticated
  using (
    (user_id = (select auth.uid()) and status in ('PENDING', 'REJECTED') and (select public.is_company_member(company_id)))
    or (select public.can_manage_company(company_id))
  )
  with check (
    (user_id = (select auth.uid()) and status in ('PENDING', 'REJECTED') and (select public.is_company_member(company_id)))
    or (select public.can_manage_company(company_id))
  );

drop policy if exists "Authors delete editable entries and managers delete company entries" on public.work_entries;
create policy "Active authors delete pending entries and managers delete company entries"
  on public.work_entries for delete to authenticated
  using (
    (user_id = (select auth.uid()) and status = 'PENDING' and (select public.is_company_member(company_id)))
    or (select public.can_manage_company(company_id))
  );

drop policy if exists "Members read own photos and managers read company photos" on public.photos;
create policy "Active members read own photos and managers read company photos"
  on public.photos for select to authenticated
  using (
    exists (
      select 1 from public.work_entries e
      where e.id = work_entry_id
        and e.company_id = photos.company_id
        and (select public.is_company_member(e.company_id))
        and (
          e.user_id = (select auth.uid())
          or (select public.can_manage_company(e.company_id))
        )
    )
  );

drop policy if exists "Members view own photos and managers view company photos" on storage.objects;
create policy "Active members view own photos and managers view company photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'work-photos'
    and exists (
      select 1 from public.work_entries e
      where e.company_id::text = (storage.foldername(name))[1]
        and e.id::text = (storage.foldername(name))[2]
        and (select public.is_company_member(e.company_id))
        and (
          e.user_id = (select auth.uid())
          or (select public.can_manage_company(e.company_id))
        )
    )
  );
