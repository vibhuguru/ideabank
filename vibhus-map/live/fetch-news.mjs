// Vibhu's Map of Global Health: live news robot.
// Reads the RSS feeds in feeds.json, works out where each story happened and what kind of story it is,
// and writes live.json for the map. No packages needed, just Node 20.
//
// Usage: node fetch-news.mjs <previous live.json> <output live.json>
// Optional env (set by the GitHub workflow when someone sends a link or a webhook):
//   ADD_URL, ADD_CC, ADD_CATEGORY, REMOVE_URL, EVENT_PAYLOAD (JSON)

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const GEO = JSON.parse(fs.readFileSync(path.join(DIR, 'geo.json'), 'utf8'));
const FEEDS = JSON.parse(fs.readFileSync(path.join(DIR, 'feeds.json'), 'utf8'));
const PREV = process.argv[2] || 'prev.json';
const OUT = process.argv[3] || 'out/live.json';
const CURATED = path.join(DIR, '..', 'data', 'stories.json');

const MAX_AGE_DAYS = 21;      // live pins drop off after three weeks
const MAX_ITEMS = 150;        // cap on live pins
const PER_FEED = 25;          // newest items read from each feed per run
const IMAGE_LOOKUPS = 40;     // article pages opened per run to find a preview image
const UA = 'Mozilla/5.0 (compatible; VibhusMapBot/1.0; +https://vibhuguru.github.io/ideabank/vibhus-map/)';

const today = new Date();
const iso = d => d.toISOString().slice(0, 10);
const daysAgo = s => (today - new Date(s + 'T12:00:00Z')) / 864e5;
const idFor = url => 'live-' + crypto.createHash('sha1').update(normUrl(url)).digest('hex').slice(0, 10);
function normUrl(u){
  try { const x = new URL(u); x.hash = ''; ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','ref','cmpid'].forEach(k => x.searchParams.delete(k)); return x.toString().replace(/\/$/, ''); }
  catch { return (u || '').trim(); }
}

/* ---------- text helpers ---------- */
const NAMED = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', rsquo:'’', lsquo:'‘', rdquo:'”', ldquo:'“', ndash:'-', mdash:', ', hellip:'...', eacute:'é', egrave:'è', aacute:'á', iacute:'í', oacute:'ó', uacute:'ú', ntilde:'ñ', ccedil:'ç', ouml:'ö', uuml:'ü', auml:'ä', ocirc:'ô', atilde:'ã', otilde:'õ'};
function decode(s){
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); try { return String.fromCodePoint(n); } catch { return ''; } }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const cdata = s => (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const stripTags = s => (s || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
const clean = s => decode(stripTags(decode(cdata(s)))).replace(/\s+/g, ' ').replace(/—/g, ', ').trim();
function shorten(s, n = 300){
  s = s.replace(/The post .* appeared first on .*$/i, '').replace(/\s*Continue reading\.*$/i, '').replace(/\[…\]|\[\.\.\.\]/g, '').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '...';
}
function tag(xml, names){
  for (const n of names){
    const m = xml.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m && m[1].trim()) return m[1];
  }
  return '';
}
const attr = (s, a) => { const m = s.match(new RegExp(`\\s${a}\\s*=\\s*["']([^"']+)["']`, 'i')); return m ? decode(m[1]) : ''; };

/* ---------- feed parsing (RSS 2.0 and Atom) ---------- */
function parseFeed(xml){
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    let link = clean(tag(b, ['link']));
    if (!/^https?:/.test(link)){
      const links = b.match(/<link\b[^>]*>/gi) || [];
      const alt = links.find(l => /rel=["']alternate/i.test(l)) || links.find(l => !/rel=/i.test(l)) || links[0] || '';
      link = attr(alt, 'href');
    }
    if (!/^https?:/.test(link)) { const g = clean(tag(b, ['guid', 'id'])); if (/^https?:/.test(g)) link = g; }
    const rawDesc = tag(b, ['description', 'summary', 'content:encoded', 'content', 'a10:content']);
    const dateS = clean(tag(b, ['pubDate', 'published', 'updated', 'dc:date', 'a10:updated']));
    let image = '';
    for (const re of [/<media:content\b[^>]*>/gi, /<media:thumbnail\b[^>]*>/gi, /<enclosure\b[^>]*>/gi]){
      for (const t of b.match(re) || []){
        const u = attr(t, 'url'), ty = attr(t, 'type'), med = attr(t, 'medium');
        if (u && (/image/.test(ty) || med === 'image' || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u) || /thumbnail/i.test(t))) { image = u; break; }
      }
      if (image) break;
    }
    if (!image){ const html = decode(cdata(rawDesc)); const m = html.match(/<img\b[^>]*>/i); if (m) image = attr(m[0], 'src'); }
    const d = new Date(dateS.replace(/ Z$/, ' GMT'));
    return { title: clean(tag(b, ['title'])), url: link, summary: shorten(clean(rawDesc)), date: isNaN(d) ? iso(today) : iso(d > today ? today : d), image: /^https?:/.test(image) ? image : null };
  }).filter(x => x.title && x.url);
}

/* ---------- where did it happen? ---------- */
const TERMS = GEO.terms.map(([t, cc, place]) => ({ cc, place, re: new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu') }));
function locate(title, text){
  const score = {}, first = {}, place = {};
  [[title, 3], [text, 1]].forEach(([s, w], part) => {
    let t = ' ' + (s || '') + ' ';
    for (const term of TERMS){
      term.re.lastIndex = 0;
      t = t.replace(term.re, (m, pos) => {
        if (term.cc){
          score[term.cc] = (score[term.cc] || 0) + w;
          const k = part * 1e6 + pos; if (first[term.cc] === undefined || k < first[term.cc]) first[term.cc] = k;
          if (term.place && !place[term.cc]) place[term.cc] = term.place;
        }
        return ' '.repeat(m.length);
      });
    }
  });
  const ranked = Object.keys(score).sort((a, b) => score[b] - score[a] || first[a] - first[b]);
  if (!ranked.length) return null;
  const cc = ranked[0], c = GEO.countries[cc];
  return { cc, country: c.name, place: place[cc] || c.name, lat: c.lat, lon: c.lon, region: c.region };
}

/* ---------- what kind of story is it? ---------- */
const CATS = {
  wins: [/\beliminat(ed|es|ion)\b/i, /\bcertified\b.*\bfree\b/i, /\bfree of\b/i, /\beradicat/i, /\bmilestone\b/i, /\brecord low\b/i, /\bsaved\b.*\blives\b/i, /\bsuccess(ful)?\b/i, /\bbreakthrough\b/i, /\bcelebrat/i, /\bfalls? to\b/i, /\bdeclin(e|ed|ing)\b/i, /\bfirst[- ]ever\b/i],
  outbreak: [/\boutbreaks?\b/i, /\bcases?\b/i, /\bebola\b/i, /\bcholera\b/i, /\bmeasles\b/i, /\bmpox\b/i, /\bH5N1\b/i, /\bbird flu\b|\bavian\b/i, /\bdengue\b/i, /\bpolio\b/i, /\bmarburg\b/i, /\bnipah\b/i, /\bplague\b/i, /\bepidemic\b/i, /\bpandemic\b/i, /\bvirus\b/i, /\binfections?\b/i, /\bdiphtheria\b/i, /\bchikungunya\b/i, /\bmalaria\b/i, /\btuberculosis\b|\bTB\b/, /\bzika\b/i, /\blassa\b/i, /\bwhooping cough\b|\bpertussis\b/i, /\blisteria\b|\bsalmonella\b|\bE\. coli\b/i, /\bCOVID\b/i, /\binfluenza\b|\bflu\b/i, /\bexposures?\b/i, /\bspread(s|ing)?\b/i],
  humanitarian: [/\bhumanitarian\b/i, /\brefugees?\b/i, /\bdisplaced\b/i, /\bfamine\b/i, /\bhunger\b/i, /\bmalnutrition\b|\bmalnourished\b/i, /\bwar\b/i, /\bconflict\b/i, /\bairstrikes?\b|\bbombing\b|\battacks? on\b/i, /\bsiege\b/i, /\bceasefire\b/i, /\baid\b/i, /\bcrisis\b/i, /\bevacuat/i, /\bshelling\b/i],
  environment: [/\bclimate\b/i, /\bheat(wave| wave|stroke)?\b/i, /\bair pollution\b|\bair quality\b|\bsmog\b/i, /\bfloods?\b|\bflooding\b/i, /\bdrought\b/i, /\bwildfires?\b|\bsmoke\b/i, /\bpollution\b/i, /\blead\b.*\b(poison|water|pipes)\b/i, /\bmicroplastics?\b/i, /\bPFAS\b|\bchemicals?\b/i, /\bhurricane\b|\bcyclone\b|\btyphoon\b|\bstorm\b/i, /\bemissions\b/i, /\btemperatures?\b/i],
  tech: [/\bAI\b/, /\bartificial intelligence\b/i, /\bapps?\b/i, /\bdigital\b/i, /\btelehealth\b|\btelemedicine\b/i, /\bdevices?\b/i, /\bwearables?\b/i, /\bstartup\b/i, /\braises \$|\bfunding round\b|\bvaluation\b|\bSeries [A-D]\b/i, /\balgorithm\b/i, /\brobot/i, /\bchatbot\b|\bLLM\b/i, /\bdrones?\b/i, /\bgene therapy\b|\bCRISPR\b|\bmRNA\b/i, /\bsoftware\b|\bplatform\b/i],
  research: [/\bstudy\b|\bstudies\b/i, /\btrial\b/i, /\bresearchers?\b/i, /\bscientists?\b/i, /\bfinds?\b|\bfound\b/i, /\breview\b/i, /\bjournal\b/i, /\bLancet\b|\bNEJM\b|\bJAMA\b|\bBMJ\b|\bNature\b/, /\bdata show\b|\banalysis\b/i, /\blinked to\b|\btied to\b|\bassociated with\b/i, /\bmay (help|reduce|raise|lower|increase)\b/i],
  policy: [/\bpolicy\b|\bpolicies\b/i, /\blaw\b|\bbill\b|\blegislat/i, /\bban(s|ned)?\b/i, /\btax\b/i, /\bregulat/i, /\bfunding\b|\bbudget\b|\bcuts?\b/i, /\bminist(er|ry)\b/i, /\bgovernment\b/i, /\bWHO\b|\bWorld Health Assembly\b/, /\bguidelines?\b/i, /\bapprov(e|es|ed|al)\b/i, /\bcourt\b|\blawsuit\b/i, /\bHHS\b|\bFDA\b|\bCDC\b/, /\bdeal\b|\bagreement\b|\btreaty\b/i, /\bprices?\b|\bpricing\b/i, /\binsurance\b|\bMedicare\b|\bMedicaid\b/i, /\bvaccine (rules|schedule|policy|mandate)/i],
};
const ORDER = ['outbreak', 'humanitarian', 'environment', 'wins', 'tech', 'research', 'policy'];
const CLEAR_WIN = /\beliminat(ed|es|ion)\b|\beradicat|\bcertified\b.*\bfree\b|\bdeclared? free\b|\bfree of\b|\brecord low\b|\bends? (the )?outbreak\b|\boutbreak (is )?over\b/i;
function categorize(title, text, fallback){
  if (CLEAR_WIN.test(title)) return 'wins';
  const sc = {};
  for (const [cat, res] of Object.entries(CATS)) sc[cat] = res.reduce((n, re) => n + (re.test(title) ? 3 : 0) + (re.test(text) ? 1 : 0), 0);
  if (fallback && sc[fallback] !== undefined) sc[fallback] += 1.5;
  const best = ORDER.slice().sort((a, b) => sc[b] - sc[a] || ORDER.indexOf(a) - ORDER.indexOf(b))[0];
  return sc[best] > 1.5 ? best : (fallback || 'policy');
}

/* ---------- network ---------- */
async function get(url, ms = 12000){
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8' }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
function meta(html, ...keys){
  for (const k of keys){
    const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${k}["'][^>]*>`, 'i');
    const m = html.match(re); if (m){ const c = attr(m[0], 'content'); if (c) return decode(c).trim(); }
  }
  return '';
}
async function pageInfo(url){
  const html = (await get(url, 9000)).slice(0, 400000);
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let image = meta(html, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  if (image && !/^https?:/.test(image)) try { image = new URL(image, url).toString(); } catch { image = ''; }
  const pub = meta(html, 'article:published_time', 'og:published_time', 'date', 'pubdate', 'DC.date.issued');
  return {
    title: clean(meta(html, 'og:title', 'twitter:title') || (t ? t[1] : '')),
    summary: shorten(clean(meta(html, 'og:description', 'description', 'twitter:description'))),
    image: image || null, site: meta(html, 'og:site_name'),
    date: pub && !isNaN(new Date(pub)) ? iso(new Date(pub)) : null,
    text: clean(html.match(/<p[\s>][\s\S]*?<\/p>/gi)?.slice(0, 6).join(' ') || ''),
  };
}

function build(raw, feed){
  const where = raw.cc && GEO.countries[raw.cc.toUpperCase()]
    ? (c => ({ cc: raw.cc.toUpperCase(), country: c.name, place: c.name, lat: c.lat, lon: c.lon, region: c.region }))(GEO.countries[raw.cc.toUpperCase()])
    : locate(raw.title, raw.summary + ' ' + (raw.text || ''));
  if (!where) return null;
  const cat = CATS[raw.category] ? raw.category : categorize(raw.title, raw.summary, feed.category);
  return { id: idFor(raw.url), date: raw.date, category: cat, region: where.region, title: raw.title, summary: raw.summary || '',
    place: where.place, lat: where.lat, lon: where.lon, cc: where.cc, country: where.country, source: raw.source || feed.name,
    url: normUrl(raw.url), image: raw.image || null, live: true };
}

/* ---------- main ---------- */
async function main(){
  let prev = { stories: [], removed: [] };
  try { prev = { stories: [], removed: [], ...JSON.parse(fs.readFileSync(PREV, 'utf8')) }; } catch {}
  let curated = new Set();
  try { curated = new Set(JSON.parse(fs.readFileSync(CURATED, 'utf8')).stories.map(s => normUrl(s.url))); } catch {}

  const payload = (() => { try { return JSON.parse(process.env.EVENT_PAYLOAD || '{}') || {}; } catch { return {}; } })();
  const addUrl = process.env.ADD_URL || payload.url || '';
  const removeUrl = process.env.REMOVE_URL || payload.remove || '';
  const removed = new Set((prev.removed || []).map(normUrl));
  if (removeUrl) removed.add(normUrl(removeUrl));

  const byUrl = new Map();
  for (const s of prev.stories) if (!removed.has(s.url) && daysAgo(s.date) <= MAX_AGE_DAYS) byUrl.set(s.url, s);
  const known = u => byUrl.has(normUrl(u)) || curated.has(normUrl(u)) || removed.has(normUrl(u));
  const titles = new Set([...byUrl.values()].map(s => s.title.toLowerCase()));
  const log = [];

  // 1. a link someone sent in (webhook or the Run workflow form)
  if (addUrl){
    try {
      const p = await pageInfo(addUrl);
      const s = build({ title: payload.title || p.title, summary: payload.summary || p.summary, text: p.text, url: addUrl, image: payload.image || p.image,
        date: payload.date || p.date || iso(today), cc: process.env.ADD_CC || payload.cc, category: process.env.ADD_CATEGORY || payload.category,
        source: payload.source || p.site || new URL(addUrl).hostname.replace(/^www\./, '') }, { name: 'Sent in', category: 'policy' });
      if (s){ s.pinned = true; byUrl.set(s.url, s); removed.delete(s.url); log.push(`added: ${s.title} -> ${s.country}`); }
      else log.push(`could not place ${addUrl} on the map; send it again with a country code`);
    } catch (e) { log.push(`could not open ${addUrl}: ${e.message}`); }
  }
  // a whole story sent as JSON in a webhook
  if (payload.story && payload.story.url && payload.story.title){
    const s = build({ summary: '', date: iso(today), ...payload.story }, { name: payload.story.source || 'Sent in', category: 'policy' });
    if (s){ s.pinned = true; byUrl.set(s.url, s); log.push(`added story: ${s.title}`); }
  }

  // 2. the RSS feeds
  let okFeeds = 0;
  const results = await Promise.allSettled(FEEDS.map(async f => { try { return { f, items: parseFeed(await get(f.url)).slice(0, PER_FEED) }; } catch (e) { throw new Error(`${f.name}: ${e.message}`); } }));
  const fresh = [];
  for (const r of results){
    if (r.status !== 'fulfilled'){ log.push(`feed failed: ${r.reason?.message || r.reason}`); continue; }
    okFeeds++;
    const { f, items } = r.value; let n = 0;
    for (const it of items){
      if (daysAgo(it.date) > MAX_AGE_DAYS || known(it.url) || titles.has(it.title.toLowerCase())) continue;
      const s = build(it, f); if (!s) continue;
      byUrl.set(s.url, s); titles.add(s.title.toLowerCase()); fresh.push(s); n++;
    }
    log.push(`${f.name}: ${items.length} read, ${n} new pins`);
  }

  // 3. preview images for new stories that came without one
  let looked = 0;
  await Promise.allSettled(fresh.filter(s => !s.image).slice(0, IMAGE_LOOKUPS).map(async s => {
    looked++; const p = await pageInfo(s.url); if (p.image) s.image = p.image; if (!s.summary && p.summary) s.summary = p.summary;
  }));

  const stories = [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title)).slice(0, MAX_ITEMS);
  const out = { updated: new Date().toISOString(), feedsOk: okFeeds, feedsTotal: FEEDS.length, stories, removed: [...removed].slice(-300) };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(log.join('\n'));
  console.log(`live pins: ${stories.length} (${fresh.length} new, ${looked} image lookups), feeds ok: ${okFeeds}/${FEEDS.length}`);
}

export { parseFeed, locate, categorize, normUrl };
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch(e => { console.error(e); process.exit(1); });
