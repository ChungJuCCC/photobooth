-- What the booth's first screen calls the cast, e.g. "기훈간사님".
-- It names the button guests press to shoot with them.

alter table public.admin_settings
  add column if not exists people_label text not null default '친구'
  check (char_length(people_label) between 1 and 20);
