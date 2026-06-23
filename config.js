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
  SUPABASE_URL: "",      // e.g. "https://abcdefgh.supabase.co"
  SUPABASE_ANON_KEY: "", // e.g. "eyJhbGciOi....(long string)...."

  // Where the deployed app lives — used for OAuth / magic-link / reset
  // redirects and for building share links. Trailing slash recommended.
  APP_URL: "https://yutam13.github.io/japan-trip-planner/"
};
