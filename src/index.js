// =========================================
// ROUTE PLAN - Cloudflare Worker
//
// Static page served from ./public (ASSETS)
// Sheets, duration answers, calendar and access log kept in one Durable Object
//
// Access:
//   Closed site – two passwords:
//     ADMIN_PASSWORD -> admin: everything
//     TEAM_PASSWORD  -> team (optional secret): read only, route preview of saved sheets
//   Every /api request without a valid token is refused. Exceptions: the login itself and
//   the Apps Script endpoints (protected by the sync key).
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


// Team token = SHA-256 of the team password (secret TEAM_PASSWORD, optional)
async function teamToken(env) {

  if (!env.TEAM_PASSWORD || env.TEAM_PASSWORD === env.ADMIN_PASSWORD) return '';

  const data =
    new TextEncoder().encode('route-plan-team:' + env.TEAM_PASSWORD);

  const hash =
    await crypto.subtle.digest('SHA-256', data);

  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');

}


// 'admin' | 'team' | ''  (from the token the page sends)
async function roleOf(request, env) {

  const sent =
    request.headers.get('x-admin-token') || '';

  if (!sent) return '';

  const admin = await adminToken(env);
  if (admin && sent === admin) return 'admin';

  const team = await teamToken(env);
  if (team && sent === team) return 'team';

  return '';

}


// Apps Script web app address ('' if not one)
function validSyncUrl(v) {

  const t = String(v || '').trim();

  return /^https:\/\/script\.google\.com\/[\w\-./]+\/(exec|dev)$/.test(t) ? t.slice(0, 300) : '';

}


// Area typed by the admin -> text Google Maps finds reliably
//   "D06" / "D6" / "d06 rpl" -> "Dublin 6, Ireland"     "D16X957K" -> "D16 X957K, Ireland"
//   "Dundrum" -> "Dundrum, Ireland"                       (texts with "Ireland" stay as they are)
function normalizeArea(v) {

  const t = String(v || '').trim().replace(/\s+/g, ' ').slice(0, 200);

  if (!t) return '';

  const eir = t.match(/^([AC-FHKNPRTV-Y]\d{2}|D6W)\s?([0-9AC-FHKNPRTV-Y]{4})$/i);
  if (eir) return (eir[1] + ' ' + eir[2]).toUpperCase() + ', Ireland';

  const dub = t.match(/^D\s?0?(\d{1,2})(W)?(?:\s|$)/i);
  if (dub) return 'Dublin ' + Number(dub[1]) + (dub[2] ? 'W' : '') + ', Ireland';

  return /ireland/i.test(t) ? t : t + ', Ireland';

}


// "lat,lng" text or ''
function coordText(v) {

  const t = String(v || '').replace(/\s+/g, '');

  return /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/.test(t) ? t.slice(0, 40) : '';

}


// [lat, lng] or null
function point(p) {

  return Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
    ? [p[0], p[1]]
    : null;

}


// One driving leg: time, distance and map data
function cleanLeg(l) {

  return {
    minutes: Number.isFinite(l?.minutes) ? l.minutes : null,
    km: Number.isFinite(l?.km) ? l.km : null,
    a: point(l?.a),
    b: point(l?.b),
    poly: typeof l?.poly === 'string' ? l.poly.slice(0, 20000) : ''
  };

}


// Planned minutes of a delivery = length of its calendar event
function plannedMinutes(ev) {

  if (!ev || ev.allDay || !ev.start || !ev.end) return null;

  const m = t => {
    const [h, mi] = String(t).split(':').map(Number);
    return h * 60 + mi;
  };

  const d = m(ev.end) - m(ev.start);

  return Number.isFinite(d) && d > 0 ? d : null;

}


// Route saved with the sheet (so the team sees the preview without calendar access)
function cleanPlan(plan) {

  if (!plan || typeof plan !== 'object') return null;

  const legs = {};

  for (const [k, l] of Object.entries(plan.legs || {}).slice(0, 60)) {

    legs[String(k).slice(0, 420)] = cleanLeg(l);

  }

  // trips in sheet order still to be worked out by the Apps Script
  const need = (Array.isArray(plan.need) ? plan.need : [])
    .slice(0, 40)
    .filter(p => Array.isArray(p) && p.length === 2 && p[0] && p[1])
    .map(p => [String(p[0]).slice(0, 200), String(p[1]).slice(0, 200)]);

  const out = {
    warehouse: String(plan.warehouse || '').slice(0, 200),
    warehouseCoords: coordText(plan.warehouseCoords),
    legs,
    need
  };

  // keep it small: drop the road paths if too big
  if (JSON.stringify(out).length > 300000) {

    for (const l of Object.values(out.legs)) l.poly = '';

  }

  return out;

}


// Short summary of a sheet for the list
function summary(sheet) {

  // deliveries only (the lunch break is not a delivery)
  const rows =
    (sheet.rows || []).filter(r => r.key && !(r.event && r.event.lunch));

  return {
    id: sheet.id,
    date: sheet.date,
    day: sheet.day,
    route: sheet.route,
    routeHex: sheet.routeHex,
    status: sheet.status || 'open',
    deliveries: rows.length,
    answered: rows.filter(r => r.duration).length,
    flags: rows.filter(r => {
      const planned = plannedMinutes(r.event);
      return r.duration && planned && r.duration !== planned;
    }).length,
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

    const role =
      await roleOf(request, this.env);

    const admin =
      role === 'admin';

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
          place: clean(ev.place, 200),
          coords: coordText(ev.coords),
          minutes: Number(ev.minutes) || 0
        };

        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;

        (byDay[e.date] ||= []).push(e);

      }

      // driving times between places, per day: { "from→to": { minutes, km } }
      const legsByDay = {};

      for (const l of (Array.isArray(body.legs) ? body.legs : []).slice(0, 3000)) {

        const date = clean(l.date, 10);

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

        (legsByDay[date] ||= {})[clean(l.from, 200) + '→' + clean(l.to, 200)] = cleanLeg(l);

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

      const legEntries =
        Object.entries(legsByDay);

      for (let i = 0; i < legEntries.length; i += 100) {

        await storage.put(
          Object.fromEntries(legEntries.slice(i, i + 100).map(([d, legs]) => ['legs:' + d, legs]))
        );

      }

      const stale = [
        ...(previous.days || []).filter(d => !byDay[d]).map(d => 'cal:' + d),
        ...(previous.legDays || []).filter(d => !legsByDay[d]).map(d => 'legs:' + d)
      ];

      for (let i = 0; i < stale.length; i += 100) {

        await storage.delete(stale.slice(i, i + 100));

      }

      const calendarColor =
        /^#[0-9a-f]{6}$/i.test(body.calendarColor || '') ? body.calendarColor : '';

      await storage.put('calendar-meta', {
        syncedAt: new Date().toISOString(),
        calendarColor,
        warehouse: clean(body.warehouse, 200),
        warehouseCoords: coordText(body.warehouseCoords),
        // web app address of the Apps Script (website "Sync calendar" button);
        // a link pasted by the admin on the website always wins
        syncUrl: previous.syncUrlManual
          ? previous.syncUrl
          : (validSyncUrl(body.syncUrl) || previous.syncUrl || ''),
        syncUrlManual: !!previous.syncUrlManual,
        days,
        legDays: Object.keys(legsByDay)
      });

      await storage.delete('calendar');   // old single-key format

      return json({
        ok: true,
        count: entries.reduce((n, [, evs]) => n + evs.length, 0),
        days: days.length,
        legs: legEntries.reduce((n, [, legs]) => n + Object.keys(legs).length, 0)
      });

    }


    // ---------- AREAS SET BY THE ADMIN (read by the Apps Script) ----------

    if (path === '/api/calendar/overrides' && method === 'GET') {

      const raw = (await storage.get('place-overrides')) || {};

      return json(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, normalizeArea(v)])));

    }


    // ---------- TRIPS THE SAVED SHEETS NEED (read by the Apps Script) ----------
    // [{ date, from, to }] for open sheets from yesterday on, in sheet order

    if (path === '/api/calendar/requests' && method === 'GET') {

      const since =
        new Date(Date.now() - 86400000).toISOString().slice(0, 10);

      const out = [];
      const seen = new Set();

      for (const sheet of (await storage.list({ prefix: 'sheet:' })).values()) {

        const d = sheet.date || {};

        if (!d.year || sheet.status === 'closed') continue;

        const date = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

        if (date < since) continue;

        for (const [from, to] of (sheet.plan?.need || [])) {

          const k = date + '|' + from + '→' + to;

          if (seen.has(k)) continue;

          seen.add(k);
          out.push({ date, from, to });

        }

      }

      return json(out.slice(0, 1000));

    }


    // ---------- ADMIN LOGIN ----------

    if (path === '/api/admin/login' && method === 'POST') {

      if (!this.env.ADMIN_PASSWORD) {

        return json({ error: 'ADMIN_PASSWORD is not set in Cloudflare' }, 503);

      }

      // max 5 wrong passwords per 15 minutes from the same address
      const ip =
        request.headers.get('cf-connecting-ip') || 'unknown';

      const failKey =
        'login-fail:' + ip;

      const fails =
        ((await storage.get(failKey)) || []).filter(t => t > Date.now() - 15 * 60000);

      if (fails.length >= 5) {

        return json({ error: 'Too many wrong passwords – try again in 15 minutes' }, 429);

      }

      const body =
        await request.json().catch(() => ({}));

      const typed = body.password || '';

      // admin password first, then the team password (TEAM_PASSWORD, optional)
      let token = '', who = '';

      if (typed === this.env.ADMIN_PASSWORD) {
        token = await adminToken(this.env);
        who = 'admin';
      } else if (this.env.TEAM_PASSWORD && typed === this.env.TEAM_PASSWORD) {
        token = await teamToken(this.env);
        who = 'team';
      }

      if (!token) {

        fails.push(Date.now());
        await storage.put(failKey, fails);

        return json({ error: 'Wrong password' }, 401);

      }

      await storage.delete(failKey);

      return json({ token, role: who });

    }


    // the site is closed: everything below needs the admin or the team password
    // (team = read only: list + open sheets; every change is checked as admin below)
    if (!role) {

      return json({ error: 'Password required' }, 401);

    }

    if (!name) {

      return json({ error: 'Name required' }, 401);

    }


    if (path === '/api/me' && method === 'GET') {

      const meta =
        admin ? ((await storage.get('calendar-meta')) || {}) : {};

      return json({ name, admin, role, syncUrl: admin ? (meta.syncUrl || '') : '' });

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


    // ---------- SYNC LINK pasted by the admin ----------

    if (path === '/api/sync-url' && method === 'PUT') {

      if (!admin) return json({ error: 'Admin only' }, 403);

      const body =
        await request.json().catch(() => ({}));

      const link = validSyncUrl(body.url);

      if (body.url && !link) {

        return json({ error: 'Not an Apps Script web app link (…script.google.com/…/exec)' }, 400);

      }

      const meta =
        (await storage.get('calendar-meta')) || {};

      meta.syncUrl = link;
      meta.syncUrlManual = !!link;

      await storage.put('calendar-meta', meta);

      return json({ ok: true, syncUrl: link });

    }


    // ---------- AREA FOR GOOGLE MAPS (admin) ----------
    // key = "YYYY-MM-DD|event title"; empty place removes it

    if (path === '/api/places' && method === 'PUT') {

      if (!admin) return json({ error: 'Admin only' }, 403);

      const body =
        await request.json().catch(() => ({}));

      const date = String(body.date || '').slice(0, 10);
      const title = String(body.title || '').trim().slice(0, 300);
      const place = normalizeArea(body.place);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) {

        return json({ error: 'date and title required' }, 400);

      }

      const all =
        (await storage.get('place-overrides')) || {};

      const k = date + '|' + title;

      if (place) all[k] = place;
      else delete all[k];

      // forget areas of days more than 30 days ago
      const limit =
        new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

      for (const key of Object.keys(all)) {

        if (key.slice(0, 10) < limit) delete all[key];

      }

      await storage.put('place-overrides', all);

      return json({ ok: true, key: k, place });

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

      const overrides =
        (await storage.get('place-overrides')) || {};

      const events =
        ((await storage.get('cal:' + date)) || [])
          .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
          .map(e => {
            const area = normalizeArea(overrides[date + '|' + String(e.title || '').trim()]);
            if (!area) return e;
            // new area not synced yet: its old map point is no longer valid
            return e.place === area
              ? { ...e, areaSet: true }
              : { ...e, place: area, coords: '', areaSet: true };
          });

      return json({
        syncedAt: meta.syncedAt || null,
        calendarColor: meta.calendarColor || '',
        warehouse: meta.warehouse || '',
        warehouseCoords: meta.warehouseCoords || '',
        syncUrl: meta.syncUrl || '',
        legs: (await storage.get('legs:' + date)) || {},
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
          plan: cleanPlan(body.plan),
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


      // ---------- delivery duration (admin) ----------

      if (action === 'duration' && method === 'POST') {

        if (!admin) return json({ error: 'Admin only' }, 403);

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
      if (['/api/calendar/sync', '/api/calendar/overrides', '/api/calendar/requests'].includes(url.pathname)) {

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
