-- Error reports (anonymous). Paste this whole file into Supabase → SQL Editor → Run, once.
-- Signed-in app users can ADD a short error note but can't read anyone's (no select rule);
-- you read them in Table Editor → errors. Nothing here links an error to an account.

create table if not exists public.errors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  message text not null check (char_length(message) <= 500),
  source text check (char_length(source) <= 300),
  device text check (char_length(device) <= 300)
);

alter table public.errors enable row level security;

create policy "signed-in users can report errors"
  on public.errors for insert to authenticated
  with check (true);

grant insert on public.errors to authenticated;

-- Delete reports older than 30 days, every night at 3am UTC (uses the Cron extension already
-- turned on for reminders).
select cron.schedule(
  'delete-old-errors',
  '0 3 * * *',
  $$delete from public.errors where created_at < now() - interval '30 days'$$
);
