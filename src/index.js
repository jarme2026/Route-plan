// =========================================
// DELIVERY SHEET - Cloudflare Worker
//
// Static page served from ./public (ASSETS)
// Sheets + access log kept in one Durable Object
// =========================================


const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};


function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    { status, headers: JSON_HEADERS }
  );

}


function userName(request) {

  const raw =
    request.headers.get('x-user-name') || '';

  return decodeURIComponent(raw).trim().slice(0, 60);

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


    // ---------- CALENDAR SYNC (from Google Apps Script) ----------
    // Key already checked in the Worker before reaching here.

    if (path === '/api/calendar/sync' && method === 'POST') {

      const body =
        await request.json().catch(() => null);

      if (!body || !Array.isArray(body.events)) {

        return json({ error: 'Invalid body' }, 400);

      }

      const clean = v => String(v ?? '').slice(0, 300);

      const events =
        body.events.slice(0, 3000).map(ev => ({
          date: clean(ev.date).slice(0, 10),
          start: clean(ev.start).slice(0, 5),
          end: clean(ev.end).slice(0, 5),
          allDay: !!ev.allDay,
          title: clean(ev.title),
          location: clean(ev.location),
          kind: ev.kind === 'OS' ? 'OS' : (ev.kind === 'PP' ? 'PP' : ''),
          number: clean(ev.number).slice(0, 30),
          minutes: Number(ev.minutes) || 0
        }));

      await this.ctx.storage.put('calendar', {
        syncedAt: new Date().toISOString(),
        events
      });

      return json({ ok: true, count: events.length });

    }


    if (!name) {

      return json({ error: 'Name required' }, 401);

    }


    // ---------- ACCESS LOG ----------

    if (path === '/api/hello' && method === 'POST') {

      const log =
        (await this.ctx.storage.get('access-log')) || [];

      log.unshift({ name, at: new Date().toISOString() });

      await this.ctx.storage.put('access-log', log.slice(0, 200));

      return json({ ok: true, name });

    }


    if (path === '/api/access-log' && method === 'GET') {

      return json(
        (await this.ctx.storage.get('access-log')) || []
      );

    }


    // ---------- CALENDAR (events of one day) ----------

    if (path === '/api/calendar' && method === 'GET') {

      const date =
        url.searchParams.get('date') || '';

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {

        return json({ error: 'date must be YYYY-MM-DD' }, 400);

      }

      const cal =
        (await this.ctx.storage.get('calendar')) || { syncedAt: null, events: [] };

      const events =
        cal.events
          .filter(ev => ev.date === date)
          .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

      return json({ syncedAt: cal.syncedAt, date, events });

    }


    // ---------- SHEETS ----------

    if (path === '/api/sheets' && method === 'GET') {

      const entries =
        await this.ctx.storage.list({ prefix: 'sheet:' });

      const list = [];

      for (const sheet of entries.values()) {

        list.push({
          id: sheet.id,
          date: sheet.date,
          day: sheet.day,
          team: sheet.team,
          createdBy: sheet.createdBy,
          updatedBy: sheet.updatedBy,
          updatedAt: sheet.updatedAt
        });

      }

      list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

      return json(list);

    }


    const match =
      path.match(/^\/api\/sheets\/([A-Za-z0-9-]{1,64})$/);


    if (match) {

      const key =
        'sheet:' + match[1];


      if (method === 'GET') {

        const sheet =
          await this.ctx.storage.get(key);

        return sheet
          ? json(sheet)
          : json({ error: 'Not found' }, 404);

      }


      if (method === 'PUT') {

        const body =
          await request.json().catch(() => null);

        if (!body || typeof body !== 'object') {

          return json({ error: 'Invalid body' }, 400);

        }

        const previous =
          await this.ctx.storage.get(key);

        const now =
          new Date().toISOString();

        const sheet = {
          ...body,
          id: match[1],
          createdBy: previous?.createdBy || name,
          createdAt: previous?.createdAt || now,
          updatedBy: name,
          updatedAt: now
        };

        await this.ctx.storage.put(key, sheet);

        return json(sheet);

      }


      if (method === 'DELETE') {

        await this.ctx.storage.delete(key);

        return json({ ok: true });

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

      // Calendar push from Google needs the secret SYNC_KEY
      if (url.pathname === '/api/calendar/sync') {

        const key =
          request.headers.get('x-sync-key') || '';

        if (!env.SYNC_KEY || key !== env.SYNC_KEY) {

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
