create extension if not exists pgcrypto;

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'EMPLOYEE' check (role in ('OWNER', 'MANAGER', 'EMPLOYEE')),
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);
create index memberships_user_id_idx on public.memberships(user_id);
create index memberships_company_id_idx on public.memberships(company_id);

create table public.work_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  worked_at timestamptz not null,
  hours numeric(5, 2) not null check (hours > 0 and hours <= 24),
  work_type text not null check (char_length(trim(work_type)) between 2 and 120),
  workplace text not null check (char_length(trim(workplace)) between 2 and 120),
  note text check (note is null or char_length(note) <= 2000),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  review_note text check (review_note is null or char_length(review_note) <= 2000),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);
create index work_entries_company_date_idx on public.work_entries(company_id, worked_at desc);
create index work_entries_company_user_date_idx on public.work_entries(company_id, user_id, worked_at desc);
create index work_entries_company_status_idx on public.work_entries(company_id, status);

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  work_entry_id uuid not null,
  storage_path text not null unique
    check (storage_path ~ ('^' || company_id::text || '/' || work_entry_id::text || '/[^/]+$')),
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 8388608),
  created_at timestamptz not null default now(),
  foreign key (work_entry_id, company_id)
    references public.work_entries(id, company_id) on delete cascade
);
create index photos_company_entry_idx on public.photos(company_id, work_entry_id);

create or replace function public.is_company_member(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id and m.user_id = (select auth.uid())
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
      and e.user_id = auth.uid()
      and e.status = 'REJECTED';
  if not found then
    raise exception 'Záznam neexistuje alebo ho nemôžete znova odoslať.';
  end if;
end;
$$;

create or replace function public.can_manage_company(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = (select auth.uid())
      and m.role in ('OWNER', 'MANAGER')
  );
$$;

create or replace function public.can_upload_work_entry(p_entry_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.work_entries e
    where e.id = p_entry_id
      and (
        public.can_manage_company(e.company_id)
        or (e.user_id = (select auth.uid()) and e.status in ('PENDING', 'REJECTED'))
      )
  );
$$;

create or replace function public.create_company(p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_email text;
  v_full_name text;
begin
  if v_user_id is null then
    raise exception 'Prihláste sa a skúste to znova.';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 2 and 120 then
    raise exception 'Názov firmy musí mať 2 až 120 znakov.';
  end if;

  select lower(u.email), nullif(trim(u.raw_user_meta_data ->> 'full_name'), '')
    into v_email, v_full_name
    from auth.users u where u.id = v_user_id;
  if v_email is null then
    raise exception 'Prihlásený účet nemá e-mailovú adresu.';
  end if;

  insert into public.companies(name, created_by)
    values (trim(p_name), v_user_id) returning id into v_company_id;
  insert into public.memberships(company_id, user_id, email, full_name, role)
    values (v_company_id, v_user_id, v_email, v_full_name, 'OWNER');
  return v_company_id;
end;
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
  v_email text := lower(trim(p_email));
begin
  select m.role into v_actor_role
    from public.memberships m
    where m.company_id = p_company_id and m.user_id = auth.uid();

  if v_actor_role is null or v_actor_role not in ('OWNER', 'MANAGER') then
    raise exception 'Na správu členov nemáte oprávnenie.';
  end if;
  if p_role not in ('MANAGER', 'EMPLOYEE')
    or (p_role = 'MANAGER' and v_actor_role <> 'OWNER') then
    raise exception 'Túto rolu nemôžete prideliť.';
  end if;
  if v_email = '' or char_length(v_email) > 320 then
    raise exception 'Zadajte platnú e-mailovú adresu.';
  end if;

  insert into public.memberships(company_id, user_id, email, full_name, role)
    select p_company_id, u.id, lower(u.email),
      nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), p_role
    from auth.users u where lower(u.email) = v_email
    returning id into v_member_id;
  if v_member_id is null then
    raise exception 'Používateľ sa ešte neprihlásil do aplikácie cez Google.';
  end if;
  return v_member_id;
exception
  when unique_violation then
    raise exception 'Tento používateľ už je členom firmy.';
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
      on actor.company_id = target.company_id and actor.user_id = auth.uid()
    where target.id = p_membership_id;

  if v_actor_role is null or v_target_role is null
    or v_target_role = 'OWNER'
    or (v_actor_role = 'MANAGER' and v_target_role <> 'EMPLOYEE')
    or v_actor_role not in ('OWNER', 'MANAGER') then
    raise exception 'Tohto člena nemôžete odstrániť.';
  end if;
  delete from public.memberships where id = p_membership_id and company_id = v_company_id;
end;
$$;

create or replace function public.review_work_entry(
  p_entry_id uuid,
  p_status text,
  p_review_note text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_status not in ('APPROVED', 'REJECTED') then
    raise exception 'Neplatný stav záznamu.';
  end if;
  update public.work_entries e
    set status = p_status,
        review_note = nullif(trim(p_review_note), ''),
        reviewed_at = now(),
        reviewed_by = auth.uid(),
        updated_at = now()
    where e.id = p_entry_id and public.can_manage_company(e.company_id);
  if not found then
    raise exception 'Záznam neexistuje alebo na jeho schválenie nemáte oprávnenie.';
  end if;
end;
$$;

create or replace function public.sync_membership_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.memberships
    set email = lower(new.email),
        full_name = nullif(trim(new.raw_user_meta_data ->> 'full_name'), '')
    where user_id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_profile_updated
  after update of email, raw_user_meta_data on auth.users
  for each row execute function public.sync_membership_profile();

alter table public.companies enable row level security;
alter table public.memberships enable row level security;
alter table public.work_entries enable row level security;
alter table public.photos enable row level security;

create policy "Members read their companies"
  on public.companies for select to authenticated
  using ((select public.is_company_member(id)));
create policy "Managers update their companies"
  on public.companies for update to authenticated
  using ((select public.can_manage_company(id)))
  with check ((select public.can_manage_company(id)));

create policy "Members read their company roster"
  on public.memberships for select to authenticated
  using ((select public.is_company_member(company_id)));

create policy "Members read company work entries"
  on public.work_entries for select to authenticated
  using ((select public.is_company_member(company_id)));
create policy "Members create their own pending entries"
  on public.work_entries for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'PENDING'
    and review_note is null and reviewed_at is null and reviewed_by is null
    and (select public.is_company_member(company_id))
  );
create policy "Authors edit pending entries and managers edit company entries"
  on public.work_entries for update to authenticated
  using (
    (user_id = (select auth.uid()) and status in ('PENDING', 'REJECTED'))
    or (select public.can_manage_company(company_id))
  )
  with check (
    (user_id = (select auth.uid()) and status in ('PENDING', 'REJECTED'))
    or (select public.can_manage_company(company_id))
  );
create policy "Authors delete editable entries and managers delete company entries"
  on public.work_entries for delete to authenticated
  using (
    (user_id = (select auth.uid()) and status = 'PENDING')
    or (select public.can_manage_company(company_id))
  );

create policy "Members read company photos"
  on public.photos for select to authenticated
  using ((select public.is_company_member(company_id)));
create policy "Authors and managers add photos"
  on public.photos for insert to authenticated
  with check ((select public.can_upload_work_entry(work_entry_id)));
create policy "Authors and managers remove photos"
  on public.photos for delete to authenticated
  using ((select public.can_upload_work_entry(work_entry_id)));

revoke all on public.companies, public.memberships, public.work_entries, public.photos from public, anon, authenticated;
grant select on public.companies, public.memberships, public.work_entries, public.photos to authenticated;
grant insert on public.work_entries, public.photos to authenticated;
grant update (name) on public.companies to authenticated;
grant update (worked_at, hours, work_type, workplace, note) on public.work_entries to authenticated;
grant delete on public.work_entries, public.photos to authenticated;

revoke all on function public.is_company_member(uuid) from public, anon;
revoke all on function public.can_manage_company(uuid) from public, anon;
revoke all on function public.can_upload_work_entry(uuid) from public, anon;
revoke all on function public.create_company(text) from public, anon;
revoke all on function public.add_company_member(uuid, text, text) from public, anon;
revoke all on function public.remove_company_member(uuid) from public, anon;
revoke all on function public.review_work_entry(uuid, text, text) from public, anon;
revoke all on function public.resubmit_work_entry(uuid) from public, anon;
revoke all on function public.sync_membership_profile() from public, anon, authenticated;

grant execute on function public.is_company_member(uuid) to authenticated;
grant execute on function public.can_manage_company(uuid) to authenticated;
grant execute on function public.can_upload_work_entry(uuid) to authenticated;
grant execute on function public.create_company(text) to authenticated;
grant execute on function public.add_company_member(uuid, text, text) to authenticated;
grant execute on function public.remove_company_member(uuid) to authenticated;
grant execute on function public.review_work_entry(uuid, text, text) to authenticated;
grant execute on function public.resubmit_work_entry(uuid) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'work-photos', 'work-photos', false, 8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Members view photos in their company"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'work-photos'
    and exists (
      select 1 from public.work_entries e
      where e.company_id::text = (storage.foldername(name))[1]
        and e.id::text = (storage.foldername(name))[2]
        and (select public.is_company_member(e.company_id))
    )
  );
create policy "Authors and managers upload company photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'work-photos'
    and exists (
      select 1 from public.work_entries e
      where e.company_id::text = (storage.foldername(name))[1]
        and e.id::text = (storage.foldername(name))[2]
        and (select public.can_upload_work_entry(e.id))
    )
  );
create policy "Authors and managers delete company photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'work-photos'
    and exists (
      select 1 from public.work_entries e
      where e.company_id::text = (storage.foldername(name))[1]
        and e.id::text = (storage.foldername(name))[2]
        and (select public.can_upload_work_entry(e.id))
    )
  );
