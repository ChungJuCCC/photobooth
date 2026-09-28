-- People the guests pose with.
--
-- A person is a cut-out PNG that the booth composites into the photo itself at
-- the shutter, standing on the right. That makes them part of the picture
-- rather than part of the frame, so any frame can be used with them.

create table if not exists public.people (
  id          uuid primary key,
  name        text not null check (char_length(name) between 1 and 30),
  path        text not null unique,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.people enable row level security;
-- No policies: only the Edge Functions' service role touches this table.

create index if not exists people_active_idx on public.people (created_at desc) where is_active;
