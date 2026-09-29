// =========================================
// ROUTE PLAN - Cloudflare Worker
//
// Static page served from ./public (ASSETS)
// Sheets, duration answers, calendar and access log kept in one Durable Object
//
// Access:
//   Admin  -> password (secret ADMIN_PASSWORD): date, route, events, close the day
//   Basic  -> name only: sees the deliveries and picks the delivery duration
// =========================================


const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};


// 30 minutes -> 6 hours, every 15 minutes
const DURATIONS = new Set();

for (let m = 30; m <= 360; m += 15) {
  DURATIONS.add(m);
}


function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    { status, headers: JSON_HEADERS }
  );

}


function userName(request) {

  const raw =
    request.headers.get('x-user-name') || '';

  try {
    return decodeURIComponent(raw).trim().slice(0, 60);
  } catch {
    return raw.trim().slice(0, 60);
  }

}


// Admin token = SHA-256 of the password (changing the password logs every admin out)
async function adminToken(env) {

  if (!env.ADMIN_PASSWORD) return '';

  const data =
    new TextEncoder().encode('route-plan-admin:' + env.ADMIN_PASSWORD);

  const hash =
    await crypto.subtle.digest('SHA-256', data);

  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');

}


async function isAdmin(request, env) {

  const sent =
    request.headers.get('x-admin-token') || '';

  const token =
    await adminToken(env);

  return !!token && sent === token;

}


// Short summary of a sheet for the list
function summary(sheet) {

  const rows =
    (sheet.rows || []).filter(r => r.key);

  return {
    id: sheet.id,
    date: sheet.date,
    day: sheet.day,
    route: sheet.route,
    routeHex: sheet.routeHex,
    status: sheet.status || 'open',
    deliveries: rows.length,
    answered: rows.filter(r => r.duration).length,
    createdBy: sheet.createdBy,
    updatedBy: sheet.updatedBy,
    updatedAt: sheet.updatedAt,
    closedBy: sheet.closedBy,
    closedAt: sheet.closedAt
  };

}


export class SheetStore {

  constructor(ctx, env) {

    this.ctx = ctx;

    this.env = env;

  }


  async fetch(request) {

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    const method =
      request.method;

    const name =
      userName(request);

    const admin =
      await isAdmin(request, this.env);

    const storage =
      this.ctx.storage;


    // ---------- CALENDAR SYNC (from Google Apps Script) ----------
    // Key already checked in the Worker before reaching here.
    // Events are stored one key per day ("cal:YYYY-MM-DD").

    if (path === '/api/calendar/sync' && method === 'POST') {

      const body =
        await request.json().catch(() => null);

      if (!body || !Array.isArray(body.events)) {

        return json({ error: 'Invalid body' }, 400);

      }

      const clean = (v, n) => String(v ?? '').slice(0, n);

      const byDay = {};

      for (const ev of body.events.slice(0, 5000)) {

        const e = {
          date: clean(ev.date, 10),
          start: clean(ev.start, 5),
          end: clean(ev.end, 5),
          allDay: !!ev.allDay,
          title: clean(ev.title, 300),
          location: clean(ev.location, 300),
          description: clean(ev.description, 4000),
          colorId: clean(ev.colorId, 3),
          kind: ev.kind === 'OS' ? 'OS' : (ev.kind === 'PP' ? 'PP' : ''),
          number: clean(ev.number, 30),
          minutes: Number(ev.minutes) || 0
        };

        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;

        (byDay[e.date] ||= []).push(e);

      }

      const previous =
        (await storage.get('calendar-meta')) || {};

      const days =
        Object.keys(byDay);

      // write the new days first, then remove days no longer sent
      const entries =
        Object.entries(byDay);

      for (let i = 0; i < entries.length; i += 100) {

        await storage.put(
          Object.fromEntries(entries.slice(i, i + 100).map(([d, evs]) => ['cal:' + d, evs]))
        );

      }

      const stale =
        (previous.days || []).filter(d => !byDay[d]).map(d => 'cal:' + d);

      for (let i = 0; i < stale.length; i += 100) {

        await storage.delete(stale.slice(i, i + 100));

      }

      const calendarColor =
        /^#[0-9a-f]{6}$/i.test(body.calendarColor || '') ? body.calendarColor : '';

      await storage.put('calendar-meta', {
        syncedAt: new Date().toISOString(),
        calendarColor,
        days
      });

      await storage.delete('calendar');   // old single-key format

      return json({
        ok: true,
        count: entries.reduce((n, [, evs]) => n + evs.length, 0),
        days: days.length
      });

    }


    // ---------- ADMIN LOGIN ----------

    if (path === '/api/admin/login' && method === 'POST') {

      if (!this.env.ADMIN_PASSWORD) {

        return json({ error: 'ADMIN_PASSWORD is not set in Cloudflare' }, 503);

      }

      const body =
        await request.json().catch(() => ({}));

      if ((body.password || '') !== this.env.ADMIN_PASSWORD) {

        return json({ error: 'Wrong password' }, 401);

      }

      return json({ token: await adminToken(this.env) });

    }


    if (!name) {

      return json({ error: 'Name required' }, 401);

    }


    if (path === '/api/me' && method === 'GET') {

      return json({ name, admin });

    }


    // ---------- ACCESS LOG ----------

    if (path === '/api/hello' && method === 'POST') {

      const log =
        (await storage.get('access-log')) || [];

      log.unshift({ name, admin, at: new Date().toISOString() });

      await storage.put('access-log', log.slice(0, 200));

      return json({ ok: true, name, admin });

    }


    if (path === '/api/access-log' && method === 'GET') {

      if (!admin) return json({ error: 'Admin only' }, 403);

      return json(
        (await storage.get('access-log')) || []
      );

    }


    // ---------- CALENDAR (events of one day, admin only) ----------

    if (path === '/api/calendar' && method === 'GET') {

      if (!admin) return json({ error: 'Admin only' }, 403);

      const date =
        url.searchParams.get('date') || '';

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {

        return json({ error: 'date must be YYYY-MM-DD' }, 400);

      }

      const meta =
        (await storage.get('calendar-meta')) || {};

      const events =
        ((await storage.get('cal:' + date)) || [])
          .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

      return json({
        syncedAt: meta.syncedAt || null,
        calendarColor: meta.calendarColor || '',
        date,
        events
      });

    }


    // ---------- SHEETS: list ----------

    if (path === '/api/sheets' && method === 'GET') {

      const entries =
        await storage.list({ prefix: 'sheet:' });

      const list = [];

      for (const sheet of entries.values()) {

        list.push(summary(sheet));

      }

      const iso = s => s.date && s.date.year
        ? `${s.date.year}-${String(s.date.month).padStart(2, '0')}-${String(s.date.day).padStart(2, '0')}`
        : '';

      // newest date first, then last saved
      list.sort((a, b) =>
        iso(b).localeCompare(iso(a)) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));

      return json(list);

    }


    const match =
      path.match(/^\/api\/sheets\/([A-Za-z0-9-]{1,64})(?:\/(duration|close|reopen|responses))?$/);


    if (match) {

      const id =
        match[1];

      const action =
        match[2] || '';

      const key =
        'sheet:' + id;

      const respKey =
        'resp:' + id;


      // ---------- one sheet ----------

      if (!action && method === 'GET') {

        const sheet =
          await storage.get(key);

        return sheet
          ? json(sheet)
          : json({ error: 'Not found' }, 404);

      }


      if (!action && method === 'PUT') {

        if (!admin) return json({ error: 'Admin only' }, 403);

        const body =
          await request.json().catch(() => null);

        if (!body || typeof body !== 'object' || !Array.isArray(body.rows)) {

          return json({ error: 'Invalid body' }, 400);

        }

        const previous =
          await storage.get(key);

        if (previous && previous.status === 'closed') {

          return json({ error: 'This day is closed – reopen it first' }, 409);

        }

        // durations only change through /duration: keep them by delivery key
        const kept = {};

        for (const r of (previous?.rows || [])) {

          if (r.key && r.duration) {

            kept[r.key] = { duration: r.duration, durationBy: r.durationBy, durationAt: r.durationAt };

          }

        }

        const rows =
          body.rows.slice(0, 40).map(r => {

            const k = String(r.key || '').slice(0, 400);

            return {
              key: k,
              kind: r.kind === 'OS' ? 'OS' : 'PP',
              number: String(r.number || '').slice(0, 30),
              event: r.event || null,
              duration: null,
              durationBy: null,
              durationAt: null,
              ...(k && kept[k] ? kept[k] : {})
            };

          });

        const now =
          new Date().toISOString();

        const sheet = {
          id,
          date: body.date || {},
          day: String(body.day || '').slice(0, 20),
          route: String(body.route || '').slice(0, 40),
          routeHex: String(body.routeHex || '').slice(0, 7),
          rows,
          signOut: String(body.signOut || '').slice(0, 100),
          signIn: String(body.signIn || '').slice(0, 100),
          status: 'open',
          createdBy: previous?.createdBy || name,
          createdAt: previous?.createdAt || now,
          updatedBy: name,
          updatedAt: now
        };

        await storage.put(key, sheet);

        return json(sheet);

      }


      if (!action && method === 'DELETE') {

        if (!admin) return json({ error: 'Admin only' }, 403);

        await storage.delete([key, respKey]);

        return json({ ok: true });

      }


      // ---------- delivery duration (everyone) ----------

      if (action === 'duration' && method === 'POST') {

        const body =
          await request.json().catch(() => ({}));

        const sheet =
          await storage.get(key);

        if (!sheet) return json({ error: 'Not found' }, 404);

        if (sheet.status === 'closed') {

          return json({ error: 'This day is closed' }, 409);

        }

        const row =
          (sheet.rows || []).find(r => r.key && r.key === body.key);

        if (!row) return json({ error: 'Delivery not on this sheet' }, 404);

        const minutes =
          body.minutes === '' || body.minutes === null ? null : Number(body.minutes);

        if (minutes !== null && !DURATIONS.has(minutes)) {

          return json({ error: 'Invalid duration' }, 400);

        }

        const now =
          new Date().toISOString();

        row.duration = minutes;
        row.durationBy = name;
        row.durationAt = now;

        await storage.put(key, sheet);

        const answers =
          (await storage.get(respKey)) || [];

        answers.push({
          key: row.key,
          ref: row.event?.title || [row.kind, row.number].filter(Boolean).join(' '),
          name,
          admin,
          minutes,
          at: now
        });

        await storage.put(respKey, answers.slice(-3000));

        return json({ ok: true, row });

      }


      // ---------- answers of the day (admin) ----------

      if (action === 'responses' && method === 'GET') {

        if (!admin) return json({ error: 'Admin only' }, 403);

        return json((await storage.get(respKey)) || []);

      }


      // ---------- close / reopen the day (admin) ----------

      if ((action === 'close' || action === 'reopen') && method === 'POST') {

        if (!admin) return json({ error: 'Admin only' }, 403);

        const sheet =
          await storage.get(key);

        if (!sheet) return json({ error: 'Not found' }, 404);

        if (action === 'close') {

          sheet.status = 'closed';
          sheet.closedBy = name;
          sheet.closedAt = new Date().toISOString();

        } else {

          sheet.status = 'open';
          sheet.closedBy = null;
          sheet.closedAt = null;

        }

        await storage.put(key, sheet);

        return json(sheet);

      }

    }


    return json({ error: 'Not found' }, 404);

  }

}


export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);


    if (url.pathname.startsWith('/api/')) {

      // Calendar push from Google needs the secret SYNC_KEY (or SYNC_TOKEN)
      if (url.pathname === '/api/calendar/sync') {

        const key =
          request.headers.get('x-sync-key') || '';

        const secret =
          env.SYNC_KEY || env.SYNC_TOKEN || '';

        if (!secret || key !== secret) {

          return json({ error: 'Wrong or missing sync key' }, 401);

        }

      }

      const id =
        env.SHEET_STORE.idFromName('main');

      return env.SHEET_STORE.get(id).fetch(request);

    }


    return env.ASSETS.fetch(request);

  }

};
