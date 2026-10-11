-- Allow platform admins to permanently delete a registered company and all
-- of its data (memberships, work orders, attendance, payments, ...). Every
-- company_id foreign key already cascades, so deleting the company row is
-- enough to clean everything up.

create or replace function public.admin_delete_company(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Prístup odmietnutý.';
  end if;

  delete from public.companies where id = p_company_id;

  if not found then
    raise exception 'Firma sa nenašla.';
  end if;
end;
$$;

revoke all on function public.admin_delete_company(uuid) from public, anon;
grant execute on function public.admin_delete_company(uuid) to authenticated;

notify pgrst, 'reload schema';
