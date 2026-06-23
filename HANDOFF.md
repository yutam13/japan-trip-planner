# Deploy handoff — Japan Trip Planner fix

Two files fixed. Replace them in the `japan-trip-planner` repo, commit, push.
GitHub Pages rebuilds automatically.

## Files to update (only these two)
- `cloud.js`
- `index.html`

## What was broken
1. **Page froze on load.** A `MutationObserver` watching `#root` called
   `mountAccountButton()`, which mutated `#root` → re-fired the observer →
   infinite loop. Fixed: observer disconnects while mutating, reconnects after.
2. **Froze after sign-up / magic link.** Supabase calls were made *synchronously
   inside* the `onAuthStateChange` callback, which holds the SDK auth lock →
   deadlock. Fixed: all post-auth work deferred with `setTimeout(0)`
   (Supabase's documented requirement).
3. Defensive guards so malformed cloud trip data can't crash the renderers.

## After pushing — verify in Supabase Dashboard
Authentication → URL Configuration:
- **Site URL**: `https://yutam13.github.io/japan-trip-planner/`
- **Redirect URLs** must include:
  `https://yutam13.github.io/japan-trip-planner/index.html`

(Without these, magic-link / Google / password-reset emails won't return to the app.)

## Note
If "Confirm email" is ON in Supabase Auth settings, a new sign-up must click the
email link before a session starts — that's expected, not a bug.
