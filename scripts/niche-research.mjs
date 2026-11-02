// One-off niche research: for each phrase in research/phrases.txt, scores the niche the same way
// the Niche finder tab does, and lists the top Shorts and channels behind it.
// Writes research/results.json and research/results.md.
import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://www.googleapis.com/youtube/v3/';
const SITE = 'https://xplanxplanet.github.io/';
const DAY = 86400000;
const SHORT_MAX_SECONDS = 180;
const SMALL_SUBS = 100000;
const NEW_CHANNEL_DAYS = 365;
const DAYS = +(process.env.DAYS || 90);
const RPM_SHORTS = 0.05;

const key = process.env.YT_API_KEY;
if (!key) throw new Error('YT_API_KEY is missing.');
let units = 0;
async function call(path, params) {
  const res = await fetch(API + path + '?' + new URLSearchParams({ ...params, key }), { headers: { Referer: SITE } });
  units += path === 'search' ? 100 : 1;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.error?.message || ''}`.replaceAll(key, '[key]'));
  return body;
}
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const parseDuration = iso => {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null;
};
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const clamp01 = x => Math.min(Math.max(x, 0), 1);
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
const pct = x => Math.round(x * 100) + '%';
const cell = s => String(s).replaceAll('|', '/').replace(/\s+/g, ' ');

const now = Date.now();
const phrases = (await readFile('research/phrases.txt', 'utf8')).split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
const publishedAfter = new Date(now - DAYS * DAY).toISOString();

const niches = [];
for (const q of phrases) {
  const page = await call('search', { part: 'snippet', type: 'video', videoDuration: 'short', order: 'viewCount', maxResults: 50,
    regionCode: 'US', relevanceLanguage: 'en', publishedAfter, q });
  niches.push({ q, ids: (page.items || []).map(i => i.id?.videoId).filter(Boolean) });
}
const videoById = new Map();
for (const ids of chunks([...new Set(niches.flatMap(n => n.ids))], 50)) {
  const page = await call('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 });
  for (const v of page.items || []) {
    const seconds = parseDuration(v.contentDetails?.duration);
    if (!seconds || v.statistics?.viewCount === undefined) continue;
    videoById.set(v.id, { id: v.id, title: v.snippet.title, channelId: v.snippet.channelId, publishedAt: v.snippet.publishedAt,
      views: +v.statistics.viewCount, likes: +(v.statistics.likeCount || 0), comments: +(v.statistics.commentCount || 0), seconds });
  }
}
const channelById = new Map();
for (const ids of chunks([...new Set([...videoById.values()].map(v => v.channelId))], 50)) {
  const page = await call('channels', { part: 'snippet,statistics', id: ids.join(','), maxResults: 50 });
  for (const c of page.items || []) channelById.set(c.id, { id: c.id, title: c.snippet.title, handle: c.snippet.customUrl || '',
    createdAt: c.snippet.publishedAt, subs: c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount,
    videoCount: +(c.statistics.videoCount || 0), totalViews: +(c.statistics.viewCount || 0) });
}

const isNew = c => c && (now - Date.parse(c.createdAt)) / DAY <= NEW_CHANNEL_DAYS;
const results = niches.map(n => {
  const vids = n.ids.map(id => videoById.get(id)).filter(v => v && v.seconds <= SHORT_MAX_SECONDS).sort((a, b) => b.views - a.views);
  const ch = v => channelById.get(v.channelId);
  const known = vids.filter(v => ch(v)?.subs != null);
  const smallShare = known.length ? known.filter(v => ch(v).subs < SMALL_SUBS).length / known.length : 0;
  const newShare = vids.length ? vids.filter(v => isNew(ch(v))).length / vids.length : 0;
  const typicalViews = median(vids.map(v => v.views));
  const demand = clamp01((Math.log10(Math.max(typicalViews, 1)) - 4) / 3);
  // Small and new channel shares only count as much as the niche has demand.
  const score = vids.length ? Math.round(100 * demand * (0.4 + 0.3 * smallShare + 0.3 * newShare)) : 0;
  const breakouts = vids.filter(v => isNew(ch(v)) && v.views >= 1e6).length;
  const per = new Map();
  for (const v of vids) {
    const c = ch(v); if (!c) continue;
    const t = per.get(c.id) || { ...c, hits: 0, hitViews: 0 };
    t.hits++; t.hitViews += v.views; per.set(c.id, t);
  }
  return { q: n.q, count: vids.length, typicalViews, smallShare, newShare, breakouts, score,
    medianSeconds: median(vids.map(v => v.seconds)), top: vids.slice(0, 10).map(v => ({ ...v, channel: ch(v) })),
    channels: [...per.values()].sort((a, b) => b.hitViews - a.hitViews).slice(0, 8) };
}).sort((a, b) => b.score - a.score);

await writeFile('research/results.json', JSON.stringify({ generatedAt: new Date(now).toISOString(), days: DAYS, units, results }, null, 1));
const md = [`# Niche research: Shorts, last ${DAYS} days`, '', `Generated ${new Date(now).toISOString()}. Used about ${units} API units.`, '',
  'Score: demand (typical views of the 50 most-viewed Shorts) multiplied by how open the niche is to small (<100K subs) and new (<1 year) channels.', '',
  '| Niche | Score | Typical top Short | Small channels | New channels | New-channel 1M+ hits | Median length |', '|---|---|---|---|---|---|---|',
  ...results.map(r => `| ${cell(r.q)} | ${r.score} | ${fmt(r.typicalViews)} | ${pct(r.smallShare)} | ${pct(r.newShare)} | ${r.breakouts} | ${Math.round(r.medianSeconds)}s |`), ''];
for (const r of results) {
  md.push(`## ${r.q}`, '', '| Views | Length | Title | Channel | Subs | Channel age |', '|---|---|---|---|---|---|');
  for (const v of r.top) md.push(`| ${fmt(v.views)} | ${v.seconds}s | [${cell(v.title)}](https://youtube.com/shorts/${v.id}) | ${cell(v.channel?.title || '?')} | ${v.channel?.subs == null ? 'hidden' : fmt(v.channel.subs)} | ${v.channel ? Math.round((now - Date.parse(v.channel.createdAt)) / DAY) + 'd' : '?'} |`);
  md.push('', 'Top channels: ' + r.channels.map(c => `${cell(c.title)} (${c.hits} hits, ${fmt(c.hitViews)} views, ${c.subs == null ? 'hidden' : fmt(c.subs)} subs, ${Math.round((now - Date.parse(c.createdAt)) / DAY)}d old)`).join('; '), '');
}
await writeFile('research/results.md', md.join('\n'));
console.log(md.slice(0, results.length + 8).join('\n'));
