// =========================================
// GOOGLE APPS SCRIPT  (Extensions -> Apps Script, inside the Google Sheet)
//
// Every 5 minutes (trigger on atualizarPlanilha):
//   1. writes the calendar events into the "Events" tab
//   2. sends the same events to the Delivery Sheet Worker
// =========================================

const CAL_ID = 'bray@living.ie';

const DIAS_ATRAS = 7;      // also send the last 7 days (to reopen recent sheets)
const DIAS_FRENTE = 21;    // and the next 21 days

const WORKER_URL = 'https://delivery-sheet.YOUR-ACCOUNT.workers.dev/api/calendar/sync';
const SYNC_KEY = 'the-same-secret-you-put-in-cloudflare';

const TZ = 'Europe/Dublin';


// Finds "PP 12345", "PP-12345", "OS:6789", "os 6789"... in the title, then in the description
function lerReferencia(ev) {

  const texto = (ev.getTitle() || '') + '\n' + (ev.getDescription() || '');
  const m = texto.match(/\b(PP|OS)\s*[-:#.]?\s*(\d{3,})/i);

  return m ? { kind: m[1].toUpperCase(), number: m[2] } : { kind: '', number: '' };

}


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

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Events') || ss.insertSheet('Events');

  const linhas = eventos.map(ev => {
    const ref = lerReferencia(ev);
    return [
      fmt(ev.getStartTime(), 'dd/MM/yyyy'),
      fmt(ev.getStartTime(), 'HH:mm'),
      fmt(ev.getEndTime(), 'HH:mm'),
      ev.getTitle(),
      ev.getLocation(),
      ev.getDescription(),
      ev.isAllDayEvent() ? 'Yes' : 'No',
      ref.kind ? ref.kind + ' ' + ref.number : ''
    ];
  });

  sh.clearContents();
  sh.getRange(1, 1, 1, 8).setValues([['Date', 'Start', 'End', 'Title', 'Location', 'Description', 'All day', 'PP/OS']]);
  if (linhas.length) sh.getRange(2, 1, linhas.length, 8).setValues(linhas);
  sh.getRange('J1').setValue('Last update: ' + fmt(new Date(), 'dd/MM/yyyy HH:mm'));


  // ---------- 2. DELIVERY SHEET WORKER ----------

  const payload = eventos.map(ev => {
    const ref = lerReferencia(ev);
    return {
      date: fmt(ev.getStartTime(), 'yyyy-MM-dd'),
      start: fmt(ev.getStartTime(), 'HH:mm'),
      end: fmt(ev.getEndTime(), 'HH:mm'),
      allDay: ev.isAllDayEvent(),
      title: ev.getTitle(),
      location: ev.getLocation(),
      kind: ref.kind,
      number: ref.number,
      minutes: Math.round((ev.getEndTime() - ev.getStartTime()) / 60000)
    };
  });

  const res = UrlFetchApp.fetch(WORKER_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sync-key': SYNC_KEY },
    payload: JSON.stringify({ events: payload }),
    muteHttpExceptions: true
  });

  sh.getRange('J2').setValue('Worker: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 100));

}
