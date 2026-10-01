# Route Plan

Digital delivery sheet fed by Google Calendar, served by a Cloudflare Worker.

## Access

| | Admin (password) | Team (name only) |
|---|---|---|
| Date, route, PP / OS, sign out / in | edit | – |
| Route preview (timeline + map + Google Maps link) | yes | yes (read only) |
| Driving times, leave / back times | yes | – |
| Delivery duration + red flags | edit | – |
| Save / New / Delete sheet, Answers + CSV, Close day | yes | – |

- Admin password = Cloudflare secret `ADMIN_PASSWORD`. Changing it logs every admin out.
- Everybody types their name when the page opens. Team members only see the route preview of
  the saved sheets; today's sheet opens by itself when there is only one.
- Red flag 🚩: the delivery duration chosen by the admin differs from the planned time (length of
  the calendar event). No tolerance. Shown on the row, in the preview, in the sheet list, in
  Answers and in the CSV ("Red flag" = YES) – to check with the driver.
- "Close day" locks the sheet and opens the answers report.
- No automatic refresh: the sheet is reloaded from the server whenever you change something
  (duration, save, close / reopen), when you press Refresh, or when you reload the page.

## Route preview

- Admin: appears as soon as a date and a route are chosen (from the calendar, before filling the
  sheet), then follows the rows of the sheet.
- Team: the route saved with the sheet (the admin's last Save).
- Schedule: every route leaves the warehouse at 09:30 (DEPART_TIME in public/index.html);
  calendar times are not used. For each stop: drive → arrive → delivery time → leave → next drive.
  Delivery time = the Delivery duration chosen, otherwise the planned time (calendar event length).
- Lunch: option in the PP / OS dropdown (once per sheet), adds 30 minutes at that point, no driving.
- The Apps Script also sends the exact point ("lat,lng") of every delivery and of the warehouse:
  the "Open route in Maps" button and the map pins use it, so Maps never has to guess
  ("Dublin 16, Ireland"). Driving times and points cover the same 21 days as the sync.
- Sheet order: the driving times follow the order of the rows on the sheet. "⟳ Sync calendar"
  first saves the sheet (its trips go to the Worker), the Apps Script reads them
  (GET /api/calendar/requests) and works them out, and the sheet is saved again afterwards so
  the team sees the new times.
- Set area (admin): when a delivery shows "Driving time not calculated yet" or "No place found",
  the admin clicks "📍 Set area" (or "📍 Change area" in the delivery card) and types the area /
  Eircode. It is saved on the website (key: date + event title); the Apps Script reads it on the
  next sync (GET /api/calendar/overrides, sync key) and works out the driving times with it.
- Places are looked up preferring the Dublin / Leinster area (AREA_PREFERIDA in the Apps Script),
  so "Blackrock" is Blackrock, Co. Dublin, not Cork.
- Driving times shown = Google Maps time + 15 min margin, rounded up to the next 15 min
  (18 → 45 min, 30 → 45 min, 35 → 1 h). Change DRIVE_MARGIN / DRIVE_ROUND in public/index.html.
- Warehouse A94 HX83 (`ARMAZEM` in the Apps Script) is the start and the end of every route.
- The map uses Leaflet + OpenStreetMap, loaded by the browser only when a preview is shown:
  no extra Cloudflare requests. Road paths and coordinates come from the Apps Script.

## Sheet

- Header: Date and Day.
- Route: one option per calendar event colour on that day. "Fill all" puts the whole route on
  the sheet. Ignored events: "1 van", "2 vans", no title, two-letter initials.
- Columns: Delivery (event card) · PP / OS (all numbers found in the event) · Delivery duration
  (30 minutes → 6 hours, 15-minute steps).
- Mobile: each delivery is a numbered block.

## Calendar sync (manual)

- No automatic trigger. The admin presses "⟳ Sync calendar" in the route bar: it opens the Apps
  Script web app in a new tab (runs with the admin's Google login), which reads Google Calendar,
  works out the driving times and sends everything to the Worker. Back on the site, the calendar
  is reloaded once. Cloudflare: 2 requests per sync, nothing when nobody syncs.
- Sync link: the first time, "⟳ Sync calendar" asks for the web app link (Apps Script → Deploy →
  Manage deployments → Web app URL, ends with /exec). Change it later with the ⚙ button.
  (The Apps Script also sends its address with each sync; a link pasted on the site always wins.)
- Web app deployment: Execute as Me · Who has access: Anyone within BoConcept Dublin.
  To update the script keep the same address: Manage deployments → ✏️ → New version.

## Driving times (admin only)

- The Apps Script works out, with Google Maps, the driving time between consecutive deliveries
  of each route (same day + colour, in calendar time order), plus warehouse → first and
  last → warehouse (`ARMAZEM` in the Apps Script). Results are cached for 6 hours.
- Place used for each delivery: the event's Location, else a full Eircode in title /
  description, else the area at the start of the title ("D04" → "Dublin 4, Ireland").
- The sheet shows the time above each delivery card, the day total in the route bar and an
  "Open route in Maps" button with every stop in sheet order.
- If the admin puts the deliveries in a different order from the calendar, the missing pairs
  show "not calculated yet".

## Structure

```
public/index.html      page (HTML + CSS + JS in one file)
google-apps-script.js  Apps Script (calendar sync + driving times)
src/index.js           Worker + Durable Object (SheetStore)
wrangler.jsonc         Cloudflare config
```

## API (all requests need header `x-user-name`; admin ones also `x-admin-token`)

| Method | Path | Who |
|---|---|---|
| POST | /api/admin/login | anyone (password → token) |
| GET | /api/me | everyone |
| GET | /api/sheets · /api/sheets/:id | everyone |
| PUT / DELETE | /api/sheets/:id | admin |
| POST | /api/sheets/:id/duration | everyone (sheet open) |
| GET | /api/sheets/:id/responses | admin |
| POST | /api/sheets/:id/close · /reopen | admin |
| GET | /api/calendar?date=YYYY-MM-DD | admin |
| POST | /api/calendar/sync | Google Apps Script (header `x-sync-key` = `SYNC_TOKEN`) |
| GET | /api/calendar/overrides | Google Apps Script (areas set by the admin) |
| GET | /api/calendar/requests | Google Apps Script (trips the saved sheets need, in sheet order) |
| PUT | /api/places | admin (set / clear the area of a delivery) |
| PUT | /api/sync-url | admin (web app link for "Sync calendar") |

## Secrets (Cloudflare → Settings → Variables and Secrets)

- `ADMIN_PASSWORD` – admin password
- `SYNC_TOKEN` (or `SYNC_KEY`) – same value as `SYNC_KEY` in the Apps Script
