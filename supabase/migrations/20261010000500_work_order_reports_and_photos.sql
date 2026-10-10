alter table public.work_orders
  add column employee_materials text check (
    employee_materials is null or char_length(employee_materials) <= 4000
  ),
  add column work_report text check (
    work_report is null or char_length(work_report) <= 4000
  ),
  add column report_submitted_at timestamptz;

create table public.work_order_photos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  phase text not null check (phase in ('BEFORE', 'AFTER')),
  storage_path text not null unique check (
    storage_path ~ (
      '^' || company_id::text || '/' || work_order_id::text || '/(before|after)/[^/]+$'
    )
  ),
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 8388608),
  created_at timestamptz not null default now()
);

create index work_order_photos_order_phase_idx
  on public.work_order_photos(work_order_id, phase, created_at);

alter table public.work_order_photos enable row level security;

create policy "Managers and assigned employees read work order photos"
  on public.work_order_photos for select to authenticated
  using (
    (select public.can_manage_company(company_id))
    or exists (
      select 1 from public.work_orders w
      where w.id = work_order_id
        and w.company_id = work_order_photos.company_id
        and w.assignee_id = (select auth.uid())
        and (select public.is_company_member(w.company_id))
    )
  );

revoke all on public.work_order_photos from anon, authenticated;
grant select on public.work_order_photos to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'work-order-photos', 'work-order-photos', false, 8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Managers and assigned employees view work order photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'work-order-photos'
    and exists (
      select 1
      from public.work_orders w
      where w.company_id::text = (storage.foldername(name))[1]
        and w.id::text = (storage.foldername(name))[2]
        and (
          (select public.can_manage_company(w.company_id))
          or (
            w.assignee_id = (select auth.uid())
            and (select public.is_company_member(w.company_id))
          )
        )
    )
  );

create policy "Assigned employees upload work order photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'work-order-photos'
    and (storage.foldername(name))[3] in ('before', 'after')
    and exists (
      select 1
      from public.work_orders w
      where w.company_id::text = (storage.foldername(name))[1]
        and w.id::text = (storage.foldername(name))[2]
        and w.assignee_id = (select auth.uid())
        and (select public.is_company_member(w.company_id))
    )
  );

create policy "Managers and assigned employees remove work order photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'work-order-photos'
    and exists (
      select 1
      from public.work_orders w
      where w.company_id::text = (storage.foldername(name))[1]
        and w.id::text = (storage.foldername(name))[2]
        and (
          (select public.can_manage_company(w.company_id))
          or (
            w.assignee_id = (select auth.uid())
            and (select public.is_company_member(w.company_id))
          )
        )
    )
  );

create or replace function public.add_work_order_photo(
  p_work_order_id uuid,
  p_phase text,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes integer
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_photo_id uuid;
  v_phase_folder text;
  v_photo_count integer;
begin
  if p_phase is null or p_phase not in ('BEFORE', 'AFTER')
    or p_file_name is null or char_length(p_file_name) not between 1 and 255
    or p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
    or p_size_bytes is null or p_size_bytes not between 1 and 8388608 then
    raise exception 'Fotografia má neplatný typ, názov alebo veľkosť.';
  end if;

  select w.company_id into v_company_id
    from public.work_orders w
    where w.id = p_work_order_id
      and w.assignee_id = (select auth.uid())
      and (select public.is_company_member(w.company_id))
    for update;
  if v_company_id is null then
    raise exception 'Zákazka neexistuje alebo k nej nemáte prístup.';
  end if;

  v_phase_folder := case p_phase when 'BEFORE' then 'before' else 'after' end;
  if p_storage_path !~ (
    '^' || v_company_id::text || '/' || p_work_order_id::text || '/' || v_phase_folder || '/[^/]+$'
  ) then
    raise exception 'Cesta fotografie nezodpovedá zákazke.';
  end if;

  select count(*)::integer into v_photo_count
    from public.work_order_photos p
    where p.work_order_id = p_work_order_id and p.phase = p_phase;
  if v_photo_count >= 10 then
    raise exception 'Ku každej fáze zákazky môžete pridať najviac 10 fotografií.';
  end if;

  insert into public.work_order_photos(
    company_id, work_order_id, phase, storage_path, file_name, mime_type, size_bytes
  )
  values (
    v_company_id, p_work_order_id, p_phase, p_storage_path, p_file_name, p_mime_type, p_size_bytes
  )
  returning id into v_photo_id;
  return v_photo_id;
end;
$$;

create or replace function public.submit_work_order_report(
  p_work_order_id uuid,
  p_status text,
  p_employee_note text,
  p_employee_materials text,
  p_work_report text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_status text;
begin
  if p_status is null or p_status not in ('IN_PROGRESS', 'DONE')
    or p_employee_note is not null and char_length(p_employee_note) > 2000
    or p_employee_materials is not null and char_length(p_employee_materials) > 4000
    or p_work_report is not null and char_length(p_work_report) > 4000 then
    raise exception 'Skontrolujte stav zákazky a obsah výkazu.';
  end if;
  if p_status = 'DONE' and char_length(trim(coalesce(p_work_report, ''))) < 2 then
    raise exception 'Pred označením zákazky ako hotovej vyplňte výkaz práce.';
  end if;

  select w.status into v_status
    from public.work_orders w
    where w.id = p_work_order_id
      and w.assignee_id = (select auth.uid())
      and (select public.is_company_member(w.company_id))
    for update;
  if v_status is null then
    raise exception 'Zákazka neexistuje alebo ju nemôžete upraviť.';
  end if;
  if v_status = 'DONE' and p_status <> 'DONE' then
    raise exception 'Dokončenú zákazku už nemožno vrátiť do rozpracovaného stavu.';
  end if;

  update public.work_orders
    set status = p_status,
        employee_note = nullif(trim(p_employee_note), ''),
        employee_materials = nullif(trim(p_employee_materials), ''),
        work_report = nullif(trim(p_work_report), ''),
        report_submitted_at = case when p_status = 'DONE' then now() else report_submitted_at end,
        updated_at = now()
    where id = p_work_order_id;
end;
$$;

revoke all on function public.update_assigned_work_order(uuid, text, text) from public, anon, authenticated;
revoke all on function public.add_work_order_photo(uuid, text, text, text, text, integer) from public, anon;
revoke all on function public.submit_work_order_report(uuid, text, text, text, text) from public, anon;
grant execute on function public.add_work_order_photo(uuid, text, text, text, text, integer) to authenticated;
grant execute on function public.submit_work_order_report(uuid, text, text, text, text) to authenticated;
