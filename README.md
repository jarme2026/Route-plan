# Delivery Sheet

Digital version of the paper delivery sheet, served by a Cloudflare Worker.

- Name is asked every time the page opens (pre-filled with the last one used).
- **Admin** (name + password, secret `ADMIN_PASSWORD`): edits everything, sees the calendar,
  and chooses which saved sheets are **visible to the team** (Show to team / Hide).
- **Team** (name only): sees only the visible sheets and changes only Time in / Time out;
  each change is saved at once and shows who changed it. Rules are enforced by the server.
- PP / OS numbers come only from the events of the selected date: pick PP or OS on each
  event; changing the date removes rows that are not in that day's events; Save is blocked
  if a row doesn't belong to the date.
- Every save records who created and who last saved the sheet; each access is logged.
- Date: day (1st–31st) / month (January–December) / year dropdowns, all in English.
- Day: weekday dropdown (Monday–Sunday), auto-suggested from the date.
- Del. No. and Confirm check columns stay blank.
- PP / OS: choose PP or OS and type the number.
- Time in / Time out: 30 minutes → 6 hours, in 15-minute steps.
- Online only (no print).
- Calendar panel shows the events of the selected date from the two ticked
  Google calendars, in priority order: **Warehouse/Deliveries**, then **Living Bray**.
  PP / OS numbers found in an event (e.g. `PP 123456`, `OS-7788`) are highlighted;
  "Fill sheet from calendar" puts them in the empty rows, "Add" does it for one event.
- The page loads data only when it opens and when **Refresh** is clicked
  (no polling, no cron). The calendar reaches the site from Google Apps Script,
  only when it changes, to keep Worker requests low.

## Structure

```
public/index.html   page (HTML + CSS + JS in one file)
src/index.js        Worker + Durable Object (SheetStore) storing sheets and access log
src/calendar.js     reads the Google calendars (iCal) and filters the events
wrangler.jsonc      Cloudflare config
```

## API (all requests need header `x-user-name`)

| Method | Path | |
|---|---|---|
| POST | /api/hello | log access |
| GET | /api/access-log | last 200 accesses |
| GET | /api/calendar | last events pushed by Apps Script (-7 to +45 days) |
| POST | /api/calendar-sync | used by Apps Script (header `x-sync-token`) |
| GET | /api/sheets | list sheets |
| GET/PUT/DELETE | /api/sheets/:id | read / save / delete one sheet |

## Admin password

```
npx wrangler secret put ADMIN_PASSWORD
```

Changing it logs every admin device out.

## Calendars (Google)

### Option 1 (used): Google Apps Script pushes the events

For Workspace accounts where the Web App can't be shared with "Anyone" and the
secret iCal address is hidden. The script runs as your account, reads any
calendar you can see and POSTs the events to `/api/calendar-sync`.
It checks every 15 minutes and only sends when something changed
(plus a heartbeat every 3 hours).

1. Cloudflare secret: `npx wrangler secret put SYNC_TOKEN` (a long random password).
2. script.google.com → New project → paste `google-apps-script/Code.gs`.
3. Fill `WORKER_URL`, `SYNC_TOKEN` (same value) and the Warehouse Calendar ID.
4. Select `setup` → Run → authorise. The log must show both calendars OK and
   `Worker answered 200`.
5. `pushNow` sends immediately (e.g. right after changing the calendar).

No Web App deployment is needed.

### Option 2: read Google directly (only if allowed)

Used only while nothing was pushed yet.

- `CAL_SCRIPT_URL`: a public Apps Script Web App (`…/exec?token=…`), or
- `CAL_WAREHOUSE` / `CAL_LIVING_BRAY`: secret iCal addresses.

For `wrangler dev`, put secrets in a `.dev.vars` file (never commit it).

## Run locally

```
npm install
npx wrangler dev
```

## Deploy

```
npx wrangler login
npx wrangler deploy
```

Optional: put the URL behind Cloudflare Access (Zero Trust → Access → Applications)
if it must be restricted to specific emails.
