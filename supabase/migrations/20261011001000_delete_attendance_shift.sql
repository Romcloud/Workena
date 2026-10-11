-- Allow deleting a manually reported attendance shift (own shift, or any shift for managers),
-- mirroring the permission checks already used by update_attendance_shift.

create or replace function public.delete_attendance_shift(p_shift_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company_id uuid;
  v_user_id uuid;
  v_source_work_entry_id uuid;
begin
  select s.company_id, s.user_id, s.source_work_entry_id
  into v_company_id, v_user_id, v_source_work_entry_id
  from public.attendance_shifts s
  where s.id = p_shift_id
  for update;
  if v_company_id is null then
    raise exception 'Dochádzkový záznam neexistuje.';
  end if;
  if not (select public.is_company_member(v_company_id))
    or (v_user_id <> (select auth.uid()) and not (select public.can_manage_company(v_company_id))) then
    raise exception 'Tento dochádzkový záznam nemôžete vymazať.';
  end if;
  if v_source_work_entry_id is not null then
    raise exception 'Dochádzka vytvorená z pracovného záznamu sa vymazáva cez pôvodný pracovný záznam.';
  end if;

  delete from public.attendance_shifts where id = p_shift_id;
end;
$$;

revoke all on function public.delete_attendance_shift(uuid) from public, anon;
grant execute on function public.delete_attendance_shift(uuid) to authenticated;

notify pgrst, 'reload schema';
