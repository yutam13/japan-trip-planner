/* ---------------------------------------------------------------------
 *  Cloud configuration.
 *
 *  Paste your Supabase project values below, then commit + push.
 *  Until BOTH are filled in, the app runs in GUEST MODE (localStorage
 *  only) exactly as before — no cloud, no sign-in, nothing breaks.
 *
 *  The anon (public) key is SAFE to commit and ship in the browser —
 *  that is its designed purpose. All real protection is enforced by
 *  Row Level Security in the database. Never put the service_role key
 *  here.
 *
 *  Where to find these:  Supabase Dashboard → Project Settings →
 *  Data API  (Project URL)   and   API Keys (anon / public key).
 *  See SETUP.md for click-by-click steps.
 * ------------------------------------------------------------------- */
window.APP_CONFIG = {
  SUPABASE_URL: "https://lthtqbmobjijrrrluupm.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0aHRxYm1vYmppanJycmx1dXBtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMjgzNDcsImV4cCI6MjA5NzgwNDM0N30.rbIPqkJ2CGk6EpfMcV0ByjLXtXRiTeSquvFBMrg3fcE",

  // Where the deployed app lives — used for OAuth / magic-link / reset
  // redirects and for building share links. Trailing slash recommended.
  APP_URL: "https://yutam13.github.io/japan-trip-planner/"
};
