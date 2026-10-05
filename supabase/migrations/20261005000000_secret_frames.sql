-- A frame only the booth's own operator can shoot with.
--
-- frames.secret keeps the frame off the guests' screen while leaving it in the
-- tablet's library, so the operator can start a shoot with it from the desk.
-- Hiding (is_active) is still the way to take a frame out of circulation
-- altogether; this is for the ones meant to be a surprise.
alter table public.frames add column if not exists secret boolean not null default false;
