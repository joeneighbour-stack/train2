// Garmin readiness proxy for the TRAIN 2 app.
//
// Holds the Garmin Personal API key server-side (Netlify environment variable),
// so it never reaches the phone or the page source. The app calls
//   /api/garmin?date=YYYY-MM-DD
// with header  x-train-key: <TRAIN_SECRET>  and gets back a small JSON summary.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   GARMIN_PERSONAL_API_KEY   your Garmin Personal API key
//   TRAIN_SECRET              any passphrase; the app asks for it once

const BASE = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';

// Warm invocations reuse the token (valid 24h); cold starts fetch a new one.
let cachedToken = null; // {token, exp}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function jwtExp(token) {
  try {
    const p = token.split('.')[1];
    const claims = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return claims.exp ? claims.exp * 1000 : Date.now() + 20 * 3600e3;
  } catch { return Date.now() + 20 * 3600e3; }
}

async function getToken(apiKey) {
  if (cachedToken && cachedToken.exp - Date.now() > 3600e3) return cachedToken.token;
  const r = await fetch(BASE + TOKEN_PATH, {
    method: 'POST',
    headers: { Accept: '*/*', Authorization: `ApiKey ${apiKey}` },
  });
  if (!r.ok) throw Object.assign(new Error(`token ${r.status}`), { status: r.status });
  let text = (await r.text()).trim();
  try { const j = JSON.parse(text); if (j && (j.access_token || j.accessToken)) text = j.access_token || j.accessToken; } catch {}
  text = text.replace(/^"|"$/g, '');
  cachedToken = { token: text, exp: jwtExp(text) };
  return text;
}

async function gget(token, path, params) {
  const url = BASE + path + (params ? '?' + new URLSearchParams(params) : '');
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (!r.ok) throw Object.assign(new Error(`${path} ${r.status}`), { status: r.status });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const num = v => (v === null || v === undefined || isNaN(+v)) ? null : +v;

// ── Shape each Garmin response down to what the app needs ──
function shapeHrv(raw, date) {
  const list = (raw && raw.hrvSummaries) || [];
  const nights = list.map(s => ({
    date: s.calendarDate, avg: num(s.lastNightAvg), status: s.status || null,
    low: num(s.baseline && s.baseline.lowUpper),
    bandLow: num(s.baseline && s.baseline.balancedLow),
    bandHigh: num(s.baseline && s.baseline.balancedUpper),
    weeklyAvg: num(s.weeklyAvg),
  })).sort((a, b) => a.date < b.date ? -1 : 1);
  const today = nights.find(n => n.date === date) || null;
  return { today, nights };
}

function shapeSleep(raw) {
  if (!raw) return null;
  const sc = raw.sleepScores || {};
  return {
    score: num(sc.overall && sc.overall.value),
    quality: (sc.overall && sc.overall.qualifierKey) || null,
    hours: raw.sleepTimeSeconds ? Math.round(raw.sleepTimeSeconds / 360) / 10 : null,
    needHours: raw.sleepNeed && raw.sleepNeed.actual ? Math.round(raw.sleepNeed.actual / 6) / 10 : null,
  };
}

function shapeDaily(raw) {
  const d = raw && raw.data && raw.data[0];
  if (!d) return null;
  const bb = d.bodyBattery || {};
  return {
    rhr: num(d.heartRate && d.heartRate.restingValue),
    bbPeak: num(bb.maxValue),
    bbLatest: num(bb.latestValue),
    stressAvg: num(d.stress && d.stress.avgLevel),
    jetLag: d.jetLag ? (d.jetLag.tripName || 'Travel') : null,
  };
}

function shapeHr(raw) {
  if (!raw) return null;
  return { rhr: num(raw.restingHeartRate), rhr7: num(raw.lastSevenDaysAvgRestingHeartRate) };
}

const LEG_TYPES = /run|hik|walk|trail|cycl|bik|mountaineer|ski|row|hyrox|stair/i;
function shapeActivities(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(a => ({
    date: (a.startTimeLocal || '').slice(0, 10),
    start: a.startTimeLocal || null,
    type: (a.activityType && a.activityType.typeKey) || 'other',
    name: a.activityName || null,
    load: num(a.activityTrainingLoad),
    mins: a.duration ? Math.round(a.duration / 60) : null,
    elev: num(a.elevationGain),
    km: a.distance ? Math.round(a.distance / 100) / 10 : null,
    avgHR: num(a.averageHR),
    watts: num(a.avgPower),
    legs: LEG_TYPES.test((a.activityType && a.activityType.typeKey) || ''),
  }));
}

export default async (req) => {
  const secret = process.env.TRAIN_SECRET;
  const apiKey = process.env.GARMIN_PERSONAL_API_KEY;
  if (!apiKey) return json(500, { error: 'GARMIN_PERSONAL_API_KEY is not set on the site' });
  if (!secret) return json(500, { error: 'TRAIN_SECRET is not set on the site' });
  if (req.headers.get('x-train-key') !== secret) return json(401, { error: 'Wrong or missing passphrase' });

  const url = new URL(req.url);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '')
    ? url.searchParams.get('date') : new Date().toISOString().slice(0, 10);

  let token;
  try { token = await getToken(apiKey); }
  catch (e) {
    return json(502, { error: e.status === 401 ? 'Garmin rejected the API key (expired or deleted?)' : 'Could not reach Garmin' });
  }

  const calls = {
    hrv:   gget(token, `/hrv-service/hrv/daily/${addDays(date, -6)}/${date}`),
    sleep: gget(token, '/sleep-service/sleep/dailySleep', { date }),
    daily: gget(token, '/usersummary-service/v2/dailysummaries', { startDate: date, endDate: date }),
    hr:    gget(token, '/wellness-service/wellness/dailyHeartRate', { date }),
    acts:  gget(token, '/activitylist-service/activities/search/activities',
                { start: 0, limit: 100, startDate: addDays(date, -27), endDate: date }),
  };
  const names = Object.keys(calls);
  const settled = await Promise.allSettled(Object.values(calls));
  const got = {}, errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') got[names[i]] = r.value;
    else { got[names[i]] = null; errors.push(names[i]); }
  });
  // A 401 mid-way means the cached token went bad: drop it so the next call refreshes.
  if (settled.some(r => r.status === 'rejected' && r.reason && r.reason.status === 401)) cachedToken = null;

  return json(200, {
    date,
    fetchedAt: new Date().toISOString(),
    hrv: shapeHrv(got.hrv, date),
    sleep: shapeSleep(got.sleep),
    daily: shapeDaily(got.daily),
    hr: shapeHr(got.hr),
    activities: shapeActivities(got.acts),
    errors,
  });
};

export const config = { path: '/api/garmin' };
