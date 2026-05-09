# Japan 2026 — Trip Planner

A single-file, day-by-day planner for the 13–31 May 2026 Japan trip.
**Pure HTML + CSS + JavaScript — no React, no frameworks, no CDNs.**
Works fully offline. All edits persist in your browser's `localStorage`.

## How to use

1. Double-click `japan-trip.html` — it opens in your default browser.
2. Tap any day in the horizontal day strip at the top.
3. Each place has a dark **📍 Navigate** button that opens Google Maps in a new tab.
4. Use **+ Add Place** / **+ Add Restaurant**, the **✏️** button on a card, or **🗑️** to customise.
5. **Mark day done** in the day overview — completed days get a green ✓ on their pill.
6. Tap **+ New section** at the bottom to add custom sections (Bars, Onsens, Shopping, anything).
7. Tap **Reset** in the top bar to wipe edits and reload the default itinerary.

Data lives in `localStorage` under the key `japan-trip-2026`.
It is per-browser per-device — clearing browser data loses edits.

## iPhone access (offline-friendly)

The app is a single HTML file with no network dependencies, so any of these work:

### Option A — Just AirDrop / iCloud / email the file (truly offline)

1. AirDrop `japan-trip.html` to your iPhone, or put it in iCloud Drive, or email it to yourself.
2. On iPhone, open the file from **Files** or **Mail**. It opens in Safari and works fully offline.
3. Tap **Share → Add to Home Screen** to give it an app icon. The icon launches the file directly — no internet required.

### Option B — GitHub Pages (one shareable URL across devices)

A public URL is convenient if you also want desktop access on a different machine.

1. Create a new **public** GitHub repository (e.g. `japan-trip`).
2. Upload `japan-trip.html` and rename it to `index.html` during upload.
3. Repo **Settings → Pages** → Source = `main` / `(root)` → **Save**.
4. After ~1 min, the site is live at `https://<you>.github.io/<repo>/`.
5. Open on iPhone, **Share → Add to Home Screen**.

### Heads up: edits don't sync between devices

`localStorage` is per-browser-per-device. Edits made on iPhone don't show up on laptop and vice versa. Pick one device as the primary editor (iPhone works great for on-the-go additions).

## Tech notes

- Single HTML file. No build step, no server, no dependencies.
- All CSS is inline. All JavaScript is inline (no external libraries).
- Uses `crypto.randomUUID()` for new IDs (modern Safari/Chrome supported).
- iOS-friendly: 44 px touch targets, 16 px input font (no zoom on focus), `env(safe-area-inset-*)` for notch/home indicator.
- Source itinerary: extracted from `Plan_v5.docx` daily-itinerary section only (May 13 → May 31).
