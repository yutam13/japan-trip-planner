/* =====================================================================
 *  cloud.js — Supabase cloud layer for the Trip Planner
 *
 *  Adds (only when config.js has real keys):
 *    • Accounts: email/password, magic link, Google, reset, sign out, profile
 *    • Cloud trips: list / create / open / delete / duplicate
 *    • Sync: debounced JSONB save + realtime + edit-guard (last-write-wins)
 *    • Migration: import existing localStorage trip into the cloud
 *    • Sharing: members + invite-by-email + share-link, roles, viewer read-only
 *
 *  Design rules:
 *    • If config is blank → this file is a NO-OP. Guest mode = exactly today.
 *    • All UI lives OUTSIDE #root (appended to <body>) so the app's
 *      render() innerHTML reset never wipes it. An account button is
 *      (re)mounted into the topbar via a MutationObserver.
 *    • Talks to the app only through window.TripApp (bridge in index.html).
 * ===================================================================== */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var HAS_CONFIG = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

  // Guest mode: do nothing.
  if (!HAS_CONFIG) {
    window.TripCloud = { enabled: false, onLocalChange: function () {} };
    return;
  }
  if (!window.supabase || !window.supabase.createClient) {
    console.warn("[cloud] Supabase SDK not loaded; staying in guest mode.");
    window.TripCloud = { enabled: false, onLocalChange: function () {} };
    return;
  }

  // storageKey scopes auth tokens to this project so other Supabase projects
  // sharing the same browser profile don't interfere.
  var STORAGE_KEY_AUTH = "trip-planner-auth";
  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: STORAGE_KEY_AUTH,
      flowType: "pkce"
    }
  });

  var APP_URL = CFG.APP_URL || (location.origin + location.pathname);
  var REDIRECT = APP_URL.replace(/\/?$/, "/") + "index.html";

  // ---- internal state ----
  var S = {
    user: null,
    profile: null,
    trips: [],          // [{id,title,updated_at,owner_id,role}]
    currentTripId: localStorage.getItem("cloud-active-trip") || null,
    currentRole: null,
    channel: null,
    saveTimer: null,
    pendingRemoteRow: null,   // buffered remote row to apply once editing stops
    knownUpdatedAt: null,     // updated_at of the content currently in the app (version guard)
    modal: null,        // which modal is open: 'auth'|'trips'|'share'|'recover'|null
    loggingIn: false    // guard: prevent duplicate afterLogin() calls
  };

  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function uid() { return S.user && S.user.id; }
  function canEdit() { return S.currentRole === "owner" || S.currentRole === "editor"; }
  function toast(msg) {
    var el = document.createElement("div");
    el.className = "cloud-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add("show"); }, 10);
    setTimeout(function () { el.classList.remove("show"); setTimeout(function () { el.remove(); }, 300); }, 2600);
  }

  /* =====================================================================
   *  Styles (cloud UI only) + containers
   * ===================================================================== */
  function injectStyles() {
    var css = ''
      + '.cloud-acct{display:inline-flex;align-items:center;gap:7px;padding:6px 10px 6px 6px;border-radius:999px;'
      + 'background:var(--bg-card,#fff);border:1px solid var(--border,#e7e9ef);font-size:13px;font-weight:700;'
      + 'color:var(--text,#0b1220);cursor:pointer;transition:background .15s,transform .1s;margin-right:6px;}'
      + '.cloud-acct:hover{background:#f3f5f9;} .cloud-acct:active{transform:scale(.97);}'
      + '.cloud-acct .av{width:26px;height:26px;border-radius:50%;object-fit:cover;background:linear-gradient(135deg,#0d9488,#14b8a6);'
      + 'display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:13px;}'
      + '.cloud-acct .lbl{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
      + '.cloud-scrim{position:fixed;inset:0;z-index:1100;background:rgba(11,18,32,.46);display:flex;'
      + 'align-items:flex-end;justify-content:center;animation:cl-fade .2s ease both;}'
      + '@keyframes cl-fade{from{opacity:0}to{opacity:1}}'
      + '.cloud-sheet{background:var(--bg-card,#fff);width:100%;max-width:520px;border-radius:22px 22px 0 0;'
      + 'box-shadow:0 -20px 60px -8px rgba(0,0,0,.4);padding:14px 20px calc(26px + env(safe-area-inset-bottom));'
      + 'max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch;animation:cl-up .3s cubic-bezier(.32,.72,.34,1) both;}'
      + '@keyframes cl-up{from{transform:translateY(40px);opacity:.6}to{transform:translateY(0);opacity:1}}'
      + '@media(min-width:720px){.cloud-scrim{align-items:center;padding:24px}.cloud-sheet{border-radius:22px;max-height:80vh}}'
      + '.cloud-handle{width:38px;height:5px;border-radius:999px;background:#d6dae3;margin:4px auto 12px;}'
      + '.cloud-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}'
      + '.cloud-hd h3{margin:0;font-size:18px;font-weight:800;letter-spacing:-.01em;}'
      + '.cloud-x{width:32px;height:32px;border-radius:10px;background:#eef1f6;border:0;font-size:16px;cursor:pointer;color:#5b6477;}'
      + '.cloud-field{display:grid;gap:4px;margin-bottom:9px;}'
      + '.cloud-field label{font-size:11px;font-weight:700;color:#8a93a6;letter-spacing:.07em;text-transform:uppercase;}'
      + '.cloud-input{width:100%;padding:11px 13px;border:1px solid var(--border,#e7e9ef);border-radius:11px;font-size:16px;background:#fff;}'
      + '.cloud-input:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,.18);}'
      + '.cloud-btn{width:100%;padding:12px 16px;border:0;border-radius:999px;font-size:15px;font-weight:800;cursor:pointer;'
      + 'background:linear-gradient(135deg,#0d9488,#14b8a6);color:#fff;box-shadow:0 8px 18px -8px rgba(13,148,136,.6);transition:filter .15s,transform .1s;}'
      + '.cloud-btn:hover{filter:brightness(1.06)} .cloud-btn:active{transform:scale(.98)}'
      + '.cloud-btn.ghost{background:#eef1f6;color:#0b1220;box-shadow:none;}'
      + '.cloud-btn.google{background:#fff;color:#1f2937;border:1px solid #dadce0;box-shadow:none;display:flex;align-items:center;justify-content:center;gap:9px;}'
      + '.cloud-btn.danger{background:#fee2e2;color:#991b1b;box-shadow:none;}'
      + '.cloud-row{display:flex;gap:8px;} .cloud-row .cloud-btn{width:auto;flex:1;}'
      + '.cloud-tabs{display:flex;gap:6px;background:#eef1f6;border-radius:999px;padding:4px;margin-bottom:14px;}'
      + '.cloud-tab{flex:1;text-align:center;padding:8px;border-radius:999px;font-size:13px;font-weight:700;color:#5b6477;cursor:pointer;border:0;background:transparent;}'
      + '.cloud-tab.on{background:#fff;color:#0b1220;box-shadow:0 1px 3px rgba(0,0,0,.08);}'
      + '.cloud-muted{font-size:12.5px;color:#8a93a6;text-align:center;margin:10px 0 0;}'
      + '.cloud-link{color:#0d9488;font-weight:700;cursor:pointer;background:none;border:0;font-size:inherit;padding:0;}'
      + '.trip-card{display:flex;align-items:center;gap:12px;padding:13px 14px;border:1px solid var(--border,#e7e9ef);border-radius:16px;margin-bottom:9px;cursor:pointer;transition:background .15s,box-shadow .15s,transform .1s;background:#fff;}'
      + '.trip-card:hover{background:#f7f9fc;box-shadow:0 6px 16px -8px rgba(0,0,0,.18);} .trip-card:active{transform:scale(.99);}'
      + '.trip-card.cur{border-color:#0d9488;background:#effaf6;}'
      + '.trip-card .tc-emoji{font-size:26px;} .trip-card .tc-main{flex:1;min-width:0;}'
      + '.trip-card .tc-title{font-weight:800;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
      + '.trip-card .tc-sub{font-size:12px;color:#8a93a6;}'
      + '.tc-badge{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border-radius:999px;background:#eef1f6;color:#5b6477;}'
      + '.tc-badge.owner{background:#dcfce7;color:#166534;} .tc-badge.editor{background:#dbeafe;color:#1e40af;} .tc-badge.viewer{background:#f3e8ff;color:#6b21a8;}'
      + '.member-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #f1f3f7;}'
      + '.member-row .mr-main{flex:1;min-width:0;} .member-row .mr-name{font-weight:700;font-size:14px;} .member-row .mr-email{font-size:12px;color:#8a93a6;}'
      + '.cloud-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);z-index:1300;'
      + 'background:#0b1220;color:#fff;font-size:13.5px;font-weight:600;padding:11px 18px;border-radius:999px;opacity:0;'
      + 'transition:opacity .3s,transform .3s;box-shadow:0 10px 30px -8px rgba(0,0,0,.5);max-width:90vw;text-align:center;}'
      + '.cloud-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}'
      + '.cloud-divider{display:flex;align-items:center;gap:10px;color:#b4bccb;font-size:12px;margin:14px 0;}'
      + '.cloud-divider::before,.cloud-divider::after{content:"";flex:1;height:1px;background:#e7e9ef;}'
      + '.cloud-banner{margin:10px 16px 0;padding:12px 14px;border-radius:14px;background:#effaf6;border:1px solid #99f6e4;'
      + 'display:flex;align-items:center;gap:10px;font-size:13.5px;color:#0f766e;}'
      + '.cloud-banner .cloud-btn{width:auto;padding:8px 14px;font-size:13px;}'
      + '@media(min-width:720px){.cloud-toast{bottom:32px}}';
    var st = document.createElement("style");
    st.id = "cloud-styles";
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* =====================================================================
   *  Account button (mounted into topbar, kept alive across re-renders)
   * ===================================================================== */
  function accountButtonHtml() {
    if (S.user) {
      var name = (S.profile && S.profile.display_name) || (S.user.email || "Account").split("@")[0];
      var av = S.profile && S.profile.avatar_url;
      var avHtml = av ? '<img class="av" src="' + esc(av) + '" alt="">' : '<span class="av">' + esc(name.slice(0, 1).toUpperCase()) + '</span>';
      return avHtml + '<span class="lbl">' + esc(name) + '</span>';
    }
    return '<span class="av">☁</span><span class="lbl">Sign in</span>';
  }
  var _topbarObserver = null;
  function mountAccountButton() {
    var right = document.querySelector(".topbar-right");
    if (!right) return;
    // Pause observation while WE mutate the topbar, otherwise insertBefore /
    // innerHTML below retrigger the observer that called us → infinite loop / freeze.
    if (_topbarObserver) _topbarObserver.disconnect();
    try {
      var btn = document.getElementById("cloud-acct-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.id = "cloud-acct-btn";
        btn.className = "cloud-acct";
        btn.addEventListener("click", function () {
          if (S.user) openTripsModal(); else openAuthModal();
        });
        right.insertBefore(btn, right.firstChild);
      } else if (btn.parentNode !== right) {
        right.insertBefore(btn, right.firstChild);
      }
      var html = accountButtonHtml();
      if (btn.innerHTML !== html) btn.innerHTML = html;
    } finally {
      if (_topbarObserver) {
        var root = document.getElementById("root");
        if (root) _topbarObserver.observe(root, { childList: true, subtree: true });
      }
    }
  }
  function watchTopbar() {
    var root = document.getElementById("root");
    if (!root) return;
    _topbarObserver = new MutationObserver(function () { mountAccountButton(); });
    _topbarObserver.observe(root, { childList: true, subtree: true });
    mountAccountButton();
  }

  /* =====================================================================
   *  Modal plumbing
   * ===================================================================== */
  function closeModal() {
    S.modal = null;
    var sc = document.getElementById("cloud-scrim");
    if (sc) sc.remove();
  }
  function showModal(innerHtml) {
    closeModal();
    var sc = document.createElement("div");
    sc.id = "cloud-scrim";
    sc.className = "cloud-scrim";
    sc.innerHTML = '<div class="cloud-sheet" id="cloud-sheet">' + innerHtml + '</div>';
    sc.addEventListener("click", function (e) { if (e.target === sc) closeModal(); });
    document.body.appendChild(sc);
  }
  function setSheet(innerHtml) {
    var sh = document.getElementById("cloud-sheet");
    if (sh) sh.innerHTML = innerHtml; else showModal(innerHtml);
  }

  /* =====================================================================
   *  Auth modal
   * ===================================================================== */
  var authTab = "signin";
  function openAuthModal() {
    S.modal = "auth";
    renderAuth();
  }
  function renderAuth() {
    var googleBtn =
      '<button class="cloud-btn google" data-cl="google">' +
        '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35 24 35c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 5.1 29.6 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 5.1 29.6 3 24 3 16 3 9.1 7.6 6.3 14.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 9.9-2 13.5-5.2l-6.2-5.3C29.2 35.9 26.7 37 24 37c-5.3 0-9.7-3.6-11.3-8.4l-6.5 5C9.1 40.4 16 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.2 5.3C39.9 36.5 45 31 45 24c0-1.2-.1-2.3-.4-3.5z"/></svg>' +
        'Continue with Google</button>' +
      '<div class="cloud-divider">or</div>';

    var body;
    if (authTab === "magic") {
      body =
        '<div class="cloud-field"><label>Email</label><input class="cloud-input" id="cl-email" type="email" placeholder="you@example.com"></div>' +
        '<button class="cloud-btn" data-cl="magic">Send magic link</button>' +
        '<p class="cloud-muted">We email you a one-tap sign-in link. No password needed.</p>';
    } else if (authTab === "signup") {
      body =
        '<div class="cloud-field"><label>Name</label><input class="cloud-input" id="cl-name" placeholder="Your name"></div>' +
        '<div class="cloud-field"><label>Email</label><input class="cloud-input" id="cl-email" type="email" placeholder="you@example.com"></div>' +
        '<div class="cloud-field"><label>Password</label><input class="cloud-input" id="cl-pass" type="password" placeholder="At least 6 characters"></div>' +
        '<button class="cloud-btn" data-cl="signup">Create account</button>';
    } else {
      body =
        '<div class="cloud-field"><label>Email</label><input class="cloud-input" id="cl-email" type="email" placeholder="you@example.com"></div>' +
        '<div class="cloud-field"><label>Password</label><input class="cloud-input" id="cl-pass" type="password" placeholder="Your password"></div>' +
        '<button class="cloud-btn" data-cl="signin">Sign in</button>' +
        '<p class="cloud-muted"><button class="cloud-link" data-cl="forgot">Forgot password?</button></p>';
    }

    var tabs =
      '<div class="cloud-tabs">' +
        '<button class="cloud-tab ' + (authTab === "signin" ? "on" : "") + '" data-tab="signin">Sign in</button>' +
        '<button class="cloud-tab ' + (authTab === "signup" ? "on" : "") + '" data-tab="signup">Sign up</button>' +
        '<button class="cloud-tab ' + (authTab === "magic" ? "on" : "") + '" data-tab="magic">Magic link</button>' +
      '</div>';

    setSheet(
      '<div class="cloud-handle"></div>' +
      '<div class="cloud-hd"><h3>Sign in to sync &amp; share</h3><button class="cloud-x" data-cl="close">✕</button></div>' +
      googleBtn + tabs + body +
      '<p class="cloud-muted">Or just keep using the app as a guest — your trip stays on this device.</p>'
    );
  }

  /* =====================================================================
   *  Trips drawer
   * ===================================================================== */
  function tripEmoji(t) {
    try {
      var c = t.content || {};
      return (c.trip && c.trip.icon) || "🧳";
    } catch (e) { return "🧳"; }
  }
  function openTripsModal() {
    S.modal = "trips";
    setSheet('<div class="cloud-handle"></div><div class="cloud-hd"><h3>Your trips</h3><button class="cloud-x" data-cl="close">✕</button></div><p class="cloud-muted">Loading…</p>');
    loadTrips().then(renderTrips);
  }
  function renderTrips() {
    var name = (S.profile && S.profile.display_name) || (S.user && S.user.email) || "";
    var cards = S.trips.length
      ? S.trips.map(function (t) {
          var cur = t.id === S.currentTripId ? " cur" : "";
          var roleClass = t.role || "viewer";
          return (
            '<div class="trip-card' + cur + '" data-open="' + esc(t.id) + '">' +
              '<span class="tc-emoji">🧳</span>' +
              '<div class="tc-main"><div class="tc-title">' + esc(t.title || "Untitled trip") + '</div>' +
                '<div class="tc-sub">' + (t.updated_at ? "Updated " + new Date(t.updated_at).toLocaleDateString() : "") + '</div></div>' +
              '<span class="tc-badge ' + roleClass + '">' + roleClass + '</span>' +
            '</div>'
          );
        }).join("")
      : '<p class="cloud-muted">No cloud trips yet. Create one, or import your local trip below.</p>';

    var localBlob = localStorage.getItem("japan-trip-2026");
    var importBtn = localBlob
      ? '<button class="cloud-btn ghost" data-cl="import">⬆️ Import this device\'s local trip</button>'
      : '';

    setSheet(
      '<div class="cloud-handle"></div>' +
      '<div class="cloud-hd"><h3>Your trips</h3><button class="cloud-x" data-cl="close">✕</button></div>' +
      cards +
      '<div style="height:8px"></div>' +
      '<button class="cloud-btn" data-cl="newtrip">＋ New cloud trip</button>' +
      '<div style="height:8px"></div>' +
      importBtn +
      (S.currentTripId ? '<div style="height:8px"></div><button class="cloud-btn ghost" data-cl="share">👥 Share current trip</button>' : '') +
      (S.currentTripId ? '<div style="height:8px"></div><button class="cloud-btn ghost" data-cl="duplicate">⧉ Duplicate current trip</button>' : '') +
      '<div class="cloud-divider"></div>' +
      '<div class="member-row"><div class="mr-main"><div class="mr-name">' + esc(name) + '</div><div class="mr-email">Signed in</div></div>' +
        '<button class="cloud-btn danger" style="width:auto;padding:8px 14px" data-cl="signout">Sign out</button></div>'
    );
  }

  /* =====================================================================
   *  Share modal
   * ===================================================================== */
  function openShareModal() {
    if (!S.currentTripId) { toast("Open a cloud trip first"); return; }
    S.modal = "share";
    setSheet('<div class="cloud-handle"></div><div class="cloud-hd"><h3>Share trip</h3><button class="cloud-x" data-cl="close">✕</button></div><p class="cloud-muted">Loading…</p>');
    loadMembers().then(renderShare);
  }
  var shareMembers = [];
  function renderShare() {
    var isOwner = S.currentRole === "owner";
    var rows = shareMembers.map(function (m) {
      var nm = (m.profile && m.profile.display_name) || m.user_id.slice(0, 8);
      var em = (m.profile && m.profile.email) || "";
      var removable = isOwner && m.role !== "owner";
      return (
        '<div class="member-row"><div class="mr-main"><div class="mr-name">' + esc(nm) + ' <span class="tc-badge ' + m.role + '">' + m.role + '</span></div>' +
          '<div class="mr-email">' + esc(em) + '</div></div>' +
          (removable ? '<button class="cloud-link" data-rm="' + esc(m.user_id) + '">Remove</button>' : '') +
        '</div>'
      );
    }).join("");

    var ownerTools = isOwner
      ? ('<div class="cloud-field"><label>Invite by email</label><input class="cloud-input" id="cl-invite-email" type="email" placeholder="friend@example.com"></div>' +
         '<div class="cloud-row">' +
           '<button class="cloud-btn" data-cl="invite-editor">Invite as editor</button>' +
           '<button class="cloud-btn ghost" data-cl="invite-viewer">As viewer</button>' +
         '</div>' +
         '<div class="cloud-divider">or</div>' +
         '<div class="cloud-row">' +
           '<button class="cloud-btn ghost" data-cl="link-editor">🔗 Editor link</button>' +
           '<button class="cloud-btn ghost" data-cl="link-viewer">🔗 Viewer link</button>' +
         '</div>')
      : '<p class="cloud-muted">Only the owner can manage sharing.</p>';

    setSheet(
      '<div class="cloud-handle"></div>' +
      '<div class="cloud-hd"><h3>Share trip</h3><button class="cloud-x" data-cl="close">✕</button></div>' +
      '<div style="margin-bottom:8px;font-weight:800;font-size:13px;color:#5b6477;">MEMBERS</div>' +
      (rows || '<p class="cloud-muted">No members yet.</p>') +
      '<div style="height:14px"></div>' + ownerTools
    );
  }

  /* =====================================================================
   *  Data ops
   * ===================================================================== */
  function loadProfile() {
    if (!S.user) { S.profile = null; return Promise.resolve(); }
    return sb.from("profiles").select("id,email,display_name,avatar_url").eq("id", S.user.id).single()
      .then(function (r) { if (r.data) S.profile = r.data; })
      .catch(function () {});
  }
  function loadTrips() {
    return Promise.all([
      sb.from("trips").select("id,title,updated_at,owner_id").order("updated_at", { ascending: false }),
      sb.from("trip_members").select("trip_id,role").eq("user_id", uid())
    ]).then(function (res) {
      var tripsRes = res[0], membersRes = res[1];
      // If tables don't exist yet, Supabase returns an error — inform user once.
      if (tripsRes.error && /does not exist|permission denied/i.test(tripsRes.error.message)) {
        if (!sessionStorage.getItem("cloud-schema-warned")) {
          sessionStorage.setItem("cloud-schema-warned", "1");
          toast("⚠️ Cloud DB not set up — run supabase-schema.sql in Supabase dashboard");
        }
        S.currentTripId = null;
        localStorage.removeItem("cloud-active-trip");
        return;
      }
      var trips = tripsRes.data || [];
      var roleMap = {};
      ((membersRes.data) || []).forEach(function (m) { roleMap[m.trip_id] = m.role; });
      S.trips = trips.map(function (t) {
        return { id: t.id, title: t.title, updated_at: t.updated_at, owner_id: t.owner_id,
                 role: t.owner_id === uid() ? "owner" : (roleMap[t.id] || "viewer") };
      });
    }).catch(function (e) { console.warn("[cloud] loadTrips", e); });
  }
  function openTrip(id) {
    return sb.from("trips").select("*").eq("id", id).single().then(function (r) {
      if (r.error || !r.data) {
        var msg = r.error ? r.error.message : "Trip not found";
        // If tables are missing (schema not deployed) the error contains "does not exist"
        if (r.error && /does not exist|permission denied/i.test(r.error.message)) {
          toast("Cloud not ready — run supabase-schema.sql first");
        } else {
          toast("Could not open trip: " + msg);
        }
        return Promise.reject(new Error(msg));
      }
      var row = r.data;
      S.currentTripId = row.id;
      S.currentRole = row.owner_id === uid() ? "owner" : (roleForTrip(row.id) || "viewer");
      localStorage.setItem("cloud-active-trip", row.id);
      // Repoint the app's storage to a per-trip cache key so the original
      // local (guest) trip under "japan-trip-2026" is preserved as a backup.
      window.TripApp && window.TripApp.setActiveKey && window.TripApp.setActiveKey("cloud-trip:" + row.id);
      applyRemoteContent(row.content);
      S.knownUpdatedAt = row.updated_at || null;   // remember the version we just loaded
      window.TripApp && window.TripApp.setReadOnly(!canEdit());
      subscribeRealtime(row.id);
      closeModal();
      toast(canEdit() ? "Trip opened — changes sync automatically" : "Trip opened (view only)");
    });
  }
  function roleForTrip(id) {
    var t = S.trips.find(function (x) { return x.id === id; });
    return t && t.role;
  }
  function createTrip(content, title) {
    var body = { owner_id: uid(), title: title || (content && content.trip && content.trip.title) || "Untitled trip", content: content || {}, updated_by: uid() };
    return sb.from("trips").insert(body).select().single().then(function (r) {
      if (r.error) { toast("Create failed: " + r.error.message); return null; }
      return r.data;
    });
  }
  function importLocalTrip() {
    var raw = localStorage.getItem("japan-trip-2026");
    if (!raw) { toast("No local trip found"); return; }
    var content;
    try { content = JSON.parse(raw); } catch (e) { toast("Local trip unreadable"); return; }
    var title = (content.trip && content.trip.title) || "Imported trip";
    createTrip(content, title).then(function (row) {
      if (row) { toast("Imported to cloud ✓ (local backup kept)"); loadTrips().then(function () { openTrip(row.id); }); }
    });
  }
  function duplicateCurrent() {
    if (!S.currentTripId) return;
    sb.from("trips").select("content,title").eq("id", S.currentTripId).single().then(function (r) {
      if (r.error || !r.data) { toast("Duplicate failed"); return; }
      var content = JSON.parse(JSON.stringify(r.data.content || {}));
      // regenerate nested ids so the copy is fully independent
      reidContent(content);
      if (content.trip) content.trip.title = (content.trip.title || r.data.title || "Trip") + " (Copy)";
      createTrip(content, (r.data.title || "Trip") + " (Copy)").then(function (row) {
        if (row) { toast("Duplicated ✓"); loadTrips().then(function () { openTrip(row.id); }); }
      });
    });
  }
  function reidContent(c) {
    function rid() { return (window.TripApp && window.TripApp.newId && window.TripApp.newId()) || ("id-" + Math.random().toString(36).slice(2)); }
    (c.days || []).forEach(function (d) {
      d.id = "day-" + rid().slice(0, 8);
      (d.attractions || []).forEach(function (x) { x.id = rid(); });
      (d.restaurants || []).forEach(function (x) { x.id = rid(); });
      if (d.customItems) Object.keys(d.customItems).forEach(function (k) { (d.customItems[k] || []).forEach(function (x) { x.id = rid(); }); });
    });
    (c.locations || []).forEach(function (l) {
      l.id = rid();
      (l.attractions || []).forEach(function (x) { x.id = rid(); });
      (l.restaurants || []).forEach(function (x) { x.id = rid(); });
      if (l.customItems) Object.keys(l.customItems).forEach(function (k) { (l.customItems[k] || []).forEach(function (x) { x.id = rid(); }); });
    });
  }
  function deleteTrip(id) {
    return sb.from("trips").delete().eq("id", id).then(function (r) {
      if (r.error) { toast("Delete failed: " + r.error.message); return; }
      if (S.currentTripId === id) { S.currentTripId = null; localStorage.removeItem("cloud-active-trip"); }
      loadTrips().then(renderTrips);
    });
  }

  function loadMembers() {
    return sb.from("trip_members").select("trip_id,user_id,role").eq("trip_id", S.currentTripId).then(function (r) {
      var members = (r.data) || [];
      // fetch profiles for display (own profile always readable; others may be limited by RLS — fall back to id)
      var ids = members.map(function (m) { return m.user_id; });
      if (!ids.length) { shareMembers = members; return; }
      return sb.from("profiles").select("id,email,display_name,avatar_url").in("id", ids).then(function (p) {
        var pmap = {}; ((p.data) || []).forEach(function (x) { pmap[x.id] = x; });
        shareMembers = members.map(function (m) { return Object.assign({}, m, { profile: pmap[m.user_id] }); });
      });
    }).catch(function () { shareMembers = []; });
  }
  function inviteByEmail(email, role) {
    if (!email) { toast("Enter an email"); return; }
    sb.rpc("find_profile_by_email", { p_email: email }).then(function (r) {
      var found = (r.data && r.data[0]);
      if (found) {
        sb.from("trip_members").insert({ trip_id: S.currentTripId, user_id: found.id, role: role })
          .then(function (res) {
            if (res.error) toast("Invite failed: " + res.error.message);
            else { toast("Added " + (found.display_name || email) + " as " + role); loadMembers().then(renderShare); }
          });
      } else {
        // user not registered yet → create a pending email invite + share link
        createInvite(email, role).then(function (token) {
          if (token) { copyShareLink(token); toast("No account yet — share link copied to send them"); }
        });
      }
    });
  }
  function createInvite(email, role) {
    var expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(); // 30 days
    return sb.from("trip_invites").insert({ trip_id: S.currentTripId, email: email || null, role: role, created_by: uid(), expires_at: expires })
      .select("token").single().then(function (r) {
        if (r.error) { toast("Link failed: " + r.error.message); return null; }
        return r.data.token;
      });
  }
  function shareLinkUrl(token) { return APP_URL.replace(/\/?$/, "/") + "index.html?invite=" + token; }
  function copyShareLink(token) {
    var url = shareLinkUrl(token);
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast("Share link copied"); }, function () { prompt("Copy this link:", url); });
    else prompt("Copy this link:", url);
  }
  function removeMember(userId) {
    sb.from("trip_members").delete().eq("trip_id", S.currentTripId).eq("user_id", userId).then(function (r) {
      if (r.error) toast("Remove failed: " + r.error.message);
      else { toast("Removed"); loadMembers().then(renderShare); }
    });
  }

  /* =====================================================================
   *  Sync engine
   * ===================================================================== */
  function applyRemoteContent(content) {
    if (!window.TripApp || !content) return;
    window.TripApp.setContent(content, { silent: true });
  }
  function onLocalChange() {
    if (!S.currentTripId || !canEdit()) return;
    if (S.saveTimer) clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(pushContent, 800);
  }
  function pushContent() {
    if (!S.currentTripId || !canEdit() || !window.TripApp) return;
    var content = window.TripApp.getContent();
    var title = (content.trip && content.trip.title) || "Untitled trip";
    // Return updated_at so we can advance our local version and recognise the
    // realtime echo of our own write.
    sb.from("trips").update({ content: content, title: title, updated_by: uid() }).eq("id", S.currentTripId)
      .select("updated_at").single()
      .then(function (r) {
        if (r.error) { console.warn("[cloud] push", r.error); return; }
        if (r.data && r.data.updated_at) S.knownUpdatedAt = r.data.updated_at;
      });
  }
  function contentEquals(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }
  // Decide what to do with an incoming trip row (from realtime OR a refetch).
  // Echo detection is by VERSION (updated_at) + CONTENT — never by updated_by,
  // because the same user on two devices shares one uid, and a uid filter would
  // hide your other device's edits (the cross-device drift bug).
  function applyRemoteRow(row, note) {
    if (!row || !row.content) return;
    // Older-or-equal version than what we already hold → stale or our own echo.
    if (row.updated_at && S.knownUpdatedAt && row.updated_at <= S.knownUpdatedAt) return;
    var current = window.TripApp ? window.TripApp.getContent() : null;
    if (current && contentEquals(current, row.content)) {     // identical → nothing to show
      if (row.updated_at) S.knownUpdatedAt = row.updated_at;  // still advance the version
      return;
    }
    // Don't clobber an open editor — buffer and apply when it closes.
    if (window.TripApp && window.TripApp.isEditing()) { S.pendingRemoteRow = row; return; }
    applyRemoteContent(row.content);
    if (row.updated_at) S.knownUpdatedAt = row.updated_at;
    if (note) toast(note);
  }
  // Pull the authoritative latest row (used on reconnect / tab-resume / focus,
  // when realtime may have missed events while the tab was suspended).
  function refetchCurrent() {
    if (!S.currentTripId) return;
    if (window.TripApp && window.TripApp.isEditing()) return;
    sb.from("trips").select("content,updated_at").eq("id", S.currentTripId).single()
      .then(function (r) { if (!r.error && r.data) applyRemoteRow(r.data, null); })
      .catch(function () {});
  }
  function subscribeRealtime(id) {
    if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
    S.channel = sb.channel("trip:" + id)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "trips", filter: "id=eq." + id }, function (payload) {
        if (payload && payload.new) applyRemoteRow(payload.new, "Trip updated");
      })
      .subscribe(function (status) {
        // After a (re)subscribe, reconcile against the server in case events
        // were dropped while the connection/tab was asleep.
        if (status === "SUBSCRIBED") refetchCurrent();
      });
  }
  // reconcile a buffered remote change once the user closes their editor
  setInterval(function () {
    if (S.pendingRemoteRow && window.TripApp && !window.TripApp.isEditing()) {
      var row = S.pendingRemoteRow; S.pendingRemoteRow = null;
      applyRemoteRow(row, null);
    }
  }, 1200);
  // Resume hooks: phones suspend background tabs and drop the realtime socket.
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refetchCurrent(); });
  window.addEventListener("focus", refetchCurrent);
  window.addEventListener("online", refetchCurrent);

  /* =====================================================================
   *  Auth flows
   * ===================================================================== */
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
  function doGoogle() {
    // signInWithOAuth redirects the browser on success. If the Google provider
    // isn't enabled in Supabase (or misconfigured), it resolves with an error
    // and does NOT redirect — surface that clearly instead of failing silently.
    sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: REDIRECT } })
      .then(function (r) {
        if (r && r.error) {
          console.warn("[cloud] Google OAuth error:", r.error.message);
          toast("Google sign-in isn’t set up yet — use email for now.");
        }
      })
      .catch(function (e) {
        console.warn("[cloud] Google OAuth threw:", e);
        toast("Google sign-in isn’t available right now — use email.");
      });
  }
  function doSignin() {
    sb.auth.signInWithPassword({ email: val("cl-email"), password: val("cl-pass") }).then(function (r) {
      if (r.error) toast(r.error.message); else { closeModal(); toast("Welcome back"); }
    });
  }
  function doSignup() {
    var name = val("cl-name");
    sb.auth.signUp({ email: val("cl-email"), password: val("cl-pass"), options: { data: { full_name: name }, emailRedirectTo: REDIRECT } })
      .then(function (r) {
        if (r.error) toast(r.error.message);
        else if (r.data.session) { closeModal(); toast("Account created"); }
        else { closeModal(); toast("Check your email to confirm your account"); }
      });
  }
  function doMagic() {
    sb.auth.signInWithOtp({ email: val("cl-email"), options: { emailRedirectTo: REDIRECT } }).then(function (r) {
      if (r.error) toast(r.error.message); else toast("Magic link sent — check your email");
    });
  }
  function doForgot() {
    var email = val("cl-email");
    if (!email) { toast("Enter your email first"); return; }
    sb.auth.resetPasswordForEmail(email, { redirectTo: REDIRECT }).then(function (r) {
      if (r.error) toast(r.error.message); else toast("Password reset email sent");
    });
  }
  function doSignout() {
    sb.auth.signOut().then(function () {
      S.user = null; S.profile = null; S.currentTripId = null; S.currentRole = null;
      S.loggingIn = false;  // reset so the next sign-in triggers afterLogin()
      localStorage.removeItem("cloud-active-trip");
      if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
      if (window.TripApp) {
        window.TripApp.setReadOnly(false);
        window.TripApp.setActiveKey(null);   // back to the local guest store
        window.TripApp.reloadLocal();         // restore the guest trip view
      }
      closeModal(); mountAccountButton(); toast("Signed out");
    });
  }
  function renderRecover() {
    S.modal = "recover";
    showModal(
      '<div class="cloud-handle"></div>' +
      '<div class="cloud-hd"><h3>Set a new password</h3><button class="cloud-x" data-cl="close">✕</button></div>' +
      '<div class="cloud-field"><label>New password</label><input class="cloud-input" id="cl-newpass" type="password" placeholder="At least 6 characters"></div>' +
      '<button class="cloud-btn" data-cl="setpass">Update password</button>'
    );
  }

  /* =====================================================================
   *  Global click handler for cloud UI
   * ===================================================================== */
  document.addEventListener("click", function (e) {
    var tabEl = e.target.closest("[data-tab]");
    if (tabEl) { authTab = tabEl.dataset.tab; renderAuth(); return; }
    var rm = e.target.closest("[data-rm]");
    if (rm) { removeMember(rm.dataset.rm); return; }
    var openEl = e.target.closest("[data-open]");
    if (openEl) { openTrip(openEl.dataset.open); return; }
    var el = e.target.closest("[data-cl]");
    if (!el) return;
    var a = el.dataset.cl;
    if (a === "close") return closeModal();
    if (a === "google") return doGoogle();
    if (a === "signin") return doSignin();
    if (a === "signup") return doSignup();
    if (a === "magic") return doMagic();
    if (a === "forgot") return doForgot();
    if (a === "signout") return doSignout();
    if (a === "newtrip") {
      var blank = (window.TripApp && window.TripApp.blankContent && window.TripApp.blankContent()) || { trip: { title: "New trip" }, days: [], customSections: [], locations: [] };
      createTrip(blank, "New trip").then(function (row) { if (row) { loadTrips().then(function () { openTrip(row.id); }); } });
      return;
    }
    if (a === "import") return importLocalTrip();
    if (a === "duplicate") return duplicateCurrent();
    if (a === "share") return openShareModal();
    if (a === "invite-editor") return inviteByEmail(val("cl-invite-email"), "editor");
    if (a === "invite-viewer") return inviteByEmail(val("cl-invite-email"), "viewer");
    if (a === "link-editor") return createInvite(null, "editor").then(function (tok) { if (tok) copyShareLink(tok); });
    if (a === "link-viewer") return createInvite(null, "viewer").then(function (tok) { if (tok) copyShareLink(tok); });
    if (a === "setpass") {
      sb.auth.updateUser({ password: val("cl-newpass") }).then(function (r) {
        if (r.error) toast(r.error.message); else { closeModal(); toast("Password updated"); }
      });
      return;
    }
  });

  /* =====================================================================
   *  Boot
   * ===================================================================== */
  function maybeAcceptInvite() {
    var m = location.search.match(/[?&]invite=([a-f0-9]+)/i);
    if (!m) return Promise.resolve();
    var token = m[1];
    if (!S.user) { toast("Sign in to accept the invitation"); openAuthModal(); return Promise.resolve(); }
    return sb.rpc("accept_invite", { p_token: token }).then(function (r) {
      if (r.error) { toast("Invite: " + r.error.message); return; }
      var tripId = r.data;
      // clean the URL
      history.replaceState({}, "", location.pathname);
      toast("Invitation accepted ✓");
      return loadTrips().then(function () { if (tripId) openTrip(tripId); });
    });
  }

  function afterLogin() {
    // onAuthStateChange + getSession() can both fire on load; run only once.
    if (S.loggingIn) return Promise.resolve();
    S.loggingIn = true;
    return loadProfile().then(function () {
      mountAccountButton();
      return loadTrips();
    }).then(function () {
      return maybeAcceptInvite();
    }).then(function () {
      var hasInvite = location.search.match(/invite=/);
      if (S.currentTripId && !hasInvite) {
        // If the trip can't be found, clear the stale id so we don't loop.
        return openTrip(S.currentTripId).catch(function () {
          S.currentTripId = null;
          localStorage.removeItem("cloud-active-trip");
          maybeOfferImport();
        });
      } else if (!S.currentTripId && !hasInvite) {
        maybeOfferImport();
      }
    }).catch(function (err) {
      console.warn("[cloud] afterLogin error:", err);
    }).then(function () {
      S.loggingIn = false;
      S.bootedFromCache = null;   // authoritative load done; no longer "optimistic"
    });
  }

  function maybeOfferImport() {
    if (localStorage.getItem("cloud-import-offered")) return;
    if (!localStorage.getItem("japan-trip-2026")) return;
    localStorage.setItem("cloud-import-offered", "1");
    var b = document.createElement("div");
    b.className = "cloud-banner";
    b.innerHTML = '<span style="flex:1">☁️ Save this device\'s trip to your account?</span>' +
                  '<button class="cloud-btn" data-cl="import">Import</button>' +
                  '<button class="cloud-x" data-cl="close" style="margin-left:6px">✕</button>';
    var root = document.getElementById("root");
    if (root && root.firstChild) root.insertBefore(b, root.firstChild.nextSibling);
    else document.body.appendChild(b);
  }

  // Synchronous fast-path: if we previously had a cloud trip open AND a Supabase
  // session token is present AND we cached the trip locally, paint that cached
  // cloud trip immediately (instead of the guest snapshot) and repoint storage
  // to the per-trip cache key. This removes the network-length "stale flash" and
  // guarantees that any edit during startup writes to the cloud cache — never to
  // the guest backup. afterLogin() then refetches the authoritative latest.
  function hasSupabaseSession() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && /^sb-.*-auth-token$/.test(k) && localStorage.getItem(k)) return true;
      }
    } catch (e) {}
    return false;
  }
  function bootFastPath() {
    try {
      if (!window.TripApp) return;
      var activeId = localStorage.getItem("cloud-active-trip");
      if (!activeId || !hasSupabaseSession()) return;
      var cacheRaw = localStorage.getItem("cloud-trip:" + activeId);
      if (!cacheRaw) return;
      var cached = JSON.parse(cacheRaw);
      window.TripApp.setActiveKey("cloud-trip:" + activeId);
      window.TripApp.setContent(cached, { silent: true });
      S.bootedFromCache = activeId;
    } catch (e) { /* fall back to normal guest paint */ }
  }

  function init() {
    injectStyles();
    // wait for TripApp bridge
    var tries = 0;
    (function waitApp() {
      if (window.TripApp) { watchTopbar(); } else if (tries++ < 50) { setTimeout(waitApp, 60); } else { watchTopbar(); }
    })();

    // Optimistic cache paint (signed-in returning visit) — before any network.
    bootFastPath();

    // onAuthStateChange fires with INITIAL_SESSION immediately — no need for a
    // separate getSession() call, which would race and call afterLogin() twice.
    sb.auth.onAuthStateChange(function (event, session) {
      S.user = (session && session.user) || null;
      // IMPORTANT: never call other supabase methods synchronously inside this
      // callback — the SDK holds the auth lock here, so a sb.from()/sb.auth call
      // would wait on a lock that can't release → deadlock → page freeze.
      // Defer all real work to a fresh task so the lock is released first.
      if (event === "PASSWORD_RECOVERY") { setTimeout(renderRecover, 0); return; }
      if (event === "SIGNED_OUT") {
        S.loggingIn = false;   // reset guard so next sign-in works
        setTimeout(mountAccountButton, 0);
        return;
      }
      if (S.user) {
        setTimeout(afterLogin, 0);
      } else {
        setTimeout(function () {
          // We optimistically painted a cached cloud trip but there's no valid
          // session → revert to the guest store so we never show cloud data to
          // a signed-out user.
          if (S.bootedFromCache && window.TripApp) {
            S.bootedFromCache = null;
            window.TripApp.setActiveKey(null);
            window.TripApp.reloadLocal();
          }
          mountAccountButton(); maybeAcceptInviteGuest();
        }, 0);
      }
    });
  }
  function maybeAcceptInviteGuest() {
    if (location.search.match(/invite=/)) { toast("Sign in to accept the invitation"); openAuthModal(); }
  }

  // public bridge for the patched persist()
  window.TripCloud = { enabled: true, onLocalChange: onLocalChange };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
