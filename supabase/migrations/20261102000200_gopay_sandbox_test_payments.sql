create table public.gopay_test_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('BASIC', 'PRO', 'TEAM')),
  amount_eur numeric(8, 2) not null check (
    (plan = 'BASIC' and amount_eur = 19.00)
    or (plan = 'PRO' and amount_eur = 39.00)
    or (plan = 'TEAM' and amount_eur = 69.00)
  ),
  order_number text not null unique,
  gopay_payment_id text unique,
  status text not null default 'CREATING',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gopay_test_payments enable row level security;
revoke all on public.gopay_test_payments from public, anon, authenticated;
grant all on public.gopay_test_payments to service_role;
