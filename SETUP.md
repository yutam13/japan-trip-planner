# Cloud setup — Supabase + Google sign-in

Follow these once. ~15 minutes. Everything here is free.
Until you finish steps 1–4, the app keeps working as **guest mode** (local only) — nothing breaks while you set up.

---

## 1. Create the Supabase project (5 min)

1. Go to **https://supabase.com** → **Start your project** → sign in with GitHub.
2. **New project**:
   - Name: `trip-planner` (anything)
   - Database password: generate a strong one and save it somewhere.
   - Region: closest to you.
   - Plan: **Free**.
3. Wait ~2 min for it to provision.

## 2. Run the database schema (2 min)

1. Left sidebar → **SQL Editor** → **New query**.
2. Open `supabase-schema.sql` from this repo, copy the **whole** file, paste it in.
3. Click **Run**. You should see "Success. No rows returned".
   - This creates 4 tables (`profiles`, `trips`, `trip_members`, `trip_invites`), all RLS policies, triggers, and the share RPCs.
4. Verify: **Table Editor** should now list those 4 tables. **Database → Replication** (or Realtime) should show `trips` enabled.

## 3. Get your API keys → put them in `config.js` (2 min)

1. **Project Settings** (gear) → **Data API** → copy the **Project URL** (e.g. `https://abcd.supabase.co`).
2. **Project Settings → API Keys** → copy the **anon / public** key (long string starting `eyJ...`).
   - ⚠️ Use the **anon** key, NOT `service_role`. Never commit service_role.
3. Open `config.js` in this repo and paste both:
   ```js
   SUPABASE_URL: "https://abcd.supabase.co",
   SUPABASE_ANON_KEY: "eyJ...your-anon-key...",
   ```
4. Commit + push. The cloud features now light up automatically.

## 4. Configure auth redirect URLs (2 min)

So sign-in links return to your live site:

1. Supabase → **Authentication → URL Configuration**.
2. **Site URL**: `https://yutam13.github.io/japan-trip-planner/`
3. **Redirect URLs** — add (one per line):
   ```
   https://yutam13.github.io/japan-trip-planner/
   https://yutam13.github.io/japan-trip-planner/index.html
   http://localhost:8765/index.html
   ```
   (the localhost line lets you test locally)
4. Save.

Email/password + magic-link sign-in now work. You can stop here if you only want email sign-in.

---

## 5. (Optional) Add "Sign in with Google" (5 min)

Needs a Google Cloud OAuth client. Free.

1. **https://console.cloud.google.com** → create a project (or pick one).
2. **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create.
   - App name, your email, save. Add yourself under **Test users** (so you can log in while it's unverified).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: `https://yutam13.github.io`
   - **Authorized redirect URIs**: paste the callback Supabase shows you in the next step
     (it looks like `https://<your-project>.supabase.co/auth/v1/callback`).
   - Create → copy the **Client ID** and **Client secret**.
4. Supabase → **Authentication → Providers → Google** → enable, paste **Client ID** + **Client secret** → Save.
   - This page shows the exact callback URL to paste back into Google step 3 if you didn't already.

Done — the **Continue with Google** button now works.

---

## Notes & limits (free tier)

- **Anon key is public by design.** It only allows what Row Level Security permits. Your data is safe.
- **Project sleeps after ~7 days of no activity.** Open the Supabase dashboard once to wake it (one click). Fine for personal use.
- **No service_role key in the browser, ever.** This repo never uses it.
- Email confirmations: Supabase's built-in mailer is rate-limited on free tier. For heavy use, set a custom SMTP under Authentication → Emails (optional).

## Troubleshooting

- **Sign-in opens then returns "redirect not allowed"** → the exact URL isn't in step 4's Redirect URLs.
- **Google button errors `redirect_uri_mismatch`** → the Supabase callback URL isn't in Google's Authorized redirect URIs (step 5.3).
- **"new row violates row-level security"** → schema didn't run fully; re-run `supabase-schema.sql`.
- **Cloud features don't appear at all** → `config.js` still has empty `SUPABASE_URL`/`SUPABASE_ANON_KEY`; the app intentionally stays in guest mode until both are set.
