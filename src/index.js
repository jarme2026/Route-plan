// =========================================
// DELIVERY SHEET - Cloudflare Worker
//
// Static page served from ./public (ASSETS)
// Sheets + access log kept in one Durable Object
// =========================================

import { loadCalendars } from './calendar.js';


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


    // Calendar is read straight from Google (no Durable Object)
    if (url.pathname === '/api/calendar' && request.method === 'GET') {

      if (!userName(request)) return json({ error: 'Name required' }, 401);

      const iso = /^\d{4}-\d{2}-\d{2}$/;
      const today = new Date().toISOString().slice(0, 10);
      const shift = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

      const from = iso.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : shift(today, -7);
      const to = iso.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : shift(today, 45);

      return json({ from, to, calendars: await loadCalendars(env, from, to) });

    }


    if (url.pathname.startsWith('/api/')) {

      const id =
        env.SHEET_STORE.idFromName('main');

      return env.SHEET_STORE.get(id).fetch(request);

    }


    return env.ASSETS.fetch(request);

  }

};
