// =========================================
// GOOGLE CALENDAR (secret iCal address)
//
// Each calendar is read from its "Secret address in iCal format"
// (Google Calendar → Settings → calendar → Integrate calendar).
// Only called when the page opens or when Refresh is clicked.
// =========================================


const TIME_ZONE = 'Europe/Dublin';


// Order = priority (the calendars ticked in Google Calendar)
export const CALENDARS = [
  { id: 'warehouse', name: 'Warehouse/Deliveries', color: '#f09300', secret: 'CAL_WAREHOUSE' },
  { id: 'living-bray', name: 'Living Bray', color: '#3f51b5', secret: 'CAL_LIVING_BRAY' }
];


// ---------- ICS PARSING ----------

function unfold(text) {

  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');

}


function unescapeText(value) {

  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');

}


function parseLine(line) {

  const colon = line.indexOf(':');

  if (colon < 0) return null;

  const [name, ...params] = line.slice(0, colon).split(';');

  const opts = {};

  for (const p of params) {
    const [k, v] = p.split('=');
    opts[k.toUpperCase()] = v;
  }

  return { name: name.toUpperCase(), params: opts, value: line.slice(colon + 1) };

}


// Wall-clock parts in Dublin for a UTC instant
function dublinParts(date) {

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);

  const get = t => parts.find(p => p.type === t).value;

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`
  };

}


// Returns { date: 'YYYY-MM-DD', time: 'HH:MM' | null } in Dublin time
function parseDate(prop) {

  const v = prop.value.trim();

  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);

  if (!m) return null;

  const [, y, mo, d, h, mi, s, z] = m;

  if (!h) return { date: `${y}-${mo}-${d}`, time: null };

  if (z) return dublinParts(new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +s)));

  // TZID / floating: taken as local Dublin wall time
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };

}


function addDays(isoDate, days) {

  const d = new Date(isoDate + 'T12:00:00Z');

  d.setUTCDate(d.getUTCDate() + days);

  return d.toISOString().slice(0, 10);

}


const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };


// Dates (YYYY-MM-DD) an event falls on inside [from, to]
function occurrences(start, rrule, exdates, from, to) {

  if (!rrule) return (start.date >= from && start.date <= to) ? [start.date] : [];

  const rule = Object.fromEntries(
    rrule.split(';').map(p => p.split('='))
  );

  const freq = rule.FREQ;

  if (freq !== 'DAILY' && freq !== 'WEEKLY') {
    return (start.date >= from && start.date <= to) ? [start.date] : [];
  }

  const interval = Number(rule.INTERVAL || 1);
  const until = rule.UNTIL ? `${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}` : null;
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const days = rule.BYDAY
    ? rule.BYDAY.split(',').map(d => BYDAY[d.slice(-2)])
    : [new Date(start.date + 'T12:00:00Z').getUTCDay()];

  const out = [];
  let seen = 0;

  for (let day = start.date, i = 0; day <= to && i < 1500; day = addDays(day, 1), i++) {

    if (until && day > until) break;

    const diff = Math.round((Date.parse(day) - Date.parse(start.date)) / 86400000);

    let match;

    if (freq === 'DAILY') {
      match = diff % interval === 0;
    } else {
      const week = Math.floor(diff / 7);
      match = week % interval === 0 && days.includes(new Date(day + 'T12:00:00Z').getUTCDay());
    }

    if (!match) continue;

    seen++;

    if (seen > count) break;

    if (day >= from && !exdates.has(day)) out.push(day);

  }

  return out;

}


export function parseIcs(text, from, to) {

  const lines = unfold(text).split('\n');

  const events = [];

  let current = null;

  for (const line of lines) {

    if (line === 'BEGIN:VEVENT') { current = { exdates: new Set() }; continue; }

    if (line === 'END:VEVENT') {

      if (current?.start && current.status !== 'CANCELLED' && !current.recurrenceId) {

        for (const date of occurrences(current.start, current.rrule, current.exdates, from, to)) {

          events.push({
            date,
            start: current.start.time,
            end: current.end?.time || null,
            title: current.summary || '(no title)',
            description: current.description || '',
            location: current.location || ''
          });

        }

      }

      current = null;

      continue;

    }

    if (!current) continue;

    const prop = parseLine(line);

    if (!prop) continue;

    switch (prop.name) {
      case 'SUMMARY': current.summary = unescapeText(prop.value); break;
      case 'DESCRIPTION': current.description = unescapeText(prop.value).replace(/<[^>]+>/g, ' ').trim(); break;
      case 'LOCATION': current.location = unescapeText(prop.value); break;
      case 'DTSTART': current.start = parseDate(prop); break;
      case 'DTEND': current.end = parseDate(prop); break;
      case 'RRULE': current.rrule = prop.value; break;
      case 'STATUS': current.status = prop.value; break;
      case 'RECURRENCE-ID': current.recurrenceId = prop.value; break;
      case 'EXDATE':
        for (const v of prop.value.split(',')) {
          const d = parseDate({ value: v });
          if (d) current.exdates.add(d.date);
        }
        break;
    }

  }

  return events;

}


// ---------- FETCH ALL CALENDARS ----------

export async function loadCalendars(env, from, to) {

  const results = await Promise.all(CALENDARS.map(async cal => {

    const url = env[cal.secret];

    const base = { id: cal.id, name: cal.name, color: cal.color };

    if (!url) return { ...base, error: 'Not configured', events: [] };

    try {

      const res = await fetch(url, { cf: { cacheTtl: 60 } });

      if (!res.ok) return { ...base, error: 'HTTP ' + res.status, events: [] };

      return { ...base, events: parseIcs(await res.text(), from, to) };

    } catch (err) {

      return { ...base, error: 'Fetch failed', events: [] };

    }

  }));

  return results;

}
