[README.md](https://github.com/user-attachments/files/32752537/README.md)
# Delivery Sheet

Digital version of the paper delivery sheet, served by a Cloudflare Worker.

- Name is asked every time the page opens (pre-filled with the last one used).
- Every save records who created and who last saved the sheet; each access is logged.
- Date: day (1st–31st) / month (January–December) / year dropdowns, all in English.
- Day: weekday dropdown (Monday–Sunday), auto-suggested from the date.
- Del. No. and Confirm check columns stay blank.
- PP / OS: choose PP or OS and type the number.
- Time in / Time out: 30 minutes → 6 hours, in 15-minute steps.
- Print button outputs an A4 page laid out like the paper form.
- Google Calendar panel: after choosing the date, shows that day's calendar events
  (with the PP / OS number read from the title or description). Tick them and click
  "Add selected to sheet" to fill the first empty rows. Events already on the sheet
  are greyed out; events without a PP / OS number can't be added.

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
| GET | /api/calendar?date=YYYY-MM-DD | calendar events of one day |
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
