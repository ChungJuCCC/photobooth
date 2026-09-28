-- Two things the admin screen needs:
--
--   frames.has_people  the frame has someone posing inside its cuts, so the
--                      booth shows them in the viewfinder while shooting
--   sessions.keep      this shoot is kept past the usual expiry, chosen by
--                      hand in the admin screen
--
-- Everything else still expires on the hour as before.

alter table public.frames   add column if not exists has_people boolean not null default false;
alter table public.sessions add column if not exists keep       boolean not null default false;

-- A kept session has no expiry, which the old constraint forbade.
alter table public.sessions drop constraint if exists sessions_expiry_follows_upload;

create index if not exists sessions_keep_idx on public.sessions (keep) where keep;

-- Kept shoots are never purged; the give-up rule for uploads that never
-- finished is unchanged.
create or replace function public.sessions_to_purge(now_at timestamptz, give_up_before timestamptz, max_rows integer)
returns setof public.sessions
language sql
stable
security definer
set search_path = ''
as $$
  select *
    from public.sessions
   where deleted_at is null
     and not keep
     and expires_at is not null
     and expires_at <= now_at
  union all
  select *
    from public.sessions
   where deleted_at is null
     and not keep
     and uploaded_at is null
     and created_at < give_up_before
  limit max_rows;
$$;

revoke execute on function public.sessions_to_purge(timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.sessions_to_purge(timestamptz, timestamptz, integer) to service_role;
