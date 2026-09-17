// Fill in after creating the Supabase project and Vercel site (docs/SETUP.md),
// then rebuild the APK.
//
// boothKey is shared by every tablet. It's inside the APK, so treat it as a
// speed bump, not a password: the server also rate-limits each tablet and
// the admin PIN is checked server-side.
window.BOOTH_CONFIG = {
  functionsUrl: "https://YOUR-PROJECT-REF.supabase.co/functions/v1",
  publishableKey: "sb_publishable_REPLACE_ME",
  boothKey: "REPLACE_WITH_BOOTH_KEY",
  guestPageUrl: "https://YOUR-SITE.vercel.app/s",
  eventName: "",
};
