// =========================================
// DELIVERY SHEET - Cloudflare Worker
//
// Static page served from ./public (ASSETS)
// Sheets, calendar and access log kept in one Durable Object
//
// Roles
//   admin: password (secret ADMIN_PASSWORD) - edits everything,
//          chooses which sheets the team can see
//   staff: name only - sees the visible sheets, changes only
//          Time in / Time out
// =========================================

import { loadCalendars } from './calendar.js';


const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

const ROWS = 9;

const ADMIN_TOKEN_DAYS = 30;

// 30 minutes -> 6 hours, every 15 minutes
const DURATIONS = new Set();

for (let m = 30; m <= 360; m += 15) DURATIONS.add(String(m));


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
    return '';
  }

}


function cleanDuration(value) {

  const v = String(value ?? '');

  return DURATIONS.has(v) ? v : '';

}


function text(value, max = 200) {

  return String(value ?? '').slice(0, max);

}


// ---------- ADMIN TOKEN (stateless, signed with ADMIN_PASSWORD) ----------

const encoder = new TextEncoder();


function safeEqual(a, b) {

  if (a.length !== b.length) return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return diff === 0;

}


async function sign(secret, message) {

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));

  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');

}


async function makeAdminToken(env) {

  const exp = Date.now() + ADMIN_TOKEN_DAYS * 86400000;

  return exp + '.' + await sign(env.ADMIN_PASSWORD, 'admin:' + exp);

}


async function isAdmin(request, env) {

  const token = request.headers.get('x-admin-token') || '';

  if (!env.ADMIN_PASSWORD || !token.includes('.')) return false;

  const [exp, sig] = token.split('.');

  if (!(Number(exp) > Date.now())) return false;

  return safeEqual(sig, await sign(env.ADMIN_PASSWORD, 'admin:' + exp));

}


// =========================================
// DURABLE OBJECT
// =========================================

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

    // x-role is set only by the Worker after checking the admin token
    const admin =
      request.headers.get('x-role') === 'admin';


    // ---------- CALENDAR (pushed by Google Apps Script) ----------

    if (path === '/api/calendar-sync' && method === 'POST') {

      const body =
        await request.json().catch(() => null);

      if (!body || !Array.isArray(body.calendars)) {

        return json({ error: 'Invalid body' }, 400);

      }

      const data = {
        from: body.from || null,
        to: body.to || null,
        calendars: body.calendars,
        syncedAt: new Date().toISOString()
      };

      await this.ctx.storage.put('calendar', data);

      return json({ ok: true, syncedAt: data.syncedAt });

    }


    const name =
      userName(request);


    if (!name) {

      return json({ error: 'Name required' }, 401);

    }


    if (path === '/api/calendar' && method === 'GET') {

      if (!admin) return json({ error: 'Admin only' }, 403);

      return json(
        (await this.ctx.storage.get('calendar')) || { calendars: null }
      );

    }


    // ---------- ACCESS LOG ----------

    if (path === '/api/hello' && method === 'POST') {

      const log =
        (await this.ctx.storage.get('access-log')) || [];

      log.unshift({ name, role: admin ? 'admin' : 'staff', at: new Date().toISOString() });

      await this.ctx.storage.put('access-log', log.slice(0, 200));

      return json({ ok: true, name, admin });

    }


    if (path === '/api/access-log' && method === 'GET') {

      if (!admin) return json({ error: 'Admin only' }, 403);

      return json(
        (await this.ctx.storage.get('access-log')) || []
      );

    }


    // ---------- SHEETS ----------

    if (path === '/api/sheets' && method === 'GET') {

      const entries =
        await this.ctx.storage.list({ prefix: 'sheet:' });

      const list = [];

      for (const sheet of entries.values()) {

        if (!admin && !sheet.visible) continue;

        list.push({
          id: sheet.id,
          date: sheet.date,
          day: sheet.day,
          team: sheet.team,
          visible: !!sheet.visible,
          createdBy: sheet.createdBy,
          updatedBy: sheet.updatedBy,
          updatedAt: sheet.updatedAt
        });

      }

      list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

      return json(list);

    }


    const match =
      path.match(/^\/api\/sheets\/([A-Za-z0-9-]{1,64})(\/times|\/visibility)?$/);


    if (!match) return json({ error: 'Not found' }, 404);


    const key =
      'sheet:' + match[1];

    const action =
      match[2] || '';

    const previous =
      await this.ctx.storage.get(key);

    const now =
      new Date().toISOString();


    // Staff only reach sheets the admin made visible
    if (!admin && (!previous || !previous.visible)) {

      return json({ error: 'Not available' }, 404);

    }


    // ---------- GET ONE ----------

    if (!action && method === 'GET') {

      return previous
        ? json(previous)
        : json({ error: 'Not found' }, 404);

    }


    // ---------- TIMES (admin + staff) ----------

    if (action === '/times' && method === 'PATCH') {

      if (!previous) return json({ error: 'Not found' }, 404);

      const body =
        await request.json().catch(() => null);

      const row =
        Number(body?.row);

      if (!Number.isInteger(row) || row < 0 || row >= ROWS) {

        return json({ error: 'Invalid row' }, 400);

      }

      const rows =
        Array.from({ length: ROWS }, (_, i) => ({ ...(previous.rows?.[i] || {}) }));

      rows[row].timeIn = cleanDuration(body.timeIn);
      rows[row].timeOut = cleanDuration(body.timeOut);
      rows[row].timeBy = name;
      rows[row].timeAt = now;

      const sheet = { ...previous, rows, updatedBy: name, updatedAt: now };

      await this.ctx.storage.put(key, sheet);

      return json(sheet);

    }


    // Everything below is admin only
    if (!admin) return json({ error: 'Admin only' }, 403);


    // ---------- VISIBILITY ----------

    if (action === '/visibility' && method === 'POST') {

      if (!previous) return json({ error: 'Save the sheet first' }, 404);

      const body =
        await request.json().catch(() => ({}));

      const sheet = { ...previous, visible: !!body.visible };

      await this.ctx.storage.put(key, sheet);

      return json(sheet);

    }


    // ---------- SAVE WHOLE SHEET ----------

    if (!action && method === 'PUT') {

      const body =
        await request.json().catch(() => null);

      if (!body || typeof body !== 'object') {

        return json({ error: 'Invalid body' }, 400);

      }

      const prevRows =
        previous?.rows || [];

      // Times changed by the team since the admin opened the sheet are kept:
      // the admin only overwrites the rows whose times it changed (timesDirty)
      const rows = Array.from({ length: ROWS }, (_, i) => {

        const r = body.rows?.[i] || {};
        const p = prevRows[i] || {};
        const own = !!r.timesDirty;

        return {
          kind: r.kind === 'OS' ? 'OS' : 'PP',
          number: text(r.number, 80),
          timeIn: own ? cleanDuration(r.timeIn) : (p.timeIn || ''),
          timeOut: own ? cleanDuration(r.timeOut) : (p.timeOut || ''),
          timeBy: own ? name : p.timeBy,
          timeAt: own ? now : p.timeAt
        };

      });

      const sheet = {
        id: match[1],
        date: body.date || {},
        day: text(body.day, 20),
        message: text(body.message),
        team: (body.team || []).slice(0, 2).map(t => text(t, 60)),
        vans: body.vans || {},
        rows,
        signOut: text(body.signOut, 60),
        signIn: text(body.signIn, 60),
        visible: !!previous?.visible,
        createdBy: previous?.createdBy || name,
        createdAt: previous?.createdAt || now,
        updatedBy: name,
        updatedAt: now
      };

      await this.ctx.storage.put(key, sheet);

      return json(sheet);

    }


    if (!action && method === 'DELETE') {

      await this.ctx.storage.delete(key);

      return json({ ok: true });

    }


    return json({ error: 'Not found' }, 404);

  }

}


// =========================================
// WORKER
// =========================================

function store(env) {

  return env.SHEET_STORE.get(
    env.SHEET_STORE.idFromName('main')
  );

}


export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);


    if (!url.pathname.startsWith('/api/')) {

      return env.ASSETS.fetch(request);

    }


    // Google Apps Script pushes the events here (x-sync-token = SYNC_TOKEN)
    if (url.pathname === '/api/calendar-sync') {

      const token =
        request.headers.get('x-sync-token') || '';

      if (request.method !== 'POST' || !env.SYNC_TOKEN || !safeEqual(token, env.SYNC_TOKEN)) {

        return json({ error: 'Unauthorized' }, 401);

      }

      if (Number(request.headers.get('content-length') || 0) > 1_000_000) {

        return json({ error: 'Too large' }, 413);

      }

      return store(env).fetch(request);

    }


    // ---------- ADMIN LOGIN ----------

    if (url.pathname === '/api/admin/login' && request.method === 'POST') {

      if (!env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD not configured' }, 503);

      const body =
        await request.json().catch(() => ({}));

      if (!safeEqual(String(body.password || ''), env.ADMIN_PASSWORD)) {

        // slow down guessing
        await new Promise(resolve => setTimeout(resolve, 1000));

        return json({ error: 'Wrong password' }, 401);

      }

      return json({ token: await makeAdminToken(env) });

    }


    const admin =
      await isAdmin(request, env);


    if (url.pathname === '/api/me' && request.method === 'GET') {

      return json({ admin });

    }


    // Role header is always rebuilt here, never trusted from the browser
    const headers =
      new Headers(request.headers);

    headers.delete('x-role');

    if (admin) headers.set('x-role', 'admin');

    const forwarded =
      new Request(request, { headers });


    if (url.pathname === '/api/calendar' && request.method === 'GET') {

      if (!userName(request)) return json({ error: 'Name required' }, 401);

      if (!admin) return json({ error: 'Admin only' }, 403);

      // 1) events pushed by Apps Script
      const stored =
        await (await store(env).fetch(forwarded)).json();

      if (stored.calendars) return json(stored);

      // 2) fallback: read Google directly (secret iCal / public script URL)
      const today = new Date().toISOString().slice(0, 10);
      const shift = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

      const from = shift(today, -7);
      const to = shift(today, 45);

      return json({ from, to, calendars: await loadCalendars(env, from, to) });

    }


    return store(env).fetch(forwarded);

  }

};
