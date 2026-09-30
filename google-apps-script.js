// =========================================
// GOOGLE APPS SCRIPT  (Extensions -> Apps Script, or a standalone script)
//
// Every 5 minutes (trigger on atualizarPlanilha):
//   1. writes the calendar events into the "Events" tab (if SHEET_ID / sheet is set)
//   2. works out the driving time between the deliveries of each route (Google Maps)
//   3. sends events + driving times to the Route Plan website
// =========================================

const CAL_ID = 'bray@living.ie';

const DIAS_ATRAS = 7;      // also send the last 7 days (to reopen recent sheets)
const DIAS_FRENTE = 21;    // and the next 21 days

const WORKER_URL = 'https://route-plan.YOUR-ACCOUNT.workers.dev/api/calendar/sync';
const SYNC_KEY = 'the-same-secret-you-put-in-cloudflare';

const TZ = 'Europe/Dublin';

// Google Sheet that gets the "Events" tab.
// Only needed if this script was NOT opened from the sheet (Extensions -> Apps Script).
// It's the long code in the sheet link: docs.google.com/spreadsheets/d/THIS-PART/edit
// Leave '' to skip the sheet and only send the events to the website.
const SHEET_ID = '';

// ---------- DRIVING TIMES ----------
// Warehouse: where every route starts and ends (address or Eircode).
// Leave '' to count only the time between deliveries.
const ARMAZEM = 'A94 HX83';

// Driving times are worked out for yesterday up to this many days ahead
const DIAS_ROTAS = 7;


function atualizarPlanilha() {

  const cal = CalendarApp.getCalendarById(CAL_ID);

  const inicio = new Date();
  inicio.setHours(0, 0, 0, 0);
  inicio.setDate(inicio.getDate() - DIAS_ATRAS);

  const fim = new Date(inicio);
  fim.setDate(fim.getDate() + DIAS_ATRAS + DIAS_FRENTE);

  const eventos = cal.getEvents(inicio, fim);

  const fmt = (d, p) => Utilities.formatDate(d, TZ, p);


  // ---------- 1. GOOGLE SHEET ----------

  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss ? (ss.getSheetByName('Events') || ss.insertSheet('Events')) : null;

  const linhas = eventos.map(ev => {
    const ref = lerReferencia_(ev);
    return [
      fmt(ev.getStartTime(), 'dd/MM/yyyy'),
      fmt(ev.getStartTime(), 'HH:mm'),
      fmt(ev.getEndTime(), 'HH:mm'),
      ev.getTitle(),
      ev.getLocation(),
      ev.getDescription(),
      ev.isAllDayEvent() ? 'Yes' : 'No',
      ref.kind ? ref.kind + ' ' + ref.number : '',
      ev.getColor() || 'default',
      lugar_(ev)
    ];
  });

  if (sh) {
    sh.clearContents();
    sh.getRange(1, 1, 1, 10).setValues([['Date', 'Start', 'End', 'Title', 'Location', 'Description', 'All day', 'PP/OS', 'Colour id', 'Maps place']]);
    if (linhas.length) sh.getRange(2, 1, linhas.length, 10).setValues(linhas);
    sh.getRange('L1').setValue('Last update: ' + fmt(new Date(), 'dd/MM/yyyy HH:mm'));
  }


  // ---------- 2. EVENTS FOR THE WEBSITE ----------

  const payload = eventos.map(ev => {
    const ref = lerReferencia_(ev);
    return {
      date: fmt(ev.getStartTime(), 'yyyy-MM-dd'),
      start: fmt(ev.getStartTime(), 'HH:mm'),
      end: fmt(ev.getEndTime(), 'HH:mm'),
      allDay: ev.isAllDayEvent(),
      title: ev.getTitle(),
      location: ev.getLocation(),
      description: ev.getDescription(),
      colorId: ev.getColor() || '',
      kind: ref.kind,
      number: ref.number,
      place: lugar_(ev),
      minutes: Math.round((ev.getEndTime() - ev.getStartTime()) / 60000)
    };
  });


  // ---------- 3. DRIVING TIMES (per day and colour, in time order) ----------

  const legs = calcularTrajetos_(payload);


  // ---------- 4. SEND ----------

  const res = UrlFetchApp.fetch(WORKER_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sync-key': SYNC_KEY },
    payload: JSON.stringify({
      events: payload,
      calendarColor: cal.getColor(),
      warehouse: ARMAZEM,
      legs: legs.list
    }),
    muteHttpExceptions: true
  });

  const result = 'Worker: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 100) +
    ' | driving times: ' + legs.list.length + (legs.stopped ? ' (Maps limit reached, rest next run)' : '');

  Logger.log(result);
  if (sh) sh.getRange('L2').setValue(result);

}


// Helper (the "_" at the end hides it from the Run menu).
// Finds "PP 12345", "PP-12345", "OS:6789", "os 6789"... in the title, then in the description
function lerReferencia_(ev) {

  if (!ev) return { kind: '', number: '' };

  const texto = (ev.getTitle() || '') + '\n' + (ev.getDescription() || '');
  const m = texto.match(/\b(PP|OS)\s*[-:#.]?\s*(\d{3,})/i);

  return m ? { kind: m[1].toUpperCase(), number: m[2] } : { kind: '', number: '' };

}


// Place Google Maps should look for. Best first:
//   1. the event's Location field
//   2. a full Eircode in the title / description (e.g. D04 X2Y3)
//   3. the area at the start of the title: "D04 pp26159 ..." -> "Dublin 4, Ireland"
//                                          "Malahide pp26347 ..." -> "Malahide, Ireland"
function lugar_(ev) {

  const loc = (ev.getLocation() || '').trim();
  if (loc) return loc;

  const title = ev.getTitle() || '';
  const desc = (ev.getDescription() || '').replace(/<[^>]+>/g, ' ');

  const eircode = (title + ' ' + desc).match(/\b([AC-FHKNPRTV-Y]\d{2}|D6W)\s?[0-9AC-FHKNPRTV-Y]{4}\b/i);
  if (eircode) return eircode[0].toUpperCase() + ', Ireland';

  const area = title
    .split(/\b(?:PP|OS)\s*[-:#.]?\s*\d/i)[0]
    .replace(/[\s,\-–:]+$/, '')
    .trim();

  if (!area || /^\d+\s*vans?$/i.test(area)) return '';

  const dublin = area.match(/^D\s?0?(\d{1,2})(W)?$/i);
  if (dublin) return 'Dublin ' + Number(dublin[1]) + (dublin[2] ? 'W' : '') + ', Ireland';

  return area + ', Ireland';

}


// Same events the website ignores
function ignorado_(e) {

  const t = (e.title || '').trim();
  if (!t || /^\(no title\)$/i.test(t)) return true;
  if (/^\d+\s*vans?$/i.test(t)) return true;
  if (/^\p{L}\.?\s*\p{L}\.?$/u.test(t)) return true;
  return false;

}


// Driving time between consecutive deliveries of each route (same day + same colour),
// plus warehouse -> first and last -> warehouse. Results are cached for 6 hours.
function calcularTrajetos_(events) {

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const de = Utilities.formatDate(new Date(hoje.getTime() - 86400000), TZ, 'yyyy-MM-dd');
  const ate = Utilities.formatDate(new Date(hoje.getTime() + DIAS_ROTAS * 86400000), TZ, 'yyyy-MM-dd');

  // group: day + colour
  const grupos = {};

  events.forEach(e => {
    if (e.date < de || e.date > ate || e.allDay || !e.place || ignorado_(e)) return;
    const k = e.date + '|' + (e.colorId || 'default');
    (grupos[k] = grupos[k] || []).push(e);
  });

  // pairs to work out
  const pares = [];
  const vistos = {};

  const juntar = (date, from, to) => {
    if (!from || !to || from === to) return;
    const k = date + '|' + from + '→' + to;
    if (vistos[k]) return;
    vistos[k] = true;
    pares.push({ date, from, to });
  };

  Object.keys(grupos).forEach(k => {
    const lista = grupos[k].sort((a, b) => a.start.localeCompare(b.start));
    const date = lista[0].date;
    if (ARMAZEM) juntar(date, ARMAZEM, lista[0].place);
    for (let i = 1; i < lista.length; i++) juntar(date, lista[i - 1].place, lista[i].place);
    if (ARMAZEM) juntar(date, lista[lista.length - 1].place, ARMAZEM);
  });

  // cache
  const cache = CacheService.getScriptCache();
  const chave = p => 'leg2:' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, p.from + '→' + p.to));

  const guardados = {};
  for (let i = 0; i < pares.length; i += 100) {
    Object.assign(guardados, cache.getAll(pares.slice(i, i + 100).map(chave)));
  }

  const list = [];
  const novos = {};
  let stopped = false;

  pares.forEach(p => {

    const k = chave(p);
    let r = guardados[k] || novos[k];

    if (!r && !stopped) {
      try {
        const dir = Maps.newDirectionFinder()
          .setOrigin(p.from)
          .setDestination(p.to)
          .setMode(Maps.DirectionFinder.Mode.DRIVING)
          .setRegion('ie')
          .getDirections();
        const route = dir && dir.routes && dir.routes[0];
        const leg = route && route.legs[0];
        const ponto = l => [Math.round(l.lat * 1e5) / 1e5, Math.round(l.lng * 1e5) / 1e5];
        r = JSON.stringify(leg
          ? {
              minutes: Math.round(leg.duration.value / 60),
              km: Math.round(leg.distance.value / 100) / 10,
              a: ponto(leg.start_location),                        // map: start point
              b: ponto(leg.end_location),                          // map: end point
              poly: (route.overview_polyline && route.overview_polyline.points) || ''   // map: road path
            }
          : { minutes: null, km: null });
        novos[k] = r;
      } catch (err) {
        stopped = true;   // daily Maps limit reached: try again on the next run
        Logger.log('Maps: ' + err);
      }
    }

    if (r) {
      const v = JSON.parse(r);
      list.push({ date: p.date, from: p.from, to: p.to, minutes: v.minutes, km: v.km, a: v.a, b: v.b, poly: v.poly });
    }

  });

  if (Object.keys(novos).length) cache.putAll(novos, 21600);   // 6 hours

  return { list, stopped };

}


// Run this once (choose "verCalendarios" next to ▶ Run) to find the right CAL_ID:
// the Execution log lists every calendar you can see and how many events it has
// in the next 7 days.
function verCalendarios() {

  const hoje = new Date();
  const fim = new Date(hoje.getTime() + 7 * 86400000);

  CalendarApp.getAllCalendars().forEach(c => {
    Logger.log(c.getName() + '  |  ' + c.getId() + '  |  events next 7 days: ' + c.getEvents(hoje, fim).length);
  });

  Logger.log('CAL_ID in use: ' + CAL_ID);

}


// Run this once to check how Google Maps reads each delivery of the next 3 days
function verLugares() {

  const hoje = new Date();
  const fim = new Date(hoje.getTime() + 3 * 86400000);

  CalendarApp.getCalendarById(CAL_ID).getEvents(hoje, fim).forEach(ev => {
    Logger.log(Utilities.formatDate(ev.getStartTime(), TZ, 'dd/MM HH:mm') + '  |  ' + ev.getTitle() + '  →  ' + (lugar_(ev) || '(no place)'));
  });

  if (ARMAZEM) {
    try {
      const d = Maps.newGeocoder().setRegion('ie').geocode(ARMAZEM);
      Logger.log('Warehouse → ' + (d.results[0] ? d.results[0].formatted_address : 'NOT FOUND'));
    } catch (err) {
      Logger.log('Warehouse check failed: ' + err);
    }
  }

}
