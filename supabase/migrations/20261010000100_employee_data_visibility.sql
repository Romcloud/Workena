drop policy if exists "Members read their company roster" on public.memberships;
create policy "Members read own membership and managers read company roster"
  on public.memberships for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.can_manage_company(company_id))
  );

drop policy if exists "Members read company work entries" on public.work_entries;
create policy "Members read own work entries and managers read company entries"
  on public.work_entries for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.can_manage_company(company_id))
  );

drop policy if exists "Members read company photos" on public.photos;
create policy "Members read own photos and managers read company photos"
  on public.photos for select to authenticated
  using (
    exists (
      select 1
      from public.work_entries e
      where e.id = work_entry_id
        and e.company_id = photos.company_id
        and (
          e.user_id = (select auth.uid())
          or (select public.can_manage_company(e.company_id))
        )
    )
  );

drop policy if exists "Members view photos in their company" on storage.objects;
create policy "Members view own photos and managers view company photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'work-photos'
    and exists (
      select 1
      from public.work_entries e
      where e.company_id::text = (storage.foldername(name))[1]
        and e.id::text = (storage.foldername(name))[2]
        and (
          e.user_id = (select auth.uid())
          or (select public.can_manage_company(e.company_id))
        )
    )
  );
