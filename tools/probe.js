#!/usr/bin/env node
// Valida MECANICAMENTE se um site de vagas dá pra raspar. Sem IA, sem chave, só HTTP.
//
//   node tools/probe.js https://algum-site-de-vagas.com.br/vagas/arquiteto
//
// Também é usado por tools/discover.js pra testar cada candidato.
//
// Veredito possível:
//   estruturado  -> tem JSON-LD JobPosting ou JSON embutido -> fácil de raspar
//   html         -> conteúdo server-side com cara de listagem -> raspável via HTML
//   spa          -> body vazio + bundle JS -> precisa navegador headless
//   bloqueado    -> captcha / Cloudflare / anti-bot
//   inacessivel  -> não respondeu 200
//   indefinido   -> revisar na mão

const { stripHtml } = require('../lib/keywords');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url, contentType: res.headers.get('content-type') || '', body, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

const ANTIBOT_RE = /just a moment|checking your browser|cf-browser-verification|captcha|hcaptcha|recaptcha|请开启|enable javascript to|attention required/i;
const JOBPOSTING_RE = /"@type"\s*:\s*"JobPosting"|itemtype=["'][^"']*schema\.org\/JobPosting/i;
const EMBEDDED_JSON_RE = /id=["']__NEXT_DATA__["']|<script[^>]+type=["']application\/json["']|window\.__(INITIAL_STATE|NUXT|APOLLO_STATE|PRELOADED_STATE)__|"props"\s*:\s*{[^}]*"pageProps"/i;
const LISTING_HINT_RE = /vaga|emprego|oportunidade|carreir|job|position|posi[çc][ãa]o/i;

async function checkRobots(origin) {
  const r = await fetchText(`${origin}/robots.txt`, 8000);
  if (!r.ok) return { status: r.status, protected: r.status === 403, disallowAll: false, note: r.status === 403 ? 'robots.txt retornou 403 (proteção ativa)' : null };
  const blocks = r.body.split(/\n(?=user-agent:)/i);
  const star = blocks.find((b) => /user-agent:\s*\*/i.test(b)) || '';
  const disallowAll = /disallow:\s*\/\s*($|\n)/i.test(star);
  return { status: r.status, protected: false, disallowAll, note: disallowAll ? 'robots.txt: Disallow / para todos' : null };
}

async function probe(url) {
  const out = { url, checkedAt: new Date().toISOString() };
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return { ...out, verdict: 'inacessivel', notes: ['URL inválida'] };
  }

  const [page, robots] = await Promise.all([fetchText(url), checkRobots(origin)]);
  out.robots = robots;
  out.status = page.status;
  out.ms = page.ms;

  if (!page.ok) {
    return { ...out, verdict: 'inacessivel', notes: [page.error || `HTTP ${page.status}`] };
  }

  const html = page.body || '';
  const text = stripHtml(html);
  const notes = [];
  if (page.finalUrl && page.finalUrl !== url) notes.push(`redirecionou para ${page.finalUrl}`);
  if (robots.note) notes.push(robots.note);

  const isJson = /json/i.test(page.contentType) || /^\s*[[{]/.test(html);
  const antibot = ANTIBOT_RE.test(html) && text.length < 3000;
  const hasJobPosting = JOBPOSTING_RE.test(html);
  const hasEmbeddedJson = EMBEDDED_JSON_RE.test(html);
  const scriptSrcCount = (html.match(/<script[^>]+src=/gi) || []).length;
  const looksThin = text.length < 800 && html.length > 2000; // pouco texto, muito markup/js
  const looksSpa = looksThin && (scriptSrcCount >= 2 || /id=["'](root|app|__next|__nuxt)["']/i.test(html));
  const listingHits = (text.match(new RegExp(LISTING_HINT_RE, 'gi')) || []).length;

  out.signals = { contentType: page.contentType, htmlBytes: html.length, textChars: text.length, scriptSrcCount, listingHits, isJson, hasJobPosting, hasEmbeddedJson, antibot, looksSpa };

  let verdict;
  if (antibot) verdict = 'bloqueado';
  else if (isJson && listingHits > 0) verdict = 'estruturado';
  else if (hasJobPosting || hasEmbeddedJson) verdict = 'estruturado';
  else if (!looksSpa && listingHits >= 3 && text.length > 1200) verdict = 'html';
  else if (looksSpa) verdict = 'spa';
  else verdict = 'indefinido';

  return { ...out, verdict, notes };
}

module.exports = { probe, fetchText };

if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.error('uso: node tools/probe.js <url>');
    process.exit(1);
  }
  probe(url).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    console.log(`\nVEREDITO: ${r.verdict}${r.notes && r.notes.length ? ` — ${r.notes.join('; ')}` : ''}`);
  });
}
