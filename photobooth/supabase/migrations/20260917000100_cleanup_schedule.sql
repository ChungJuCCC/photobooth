-- Hourly cleanup: pg_cron calls the `cleanup` Edge Function.
--
-- Needs two Vault secrets, created once by hand in the SQL editor (never put
-- the real values in a migration file):
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<same value as the CLEANUP_TOKEN function secret>', 'cleanup_token');
--
-- Until they exist the job runs but the HTTP call fails harmlessly.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'photobooth-cleanup-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/cleanup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cleanup-token', (select decrypted_secret from vault.decrypted_secrets where name = 'cleanup_token')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
