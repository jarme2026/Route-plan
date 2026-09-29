# Route Plan

Digital delivery sheet fed by Google Calendar, served by a Cloudflare Worker.

## Access

| | Admin (password) | Team (name only) |
|---|---|---|
| Date, route, PP / OS, sign out / in | edit | read |
| Delivery card (first column) | yes | yes |
| Delivery duration | edit | edit |
| Save / New / Delete sheet | yes | – |
| Answers (every duration choice) + CSV | yes | – |
| Close / reopen the day | yes | – |

- Admin password = Cloudflare secret `ADMIN_PASSWORD`. Changing it logs every admin out.
- Everybody types their name when the page opens; every duration choice is recorded with
  name and time. The sheet shows the latest choice; "Answers" shows the full history.
- "Close day" locks the sheet (nobody can change durations) and opens the answers report.
- Team members see only the rows with a delivery. Today's sheet opens by itself when there
  is only one; otherwise they pick it from "Sheets".
- No automatic refresh: the sheet is reloaded from the server whenever you change something
  (duration, save, close / reopen), when you press Refresh, or when you reload the page.

## Sheet

- Header: Date and Day.
- Route: one option per calendar event colour on that day. "Fill all" puts the whole route on
  the sheet. Ignored events: "1 van", "2 vans", no title, two-letter initials.
- Columns: Delivery (event card) · PP / OS (all numbers found in the event) · Delivery duration
  (30 minutes → 6 hours, 15-minute steps).
- Mobile: each delivery is a numbered block.

## Structure

```
public/index.html      page (HTML + CSS + JS in one file)
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

## Secrets (Cloudflare → Settings → Variables and Secrets)

- `ADMIN_PASSWORD` – admin password
- `SYNC_TOKEN` (or `SYNC_KEY`) – same value as `SYNC_KEY` in the Apps Script
