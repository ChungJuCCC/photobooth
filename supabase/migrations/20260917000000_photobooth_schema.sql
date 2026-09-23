-- Photobooth schema: frames, sessions, admin PIN, storage buckets.
--
-- Access model: nothing here is reachable with the publishable key. RLS is
-- enabled with no policies and anon/authenticated privileges are revoked.
-- Every read and write goes through Edge Functions using the secret key.

create extension if not exists pgcrypto with schema extensions;

-- ── frames ──────────────────────────────────────────────────────────────

create table public.frames (
  id          uuid primary key,
  name        text not null check (char_length(name) between 1 and 30),
  layout      text not null check (layout in ('vertical', 'grid')),
  path        text not null unique,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index frames_active_created_idx on public.frames (created_at desc) where is_active;

-- ── sessions ────────────────────────────────────────────────────────────
-- One row per photobooth shoot. The id is generated on the tablet so the QR
-- code can be shown before the upload finishes (or while offline).

create table public.sessions (
  id           uuid primary key,
  device_id    text not null check (device_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  frame_id     uuid references public.frames (id) on delete set null,
  photo_path   text not null,
  video_path   text,
  created_at   timestamptz not null default now(),
  uploaded_at  timestamptz,
  expires_at   timestamptz,
  deleted_at   timestamptz,
  constraint sessions_expiry_follows_upload check ((uploaded_at is null) = (expires_at is null))
);

create index sessions_frame_id_idx on public.sessions (frame_id);
create index sessions_device_created_idx on public.sessions (device_id, created_at desc);
-- The two halves of the hourly cleanup query.
create index sessions_purge_expired_idx on public.sessions (expires_at)
  where deleted_at is null and expires_at is not null;
create index sessions_purge_abandoned_idx on public.sessions (created_at)
  where deleted_at is null and uploaded_at is null;

-- ── admin PIN ───────────────────────────────────────────────────────────
-- Single row. Set the PIN once from the SQL editor:
--   select public.set_admin_pin('1234');

create table public.admin_settings (
  id               boolean primary key default true check (id),
  pin_hash         text,
  failed_attempts  integer not null default 0 check (failed_attempts >= 0),
  locked_until     timestamptz
);

insert into public.admin_settings (id) values (true);

-- ── lock everything down ────────────────────────────────────────────────

alter table public.frames enable row level security;
alter table public.sessions enable row level security;
alter table public.admin_settings enable row level security;

revoke all on table public.frames, public.sessions, public.admin_settings from anon, authenticated;

-- ── functions ───────────────────────────────────────────────────────────

create or replace function public.set_admin_pin(new_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new_pin !~ '^\d{4}$' then
    raise exception 'PIN must be exactly 4 digits';
  end if;

  update public.admin_settings
     set pin_hash = extensions.crypt(new_pin, extensions.gen_salt('bf', 10)),
         failed_attempts = 0,
         locked_until = null
   where id;
end;
$$;

-- Returns {"result": "ok" | "wrong" | "locked" | "unset", ...}.
-- 5 wrong attempts lock the PIN for 10 minutes. Mirrored in dev/memory-deps.ts.
create or replace function public.check_admin_pin(input_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings public.admin_settings%rowtype;
  attempts integer;
begin
  select * into settings from public.admin_settings where id for update;

  if settings.pin_hash is null then
    return jsonb_build_object('result', 'unset');
  end if;

  if settings.locked_until is not null and settings.locked_until > now() then
    return jsonb_build_object('result', 'locked', 'locked_until', settings.locked_until);
  end if;

  -- A lock that has run out starts a fresh count.
  attempts := case when settings.locked_until is not null then 0 else settings.failed_attempts end;

  if extensions.crypt(input_pin, settings.pin_hash) = settings.pin_hash then
    update public.admin_settings set failed_attempts = 0, locked_until = null where id;
    return jsonb_build_object('result', 'ok');
  end if;

  attempts := attempts + 1;

  if attempts >= 5 then
    update public.admin_settings
       set failed_attempts = attempts, locked_until = now() + interval '10 minutes'
     where id;
    return jsonb_build_object('result', 'locked', 'locked_until', now() + interval '10 minutes');
  end if;

  update public.admin_settings set failed_attempts = attempts, locked_until = null where id;
  return jsonb_build_object('result', 'wrong', 'remaining', 5 - attempts);
end;
$$;

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
     and expires_at is not null
     and expires_at <= now_at
  union all
  select *
    from public.sessions
   where deleted_at is null
     and uploaded_at is null
     and created_at < give_up_before
  limit max_rows;
$$;

-- Supabase grants EXECUTE on new public functions to anon/authenticated by
-- default, so revoking from PUBLIC alone is not enough.
revoke execute on function public.set_admin_pin(text) from public, anon, authenticated;
revoke execute on function public.check_admin_pin(text) from public, anon, authenticated;
revoke execute on function public.sessions_to_purge(timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.check_admin_pin(text) to service_role;
grant execute on function public.sessions_to_purge(timestamptz, timestamptz, integer) to service_role;

-- ── storage buckets ─────────────────────────────────────────────────────
-- sessions: private, reachable only through 10-minute signed URLs.
-- frames:   public read, frames are not personal data.
-- No storage.objects policies: uploads use signed upload URLs issued by
-- Edge Functions, so anon never writes directly.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('sessions', 'sessions', false, 20971520, array['image/jpeg', 'video/mp4', 'video/webm']),
  ('frames',   'frames',   true,  10485760, array['image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
