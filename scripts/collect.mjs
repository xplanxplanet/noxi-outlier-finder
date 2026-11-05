// Daily collector: finds recently created channels through YouTube search and
// records a snapshot of every tracked channel so growth can be measured.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://www.googleapis.com/youtube/v3/';
const DAY = 86400000;
const SHORT_MAX_SECONDS = 180;
const MIN_VIDEOS = 3;
const KEEP_SNAPSHOTS = 35;
const TOP_SHORTS = 3;
const WINDOWS = [30, 90, 365];
const SITE = 'https://xplanxplanet.github.io/';
const UPLOAD_WORKERS = 8;

export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null;
}
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/* Views per day across roughly the last `days`, or null until two snapshots exist in that span. */
export function pace(history, days) {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  const start = history.find(h => h[0] >= last[0] - days);
  if (!start || start[0] === last[0]) return null;
  return Math.max(Math.round((last[1] - start[1]) / (last[0] - start[0])), 0);
}

class QuotaOrKeyError extends Error {}

function client(key, fetcher) {
  const c = { units: 0 };
  c.call = async (path, params) => {
    const res = await fetcher(API + path + '?' + new URLSearchParams({ ...params, key }), { headers: { Referer: SITE } });
    c.units++;
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const err = body.error || {};
    const reason = [err.errors?.[0]?.reason, err.details?.[0]?.reason, err.status].filter(Boolean).join(' ');
    const text = `${path}: ${res.status} ${reason} ${err.message || ''}`.trim();
    if (res.status === 400 && /API key|API_KEY/i.test(text)) throw new QuotaOrKeyError(text);
    if (res.status === 403) throw new QuotaOrKeyError(text);
    throw new Error(text);
  };
  return c;
}

export async function collect({ existing, config, key, fetcher, now = Date.now(), log = () => {} }) {
  const today = Math.floor(now / DAY);
  const api = client(key, fetcher);
  const windowDays = WINDOWS[today % WINDOWS.length];
  const publishedAfter = new Date(now - windowDays * DAY).toISOString();
  const count = Math.min(config.maxSearchesPerDay, config.phrases.length);
  const todays = Array.from({ length: count }, (_, i) => config.phrases[(today + i) % config.phrases.length]);

  const known = new Map((existing.channels || []).map(c => [c.id, c]));
  const foundVideos = new Set(), foundChannels = new Set();
  let searches = 0, searchStopped = null;
  for (const q of todays) {
    try {
      searches++;
      const page = await api.call('search', { part: 'snippet', type: 'video', videoDuration: 'short', order: 'viewCount', maxResults: 50, regionCode: 'US', relevanceLanguage: 'en', publishedAfter, q });
      for (const item of page.items || []) {
        if (item.id?.videoId) foundVideos.add(item.id.videoId);
        if (item.snippet?.channelId) foundChannels.add(item.snippet.channelId);
      }
    } catch (e) {
      if (e instanceof QuotaOrKeyError) { searchStopped = e.message; break; }
      log('Skipped search "' + q + '": ' + e.message);
    }
  }
  // A bad key or used-up quota stops the run so yesterday's data is left untouched.
  if (searchStopped && !foundChannels.size && !known.size) throw new Error(searchStopped);
  if (searchStopped) log('Searches stopped early: ' + searchStopped);

  const next = new Map();
  for (const ids of chunks([...new Set([...known.keys(), ...foundChannels])], 50)) {
    const page = await api.call('channels', { part: 'snippet,statistics', id: ids.join(','), maxResults: 50 });
    for (const c of page.items || []) {
      const old = known.get(c.id);
      const views = +c.statistics.viewCount, videoCount = +c.statistics.videoCount;
      if (!old && (now - Date.parse(c.snippet.publishedAt) > config.maxChannelAgeDays * DAY || videoCount < MIN_VIDEOS)) continue;
      const subs = c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount;
      const h = [...(old?.h || []).filter(s => s[0] !== today), [today, views, subs]].slice(-KEEP_SNAPSHOTS);
      next.set(c.id, { id: c.id, title: c.snippet.title, handle: c.snippet.customUrl || '', country: c.snippet.country || '', createdAt: c.snippet.publishedAt,
        firstSeen: old?.firstSeen || new Date(now).toISOString().slice(0, 10), subs, views, videoCount, h, g7: pace(h, 7), g30: pace(h, 30), top: old?.top || [],
        lastUpload: old?.lastUpload || null });
    }
  }

  // The newest upload shows whether a channel has gone quiet. It costs 1 quota unit per channel.
  const queue = [...next.values()];
  let uploadsStopped = null;
  const lookUp = async () => {
    while (queue.length && !uploadsStopped) {
      const c = queue.shift();
      try {
        const page = await api.call('playlistItems', { part: 'contentDetails', playlistId: 'UU' + c.id.slice(2), maxResults: 1 });
        const at = page.items?.[0]?.contentDetails?.videoPublishedAt;
        if (at) c.lastUpload = at;
      } catch (e) {
        // A private or missing uploads list only skips that channel; a quota or key problem stops the lookups.
        if (e instanceof QuotaOrKeyError && /quota|LimitExceeded|API.?key|keyInvalid|accessNotConfigured|Blocked/i.test(e.message)) uploadsStopped = e.message;
        else log('Skipped last upload for ' + c.id + ': ' + e.message);
      }
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_WORKERS }, lookUp));
  if (uploadsStopped) log('Last-upload lookups stopped early: ' + uploadsStopped);

  const videoIds = new Set(foundVideos);
  next.forEach(c => c.top.forEach(v => videoIds.add(v.id)));
  const shorts = new Map();
  for (const ids of chunks([...videoIds], 50)) {
    const page = await api.call('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 });
    for (const v of page.items || []) {
      const secs = parseDuration(v.contentDetails?.duration);
      if (!next.has(v.snippet.channelId) || !secs || secs > SHORT_MAX_SECONDS || v.statistics?.viewCount === undefined) continue;
      if (!shorts.has(v.snippet.channelId)) shorts.set(v.snippet.channelId, []);
      shorts.get(v.snippet.channelId).push({ id: v.id, title: v.snippet.title, views: +v.statistics.viewCount });
    }
  }
  next.forEach((c, id) => {
    const list = shorts.get(id);
    if (list) c.top = list.sort((a, b) => b.views - a.views).slice(0, TOP_SHORTS);
  });

  // A channel needs a Short from the search results to be worth tracking.
  const ranked = [...next.values()].filter(c => c.top.length).sort((a, b) =>
    (b.g7 ?? -1) - (a.g7 ?? -1) || b.views / Math.max((now - Date.parse(b.createdAt)) / DAY, 1) - a.views / Math.max((now - Date.parse(a.createdAt)) / DAY, 1));
  return {
    updatedAt: new Date(now).toISOString(),
    phrases: config.phrases,
    searches, units: api.units, searchStopped: searchStopped || null,
    channels: ranked.slice(0, config.maxChannels),
  };
}

/* ---------- Watchlist: hand-picked channels, their latest uploads, and each video's views every day ---------- */
const WATCH_UPLOADS = 50;       // uploads read per channel (the normal is the median of these)
const WATCH_KEEP = 30;          // newest uploads kept per channel in watch.json
const WATCH_HISTORY_DAYS = 60;  // daily view snapshots are kept for videos younger than this
const WATCH_SNAPSHOTS = 21;
const MATURE_DAYS = 7;

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function collectWatch({ list, existing, key, fetcher, now = Date.now(), log = () => {} }) {
  const today = Math.floor(now / DAY);
  const api = client(key, fetcher);
  const old = new Map((existing.videos || []).map(v => [v.id, v]));
  const oldCh = new Map((existing.channels || []).map(c => [c.id, c]));
  const entries = list.filter(c => /^UC[\w-]{22}$/.test(c.id || ''));
  const info = new Map();
  for (const ids of chunks(entries.map(c => c.id), 50)) {
    const page = await api.call('channels', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 });
    for (const c of page.items || []) info.set(c.id, c);
  }
  const uploads = new Map();
  for (const e of entries) {
    const c = info.get(e.id);
    if (!c) { log('Watchlist: channel not found ' + e.id); continue; }
    try {
      const page = await api.call('playlistItems', { part: 'contentDetails', playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: WATCH_UPLOADS });
      uploads.set(e.id, (page.items || []).map(i => i.contentDetails.videoId));
    } catch (err) {
      if (err instanceof QuotaOrKeyError && /quota|LimitExceeded|API.?key|keyInvalid|accessNotConfigured|Blocked/i.test(err.message)) throw err;
      log('Watchlist: no uploads for ' + e.id + ': ' + err.message);
    }
  }
  const details = new Map();
  for (const ids of chunks([...uploads.values()].flat(), 50)) {
    const page = await api.call('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 });
    for (const v of page.items || []) details.set(v.id, v);
  }
  const channels = [], videos = [];
  for (const e of entries) {
    const c = info.get(e.id);
    if (!c) continue;
    const views = +c.statistics.viewCount, subs = c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount;
    const prev = oldCh.get(e.id);
    const h = [...(prev?.h || []).filter(s => s[0] !== today), [today, views, subs]].slice(-KEEP_SNAPSHOTS);
    const vids = (uploads.get(e.id) || []).map(id => details.get(id)).filter(v => v && v.statistics?.viewCount !== undefined && v.snippet.liveBroadcastContent === 'none')
      .map(v => ({ id: v.id, channelId: e.id, title: v.snippet.title, publishedAt: v.snippet.publishedAt, seconds: parseDuration(v.contentDetails?.duration) || 0,
        views: +v.statistics.viewCount, likes: v.statistics.likeCount === undefined ? null : +v.statistics.likeCount,
        comments: v.statistics.commentCount === undefined ? null : +v.statistics.commentCount }))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    // the channel's normal per format: median views of uploads at least a week old
    const normalOf = isShort => median(vids.filter(v => (v.seconds <= SHORT_MAX_SECONDS) === isShort && now - Date.parse(v.publishedAt) >= MATURE_DAYS * DAY).map(v => v.views));
    channels.push({ id: e.id, name: e.name || c.snippet.title, group: e.group || 'Other', title: c.snippet.title, handle: c.snippet.customUrl || '',
      createdAt: c.snippet.publishedAt, subs, views, videoCount: +c.statistics.videoCount, h, normal: { long: normalOf(false), short: normalOf(true) } });
    for (const v of vids.slice(0, WATCH_KEEP)) {
      const young = now - Date.parse(v.publishedAt) <= WATCH_HISTORY_DAYS * DAY;
      const vh = young ? [...(old.get(v.id)?.h || []).filter(s => s[0] !== today), [today, v.views]].slice(-WATCH_SNAPSHOTS) : [];
      videos.push({ ...v, h: vh });
    }
  }
  return { updatedAt: new Date(now).toISOString(), units: api.units, channels, videos };
}

async function main() {
  const key = process.env.YT_API_KEY;
  if (!key) throw new Error('The YT_API_KEY secret is missing. Add it under Settings > Secrets and variables > Actions.');
  const config = JSON.parse(await readFile('data/config.json', 'utf8'));
  const existing = JSON.parse(await readFile('data/channels.json', 'utf8').catch(() => '{}'));
  const out = await collect({ existing, config, key, fetcher: fetch, log: m => console.log(m) });
  await writeFile('data/channels.json', JSON.stringify(out));
  console.log(`Saved ${out.channels.length} channels using ${out.searches} searches and ${out.units} API calls.`);
  // The watchlist runs on its own: if it fails, the database above is still saved.
  try {
    const list = JSON.parse(await readFile('data/watchlist.json', 'utf8')).channels || [];
    const prevWatch = JSON.parse(await readFile('data/watch.json', 'utf8').catch(() => '{}'));
    const w = await collectWatch({ list, existing: prevWatch, key, fetcher: fetch, log: m => console.log(m) });
    await writeFile('data/watch.json', JSON.stringify(w));
    console.log(`Watchlist: ${w.channels.length} channels, ${w.videos.length} videos, ${w.units} API calls.`);
  } catch (e) {
    console.log('Watchlist skipped: ' + String(e.message).replaceAll(key, '[key]'));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error(String(e.message).replaceAll(process.env.YT_API_KEY || '\0', '[key]')); process.exit(1); });
}
