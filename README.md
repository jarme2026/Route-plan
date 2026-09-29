# Delivery Sheet

Digital version of the paper delivery sheet, served by a Cloudflare Worker.

- Name is asked every time the page opens (pre-filled with the last one used).
- Every save records who created and who last saved the sheet; each access is logged.
- Header: Date (day 1st–31st / month / year dropdowns) and Day (weekday, auto-suggested).
- Route (top of the table): one option per calendar event colour on that day (Orange and Blue
  first, a third colour appears automatically). "Fill all" puts every delivery of the route on
  the sheet. Ignored events: "1 van", "2 vans", no title, two-letter initials.
- Three columns:
  1. Delivery – shortcut card for the calendar event (time, title, address).
     Click it for the full card: address with Google Maps link and the event details.
  2. PP / OS – dropdown with the deliveries of the chosen route (used ones are greyed out),
     or "Other – type number…" to type one by hand.
  3. Time in / Time out – 30 minutes → 6 hours, in 15-minute steps.
- Mobile: each delivery is a numbered block; only filled rows plus the next empty one show.
- The event is saved inside the sheet, so the card still opens after the event leaves the
  synced calendar window.
- Print button outputs an A4 page laid out like the paper form.

## Structure

```
public/index.html   page (HTML + CSS + JS in one file)
src/index.js        Worker + Durable Object (SheetStore) storing sheets, access log and calendar
google-apps-script.js  code for the Google Sheet (Extensions -> Apps Script) that pushes the calendar
wrangler.jsonc      Cloudflare config
```

## API (all requests need header `x-user-name`)

| Method | Path | |
|---|---|---|
| POST | /api/hello | log access |
| GET | /api/access-log | last 200 accesses |
| GET | /api/sheets | list sheets |
| GET/PUT/DELETE | /api/sheets/:id | read / save / delete one sheet |
| GET | /api/calendar?date=YYYY-MM-DD | calendar events of one day (stored per day as `cal:YYYY-MM-DD`) |
| POST | /api/calendar/sync | Google Apps Script pushes events (header `x-sync-key`, no name needed) |

## Calendar sync

The Worker never reads Google directly (the company account blocks public links).
Instead the Apps Script in the Google Sheet pushes the events every 5 minutes.

1. Cloudflare: Worker -> Settings -> Variables and Secrets -> add Secret `SYNC_KEY`
   (or `npx wrangler secret put SYNC_KEY`).
2. Google Sheet -> Extensions -> Apps Script: paste `google-apps-script.js`,
   set `WORKER_URL` and `SYNC_KEY`, run `atualizarPlanilha` once, keep the
   5-minute time-driven trigger on `atualizarPlanilha`.

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
