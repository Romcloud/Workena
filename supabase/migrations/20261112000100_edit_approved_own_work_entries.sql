create or replace function public.update_approved_own_work_entry(
  p_entry_id uuid,
  p_worked_at timestamptz,
  p_hours numeric,
  p_work_type text,
  p_workplace text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_user_id uuid;
  v_status text;
begin
  if p_worked_at is null
    or p_hours is null or p_hours <= 0 or p_hours > 24
    or p_work_type is null or char_length(trim(p_work_type)) not between 2 and 120
    or p_workplace is null or char_length(trim(p_workplace)) not between 2 and 120
    or char_length(coalesce(p_note, '')) > 2000 then
    raise exception 'Skontrolujte dátum, hodiny, druh práce, miesto a poznámku.';
  end if;

  select e.company_id, e.user_id, e.status
  into v_company_id, v_user_id, v_status
  from public.work_entries e
  where e.id = p_entry_id
  for update;

  if v_company_id is null then
    raise exception 'Pracovný záznam sa nenašiel.';
  end if;
  if v_user_id <> (select auth.uid())
    or not (select public.is_company_member(v_company_id)) then
    raise exception 'Tento pracovný záznam nemôžete upraviť.';
  end if;
  if v_status <> 'APPROVED' then
    raise exception 'Záznam už nie je schválený. Obnovte prehľad a skúste úpravu znova.';
  end if;

  update public.work_entries
  set worked_at = p_worked_at,
      hours = p_hours,
      work_type = trim(p_work_type),
      workplace = trim(p_workplace),
      note = nullif(trim(coalesce(p_note, '')), ''),
      status = 'PENDING',
      review_note = null,
      reviewed_at = null,
      reviewed_by = null,
      updated_at = now()
  where id = p_entry_id;
end;
$$;

revoke all on function public.update_approved_own_work_entry(uuid, timestamptz, numeric, text, text, text) from public, anon;
grant execute on function public.update_approved_own_work_entry(uuid, timestamptz, numeric, text, text, text) to authenticated;

notify pgrst, 'reload schema';
