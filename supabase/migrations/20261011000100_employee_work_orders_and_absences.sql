-- Allow employees to create their own calendar work orders (self-assigned, auto-accepted)
-- and introduce absence requests (vacation / home office / out of office / other) with
-- manager approval.

create or replace function public.create_work_order_multi(
  p_company_id uuid,
  p_assignee_ids uuid[],
  p_title text,
  p_address text,
  p_due_date date,
  p_description text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_work_order_id uuid;
  v_primary_assignee uuid;
  v_actor_role text;
begin
  select m.role into v_actor_role
  from public.memberships m
  where m.company_id = p_company_id
    and m.user_id = (select auth.uid())
    and m.active;
  if v_actor_role is null then
    raise exception 'Nemáte aktívne členstvo v tejto firme.';
  end if;
  if v_actor_role = 'EMPLOYEE' then
    if p_assignee_ids is null or cardinality(p_assignee_ids) <> 1
      or p_assignee_ids[1] <> (select auth.uid()) then
      raise exception 'Zamestnanec môže zákazku v kalendári vytvoriť iba sám pre seba.';
    end if;
  elsif v_actor_role not in ('OWNER', 'MANAGER') then
    raise exception 'Zákazky môže priraďovať iba vlastník alebo vedúci firmy.';
  end if;
  if p_assignee_ids is null or cardinality(p_assignee_ids) not between 1 and 50
    or exists (
      select 1
      from unnest(p_assignee_ids) as selected(user_id)
      left join public.memberships m
        on m.company_id = p_company_id
        and m.user_id = selected.user_id
        and m.role = 'EMPLOYEE'
        and m.active
      where m.user_id is null
    )
    or cardinality(p_assignee_ids) <> (
      select count(distinct selected.user_id)
      from unnest(p_assignee_ids) as selected(user_id)
    ) then
    raise exception 'Vyberte aspoň jedného aktívneho zamestnanca firmy bez duplicít.';
  end if;
  if p_title is null or char_length(trim(p_title)) not between 2 and 140
    or p_address is null or char_length(trim(p_address)) not between 2 and 250
    or p_due_date is null
    or p_description is null or char_length(trim(p_description)) not between 2 and 4000 then
    raise exception 'Skontrolujte názov zákazky, adresu, termín a opis práce.';
  end if;

  v_primary_assignee := p_assignee_ids[1];
  insert into public.work_orders(company_id, assignee_id, created_by, title, address, due_date, description)
  values (p_company_id, v_primary_assignee, (select auth.uid()), trim(p_title), trim(p_address), p_due_date, trim(p_description))
  returning id into v_work_order_id;

  insert into public.work_order_assignees(work_order_id, company_id, user_id, accepted_at)
  select v_work_order_id, p_company_id, selected.user_id,
    case when v_actor_role = 'EMPLOYEE' then now() else null end
  from unnest(p_assignee_ids) as selected(user_id);
  return v_work_order_id;
end;
$$;

create table public.absence_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('VACATION', 'HOME_OFFICE', 'OUT_OF_OFFICE', 'OTHER')),
  start_date date not null,
  end_date date not null,
  note text check (note is null or char_length(note) <= 1000),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  review_note text check (review_note is null or char_length(review_note) <= 1000),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint absence_requests_date_range check (end_date >= start_date)
);

create index absence_requests_company_date_idx
  on public.absence_requests(company_id, start_date);
create index absence_requests_user_date_idx
  on public.absence_requests(user_id, start_date);

alter table public.absence_requests enable row level security;

create policy "Members read own absences and managers read company absences"
  on public.absence_requests for select to authenticated
  using (
    (user_id = (select auth.uid()) and (select public.is_company_member(company_id)))
    or (select public.can_manage_company(company_id))
  );

revoke all on public.absence_requests from anon, authenticated;
grant select on public.absence_requests to authenticated;

create or replace function public.create_absence_request(
  p_company_id uuid,
  p_type text,
  p_start_date date,
  p_end_date date,
  p_note text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_absence_id uuid;
begin
  if not (select public.is_company_member(p_company_id)) then
    raise exception 'Nemáte aktívny prístup do tohto firemného priestoru.';
  end if;
  if p_type is null or p_type not in ('VACATION', 'HOME_OFFICE', 'OUT_OF_OFFICE', 'OTHER') then
    raise exception 'Vyberte platný typ neprítomnosti.';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Skontrolujte dátum od a do.';
  end if;
  if p_type = 'OTHER' and (p_note is null or char_length(trim(p_note)) < 2) then
    raise exception 'Pri type "Iné" vyplňte krátku poznámku.';
  end if;
  if p_note is not null and char_length(p_note) > 1000 then
    raise exception 'Poznámka môže mať najviac 1000 znakov.';
  end if;

  insert into public.absence_requests(company_id, user_id, type, start_date, end_date, note)
  values (p_company_id, (select auth.uid()), p_type, p_start_date, p_end_date, nullif(trim(p_note), ''))
  returning id into v_absence_id;
  return v_absence_id;
end;
$$;

create or replace function public.cancel_absence_request(p_absence_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.absence_requests
  set status = 'CANCELLED', updated_at = now()
  where id = p_absence_id
    and user_id = (select auth.uid())
    and status = 'PENDING';
  if not found then
    raise exception 'Žiadosť sa nenašla alebo ju už nemožno zrušiť.';
  end if;
end;
$$;

create or replace function public.review_absence_request(
  p_absence_id uuid,
  p_status text,
  p_review_note text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  if p_status not in ('APPROVED', 'REJECTED') then
    raise exception 'Neplatný stav schválenia.';
  end if;
  if p_review_note is not null and char_length(p_review_note) > 1000 then
    raise exception 'Poznámka k rozhodnutiu môže mať najviac 1000 znakov.';
  end if;

  select company_id into v_company_id
  from public.absence_requests
  where id = p_absence_id
  for update;
  if v_company_id is null then
    raise exception 'Žiadosť sa nenašla.';
  end if;
  if not (select public.can_manage_company(v_company_id)) then
    raise exception 'Neprítomnosť môže schváliť iba vlastník alebo vedúci firmy.';
  end if;

  update public.absence_requests
  set status = p_status,
      review_note = nullif(trim(p_review_note), ''),
      reviewed_by = (select auth.uid()),
      reviewed_at = now(),
      updated_at = now()
  where id = p_absence_id
    and status = 'PENDING';
  if not found then
    raise exception 'Žiadosť už bola vybavená.';
  end if;
end;
$$;

revoke all on function public.create_absence_request(uuid, text, date, date, text) from public, anon;
revoke all on function public.cancel_absence_request(uuid) from public, anon;
revoke all on function public.review_absence_request(uuid, text, text) from public, anon;
grant execute on function public.create_absence_request(uuid, text, date, date, text) to authenticated;
grant execute on function public.cancel_absence_request(uuid) to authenticated;
grant execute on function public.review_absence_request(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
