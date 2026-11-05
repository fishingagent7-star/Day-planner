-- Settings → Backup → "Delete my account" calls this (storage.js: client.rpc('delete_my_account')).
-- Copy of what's in Supabase (checked 2026-11-06). Safe: it only ever deletes the signed-in
-- person's own rows and login (auth.uid()), and the empty search_path blocks lookalike tables.
-- Supabase's Security Advisor warns that signed-in users can run it; that's on purpose.

create or replace function public.delete_my_account()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  delete from public.planner_items where user_id = auth.uid();
  delete from auth.users where id = auth.uid();
end;
$function$;
