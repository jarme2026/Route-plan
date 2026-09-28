[README.md](https://github.com/user-attachments/files/32753224/README.md)
# Delivery Sheet

Digital version of the paper delivery sheet, served by a Cloudflare Worker.

- Name is asked every time the page opens (pre-filled with the last one used).
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
- Data is loaded only when the page opens and when **Refresh** is clicked
  (no polling, no cron), to keep Worker requests low.

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
| GET | /api/calendar | events from the calendars (-7 to +45 days) |
| GET | /api/sheets | list sheets |
| GET/PUT/DELETE | /api/sheets/:id | read / save / delete one sheet |

## Calendars (Google)

For each calendar: Google Calendar → Settings → click the calendar →
**Integrate calendar** → copy **Secret address in iCal format**. Then:

```
npx wrangler secret put CAL_WAREHOUSE      # Warehouse/Deliveries
npx wrangler secret put CAL_LIVING_BRAY    # Living Bray
```

For `wrangler dev`, put the same values in a `.dev.vars` file (do not commit it):

```
CAL_WAREHOUSE=https://calendar.google.com/calendar/ical/.../basic.ics
CAL_LIVING_BRAY=https://calendar.google.com/calendar/ical/.../basic.ics
```

To change names, colours or priority, edit `CALENDARS` in `src/calendar.js`.

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
