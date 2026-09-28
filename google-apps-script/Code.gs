// =========================================
// DELIVERY SHEET - CALENDAR FEED (Google Apps Script)
//
// Runs as your Google account, so it can read any calendar
// you can see in Google Calendar. Deployed as a Web App,
// it returns the events as JSON to the Cloudflare Worker.
// =========================================


// Same value goes inside CAL_SCRIPT_URL (…/exec?token=THIS_VALUE)
const TOKEN = 'CHANGE-ME-to-a-long-random-password';


const TIME_ZONE = 'Europe/Dublin';


// Order = priority. Calendar ID: Google Calendar → Settings → calendar → Integrate calendar
const CALENDARS = [
  {
    id: 'warehouse',
    name: 'Warehouse/Deliveries',
    color: '#f09300',
    calendarId: 'PASTE-THE-WAREHOUSE-CALENDAR-ID-HERE'
  },
  {
    id: 'living-bray',
    name: 'Living Bray',
    color: '#3f51b5',
    calendarId: 'living.ie_nheeefq8v2c1h3d6d92frcgh3g@group.calendar.google.com'
  }
];


function doGet(e) {

  const params = (e && e.parameter) || {};

  if (params.token !== TOKEN) return output({ error: 'Unauthorized' });

  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  const from = iso.test(params.from || '') ? params.from : today;
  const to = iso.test(params.to || '') ? params.to : today;

  const start = Utilities.parseDate(from + ' 00:00', TIME_ZONE, 'yyyy-MM-dd HH:mm');
  const end = Utilities.parseDate(to + ' 23:59', TIME_ZONE, 'yyyy-MM-dd HH:mm');

  const calendars = CALENDARS.map(cal => {

    const base = { id: cal.id, name: cal.name, color: cal.color };

    const calendar = CalendarApp.getCalendarById(cal.calendarId);

    if (!calendar) return Object.assign(base, { error: 'No access to calendar', events: [] });

    const events = [];

    for (const ev of calendar.getEvents(start, end)) {

      const item = {
        title: ev.getTitle() || '(no title)',
        description: (ev.getDescription() || '').replace(/<[^>]+>/g, ' ').trim(),
        location: ev.getLocation() || ''
      };

      if (ev.isAllDayEvent()) {

        // All-day events: one entry per day (end date is exclusive)
        for (let d = new Date(ev.getAllDayStartDate()); d < ev.getAllDayEndDate(); d.setDate(d.getDate() + 1)) {
          const date = Utilities.formatDate(d, TIME_ZONE, 'yyyy-MM-dd');
          if (date >= from && date <= to) {
            events.push(Object.assign({ date: date, start: null, end: null }, item));
          }
        }

      } else {

        events.push(Object.assign({
          date: Utilities.formatDate(ev.getStartTime(), TIME_ZONE, 'yyyy-MM-dd'),
          start: Utilities.formatDate(ev.getStartTime(), TIME_ZONE, 'HH:mm'),
          end: Utilities.formatDate(ev.getEndTime(), TIME_ZONE, 'HH:mm')
        }, item));

      }

    }

    return Object.assign(base, { events: events });

  });

  return output({ from: from, to: to, calendars: calendars });

}


function output(data) {

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);

}


// Run this once from the editor to grant access and check the calendars
function testAccess() {

  for (const cal of CALENDARS) {
    const calendar = CalendarApp.getCalendarById(cal.calendarId);
    Logger.log(cal.name + ': ' + (calendar ? 'OK (' + calendar.getName() + ')' : 'NO ACCESS - check the Calendar ID'));
  }

}
