create table public.company_invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null check (char_length(trim(full_name)) between 1 and 120),
  role text not null check (role in ('MANAGER', 'EMPLOYEE', 'ACCOUNTANT')),
  is_employee boolean not null default false,
  is_external boolean not null default false,
  is_minor boolean not null default false,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  check ((not is_external or role = 'EMPLOYEE') and (not is_minor or (role = 'EMPLOYEE' or is_employee)) and (not (is_external and is_minor)))
);

create unique index company_invitations_pending_email_idx
  on public.company_invitations(company_id, email)
  where accepted_at is null;

alter table public.company_invitations enable row level security;
revoke all on public.company_invitations from public, anon, authenticated;

create or replace function public.add_or_invite_company_member(
  p_company_id uuid,
  p_email text,
  p_full_name text,
  p_role text default 'EMPLOYEE',
  p_is_employee boolean default false,
  p_is_external boolean default false,
  p_is_minor boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor_role text;
  v_member_id uuid;
  v_user_id uuid;
  v_email text;
  v_plan text;
  v_employee_limit integer;
  v_employee_count integer;
  v_is_employee boolean;
  v_invitation_id uuid;
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
  if p_role is null or p_role not in ('MANAGER', 'EMPLOYEE', 'ACCOUNTANT')
    or (p_role = 'MANAGER' and v_actor_role <> 'OWNER') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;

  v_email := lower(trim(p_email));
  if v_email is null or v_email = '' or char_length(v_email) > 320 or position('@' in v_email) < 2 then
    raise exception 'Zadajte platnú e-mailovú adresu.';
  end if;
  if p_full_name is null or char_length(trim(p_full_name)) not between 1 and 120 then
    raise exception 'Meno musí mať 1 až 120 znakov.';
  end if;
  v_is_employee := p_role = 'EMPLOYEE' or coalesce(p_is_employee, false);
  if p_is_external and p_role <> 'EMPLOYEE' then
    raise exception 'Príznak externého zamestnanca možno použiť iba pri roli Zamestnanec.';
  end if;
  if p_is_minor and (not v_is_employee or p_is_external) then
    raise exception 'Mladistvého možno označiť iba pri internom zamestnancovi.';
  end if;

  select u.id
    into v_user_id
    from auth.users u
    where lower(u.email) = v_email;

  if v_user_id is not null then
    v_member_id := public.add_company_member(
      p_company_id, v_email, p_role, v_is_employee, coalesce(p_is_external, false), coalesce(p_is_minor, false)
    );
    update public.memberships
      set full_name = trim(p_full_name)
      where id = v_member_id;
    update public.company_invitations
      set accepted_at = now()
      where company_id = p_company_id
        and email = v_email
        and accepted_at is null;
    return jsonb_build_object('status', 'added');
  end if;

  select i.id into v_invitation_id
    from public.company_invitations i
    where i.company_id = p_company_id
      and i.email = v_email
      and i.accepted_at is null
    for update;

  if v_is_employee then
    v_employee_limit := public.plan_employee_limit(v_plan);
    if v_employee_limit is not null then
      select
        (select count(*)::integer
          from public.memberships m
          where m.company_id = p_company_id and m.active
            and (m.role = 'EMPLOYEE' or (m.role = 'ACCOUNTANT' and m.is_employee)))
        +
        (select count(*)::integer
          from public.company_invitations i
          where i.company_id = p_company_id
            and i.accepted_at is null
            and i.expires_at > now()
            and (i.role = 'EMPLOYEE' or i.is_employee)
            and i.id is distinct from v_invitation_id)
        into v_employee_count;
      if v_employee_count >= v_employee_limit then
        raise exception 'Balík % umožňuje najviac % zamestnancov. Pre viac zamestnancov prejdite na vyšší balík.', v_plan, v_employee_limit;
      end if;
    end if;
  end if;

  insert into public.company_invitations as existing_invitation(
    company_id, invited_by, email, full_name, role, is_employee, is_external, is_minor, expires_at, accepted_at
  )
    values (
      p_company_id, (select auth.uid()), v_email, trim(p_full_name), p_role,
      v_is_employee, coalesce(p_is_external, false), coalesce(p_is_minor, false), now() + interval '7 days', null
    )
    on conflict (company_id, email) where accepted_at is null do update
      set invited_by = excluded.invited_by,
          full_name = excluded.full_name,
          role = excluded.role,
          is_employee = excluded.is_employee,
          is_external = excluded.is_external,
          is_minor = excluded.is_minor,
          expires_at = excluded.expires_at,
          created_at = now()
    returning id into v_invitation_id;

  return jsonb_build_object('status', 'invited', 'invitation_id', v_invitation_id);
end;
$$;

create or replace function public.claim_company_invitation(p_invitation_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_invitation public.company_invitations%rowtype;
  v_user_id uuid := (select auth.uid());
  v_email text;
  v_email_confirmed_at timestamptz;
  v_member_id uuid;
  v_plan text;
  v_employee_limit integer;
  v_employee_count integer;
  v_existing_role text;
  v_existing_active boolean;
begin
  if v_user_id is null then
    raise exception 'Prihláste sa cez odkaz z pozývacieho e-mailu.';
  end if;

  select lower(u.email), u.email_confirmed_at
    into v_email, v_email_confirmed_at
    from auth.users u
    where u.id = v_user_id;
  if v_email is null or v_email_confirmed_at is null then
    raise exception 'Pred prijatím pozvania overte svoju e-mailovú adresu.';
  end if;

  select i.* into v_invitation
    from public.company_invitations i
    where i.id = p_invitation_id
    for update;
  if v_invitation.id is null
    or v_invitation.accepted_at is not null
    or v_invitation.expires_at <= now()
    or v_invitation.email <> v_email then
    raise exception 'Pozvanie je neplatné, vypršalo alebo bolo odoslané na inú e-mailovú adresu.';
  end if;

  select c.plan into v_plan
    from public.companies c
    where c.id = v_invitation.company_id
    for update;
  if v_plan is null then
    raise exception 'Firemný priestor sa nenašiel.';
  end if;

  select m.role, m.active
    into v_existing_role, v_existing_active
    from public.memberships m
    where m.company_id = v_invitation.company_id and m.user_id = v_user_id;
  if v_existing_active is true then
    raise exception 'Už ste aktívnym členom tejto firmy.';
  end if;
  if v_existing_role = 'OWNER'
    or (v_existing_active is false and v_invitation.role <> 'MANAGER' and v_existing_role = 'MANAGER') then
    raise exception 'Túto rolu z pozvania nemôžete prijať.';
  end if;

  if v_invitation.role = 'EMPLOYEE' or v_invitation.is_employee then
    v_employee_limit := public.plan_employee_limit(v_plan);
    if v_employee_limit is not null then
      select
        (select count(*)::integer
          from public.memberships m
          where m.company_id = v_invitation.company_id and m.active
            and (m.role = 'EMPLOYEE' or (m.role = 'ACCOUNTANT' and m.is_employee)))
        +
        (select count(*)::integer
          from public.company_invitations i
          where i.company_id = v_invitation.company_id
            and i.accepted_at is null
            and i.expires_at > now()
            and (i.role = 'EMPLOYEE' or i.is_employee)
            and i.id <> v_invitation.id)
        into v_employee_count;
      if v_employee_count >= v_employee_limit then
        raise exception 'Firma už dosiahla limit zamestnancov svojho balíka. Požiadajte vlastníka firmy o zmenu balíka.';
      end if;
    end if;
  end if;

  insert into public.memberships as existing_membership(
    company_id, user_id, email, full_name, role, is_employee, is_external, is_minor, active, deactivated_at
  )
    values (
      v_invitation.company_id, v_user_id, v_email, v_invitation.full_name, v_invitation.role,
      v_invitation.is_employee, v_invitation.is_external, v_invitation.is_minor, true, null
    )
    on conflict (company_id, user_id) do update
      set email = excluded.email,
          full_name = excluded.full_name,
          role = excluded.role,
          is_employee = excluded.is_employee,
          is_external = excluded.is_external,
          is_minor = excluded.is_minor,
          active = true,
          deactivated_at = null
      where existing_membership.active = false
    returning id into v_member_id;
  if v_member_id is null then
    raise exception 'Pozvanie sa nepodarilo prijať.';
  end if;

  update public.company_invitations
    set accepted_at = now()
    where id = v_invitation.id;
  return v_invitation.company_id;
end;
$$;

revoke all on function public.add_or_invite_company_member(uuid, text, text, text, boolean, boolean, boolean) from public, anon;
revoke all on function public.claim_company_invitation(uuid) from public, anon;
grant execute on function public.add_or_invite_company_member(uuid, text, text, text, boolean, boolean, boolean) to authenticated;
grant execute on function public.claim_company_invitation(uuid) to authenticated;

notify pgrst, 'reload schema';
