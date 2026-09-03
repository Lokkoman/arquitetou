// Coleta vagas e posts do LinkedIn via Bright Data Web Scraper API. O scraping roda na
// infra deles, sobre página pública, sem usar nenhuma sessão sua do LinkedIn. Sem
// BRIGHTDATA_API_TOKEN vira no-op.
//
// Fluxo assíncrono ("discover by keyword"):
//   POST /datasets/v3/trigger?dataset_id=&type=discover_new&discover_by=keyword&format=json
//        body: [ { location, keyword, country, time_range, remote? }, ... ]  -> { snapshot_id }
//   GET  /datasets/v3/progress/<snapshot_id>              -> { status }
//   GET  /datasets/v3/snapshot/<snapshot_id>?format=json  -> [ ...registros ]
// Inputs estruturados (não montamos URL de busca do LinkedIn), então não quebram quando
// o LinkedIn muda f_TPR/f_WT/geoId.
//
// Config (secrets/vars do repo):
//   BRIGHTDATA_API_TOKEN / BRIGHTDATA_JOBS_DATASET   obrigatórios
//   BRIGHTDATA_API_TOKEN_2 / BRIGHTDATA_JOBS_DATASET_2   2ª conta, failover sem crédito
//   BRIGHTDATA_POSTS_DATASET       scraper de posts (opcional — dobra o consumo)
//   BRIGHTDATA_POLL_TIMEOUT_MS     sobrescreve o timeout por modo

const fs = require('fs');
const path = require('path');
const {
  matchArchitectureKeyword,
  detectSeniority,
  resolveCityOrRemote,
  detectWorkplaceType,
  makeId,
  stripHtml,
  snippet,
} = require('../lib/keywords');
const { BD_ROLE_KEYWORDS, BD_TOOL_KEYWORDS } = require('../lib/searchTerms');

// Estado entre rodadas: data da última coleta OK + snapshot pendente.
const STATE_FILE = path.join(__dirname, '..', 'site', 'public', 'data', 'linkedin-state.json');
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}
function writeState(patch) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch (err) {
    console.error(`[linkedin-state] não salvou: ${err.message}`);
  }
}

// Erro que parece "conta sem crédito / inativa" -> tenta a 2ª key.
const EXHAUSTED_RE = /HTTP 402|HTTP 429|\bcredit|\bquota|balance|not active|payment required|limit reached|insufficient/i;

const API = 'https://api.brightdata.com/datasets/v3';
const POLL_INTERVAL_MS = 6000;

// 1 crédito por registro (free tier 5.000/mês por conta). A busca do LinkedIn por
// keyword degrada com muitas palavras (vira ~AND), então cada termo é curto e separado.
// Termos vêm de lib/searchTerms (tier 'core'): ROLE = cargos+escopo (São Paulo + remoto),
// TOOL = programas (só São Paulo).
const ROLE_KEYWORDS = [...BD_ROLE_KEYWORDS, 'architect']; // vagas em inglês
const TOOL_KEYWORDS = BD_TOOL_KEYWORDS; // AutoCAD · ArchiCAD · SketchUp · Revit · BIM
const POST_KEYWORD_GROUPS = [
  'vaga arquitetura e urbanismo',
  'contrata arquiteto regularização licenciamento',
  'vaga projetista AutoCAD Revit SketchUp',
];

// Janelas por modo. limitTotal = teto rígido de registros (= créditos da rodada).
// timeoutMs = quanto esperamos o snapshot ficar `ready`; se estourar, ele é salvo e
// recuperado na rodada seguinte (pendingJobsSnapshot).
const WINDOWS = {
  // backfill (1×): ~30 dias.
  backfill: { timeRange: 'Past month', postsDate: 'past-month', limitPerInput: 60, limitTotal: 1200, timeoutMs: 25 * 60 * 1000 },
  // incremental: janela de 24h. Real ~120-180/rodada; teto rígido 300/rodada.
  incremental: { timeRange: 'Past 24 hours', postsDate: 'past-24h', limitPerInput: 20, limitTotal: 300, timeoutMs: 10 * 60 * 1000 },
  // catchup: janela de 7 dias — pull semanal, ou quando a rodada anterior falhou.
  catchup: { timeRange: 'Past week', postsDate: 'past-week', limitPerInput: 30, limitTotal: 700, timeoutMs: 18 * 60 * 1000 },
};
const INCREMENTAL_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const CATCHUP_AFTER_MS = 30 * 60 * 60 * 1000;

function jobsSearchInputs(timeRange) {
  const inputs = [];
  const base = { country: 'BR', time_range: timeRange };
  // Cada termo roda 2×: raio de São Paulo + passada nacional filtrando remoto (pega
  // vaga remota de qualquer estado).
  for (const kw of [...ROLE_KEYWORDS, ...TOOL_KEYWORDS]) {
    inputs.push({ location: 'São Paulo, Brasil', keyword: kw, ...base });
    inputs.push({ location: 'Brasil', keyword: kw, remote: 'Remote', ...base });
  }
  return inputs;
}

function postsSearchUrls(datePosted) {
  return POST_KEYWORD_GROUPS.map(
    (kw) =>
      `https://www.linkedin.com/search/results/content/?${new URLSearchParams({
        keywords: kw,
        datePosted: `"${datePosted}"`,
      }).toString()}`
  );
}

async function bd(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bright Data ${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Dispara o scraper, devolve o snapshot_id.
async function triggerDataset({ token, datasetId, inputs, onLog, discoverBy = null, limitPerInput = 0, limitTotal = 0 }) {
  const qs = new URLSearchParams({ dataset_id: datasetId, format: 'json' });
  if (discoverBy) {
    qs.set('type', 'discover_new');
    qs.set('discover_by', discoverBy);
  }
  if (limitPerInput > 0) qs.set('limit_per_input', String(limitPerInput));
  if (limitTotal > 0) qs.set('limit_multiple_results', String(limitTotal));
  const trigger = await bd(`/trigger?${qs.toString()}`, { method: 'POST', token, body: inputs });
  const snapshotId = trigger && (trigger.snapshot_id || trigger.snapshotId);
  if (!snapshotId) throw new Error(`trigger sem snapshot_id: ${JSON.stringify(trigger).slice(0, 200)}`);
  onLog(`snapshot ${snapshotId} disparado (${inputs.length} busca(s))`);
  return snapshotId;
}

// Espera o snapshot ficar `ready` e baixa os registros. No timeout, lança erro com
// `.snapshotId` pro chamador recuperar na próxima rodada.
async function fetchSnapshot(token, snapshotId, timeoutMs, onLog) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const prog = await bd(`/progress/${snapshotId}`, { token });
    const status = prog && prog.status;
    if (status === 'ready') break;
    if (status === 'failed' || status === 'error') {
      const e = new Error(`coleta ${snapshotId} falhou (status=${status})`);
      e.snapshotDead = true;
      throw e;
    }
    if (Date.now() > deadline) {
      if (onLog) onLog(`timeout aguardando snapshot ${snapshotId} (status=${status}) — será recuperado na próxima rodada`);
      const e = new Error(`timeout aguardando snapshot ${snapshotId} (status=${status})`);
      e.snapshotId = snapshotId;
      throw e;
    }
  }
  const rows = await bd(`/snapshot/${snapshotId}?format=json`, { token });
  return Array.isArray(rows) ? rows : [];
}

// trigger + fetch.
async function runDataset({ token, datasetId, inputs, timeoutMs, onLog, discoverBy = null, limitPerInput = 0, limitTotal = 0 }) {
  const snapshotId = await triggerDataset({ token, datasetId, inputs, onLog, discoverBy, limitPerInput, limitTotal });
  return fetchSnapshot(token, snapshotId, timeoutMs, onLog);
}

// --- Normalização: registro do Bright Data -> vaga interna ---

const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
};

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeJob(rec, stats) {
  const bump = (k) => stats && (stats[k] = (stats[k] || 0) + 1);
  const url = pick(rec, 'url', 'job_url', 'link', 'job_posting_url');
  if (!url) return bump('noUrl'), null;
  const title = pick(rec, 'job_title', 'title', 'position');
  const company = pick(rec, 'company_name', 'company', 'employer', 'companyName');
  const locationText = pick(rec, 'job_location', 'location', 'city', 'job_location_text');
  const descriptionRaw = pick(rec, 'job_summary', 'job_description_formatted', 'job_description', 'description', 'summary');
  const description = stripHtml(String(descriptionRaw || ''));
  const postedAt = toIso(pick(rec, 'job_posted_date', 'job_posted_time', 'posted_date', 'date_posted', 'listed_at'));
  // Local buscado — fallback quando o texto de localização da vaga não resolve.
  const searchedLoc = rec && rec.input && rec.input.location;
  const searchedRemote = !!(rec && rec.input && rec.input.remote);

  // strict:false: a busca já foi por palavra de arquitetura; o LLM descarta o resto.
  const matchedKeyword = matchArchitectureKeyword(title, description, { strict: false });
  if (!matchedKeyword) return bump('noMatch'), null;
  const remoteHint = searchedRemote || /remote|remoto|home\s*office|100%\s*remoto/i.test(`${locationText} ${title} ${description.slice(0, 400)}`);
  let city = resolveCityOrRemote(locationText, { isRemote: remoteHint });
  if (!city && searchedLoc) city = resolveCityOrRemote(searchedLoc, { isRemote: remoteHint });
  if (!city) return bump('noCity'), null;
  bump('kept');

  return {
    id: makeId(['linkedin', url]),
    title,
    company: company || 'Empresa não informada',
    location: locationText || city.label,
    cityKey: city.key,
    cityLabel: city.label,
    source: 'LinkedIn',
    sourceId: 'linkedin-api',
    sourceType: 'scraped',
    postType: 'job',
    seniority: detectSeniority(`${title} ${description}`),
    workplaceType: detectWorkplaceType(`${title} ${locationText} ${description}`),
    matchedKeyword,
    postedAt,
    url,
    description,
    descriptionSnippet: snippet(description),
    collectedAt: new Date().toISOString(),
  };
}

function normalizePost(rec) {
  const url = pick(rec, 'url', 'post_url', 'link', 'permalink');
  const text = stripHtml(String(pick(rec, 'post_text', 'text', 'content', 'description') || ''));
  if (!url || !text) return null;
  const author = pick(rec, 'author_name', 'account_name', 'user_name', 'poster_name', 'author');
  const postedAt = toIso(pick(rec, 'date_posted', 'posted_at', 'created_at', 'time'));

  // Post é texto livre: regex só de pré-filtro; o LLM decide relevância.
  const matchedKeyword = matchArchitectureKeyword(text, '', { strict: false });
  if (!matchedKeyword) return null;
  const city = resolveCityOrRemote(text, { isRemote: /remoto|home\s*office|100%\s*remoto/i.test(text) });

  return {
    id: makeId(['linkedin-post', url]),
    title: `Post de ${author || 'recrutador'} no LinkedIn`,
    company: author || 'LinkedIn (post)',
    location: city ? city.label : 'Não informado',
    cityKey: city ? city.key : 'nao_informado',
    cityLabel: city ? city.label : 'Não informado',
    source: 'LinkedIn (posts)',
    sourceId: 'linkedin-post',
    sourceType: 'scraped',
    postType: 'feed-post',
    seniority: detectSeniority(text),
    workplaceType: detectWorkplaceType(text),
    matchedKeyword,
    postedAt,
    url,
    description: text,
    descriptionSnippet: snippet(text),
    collectedAt: new Date().toISOString(),
  };
}

// Coleta com a 1ª key; se der erro de crédito/conta e houver 2ª key, repete com ela.
async function collectJobsWithFailover({ inputs, win, timeoutMs, log }) {
  const keys = [
    { token: process.env.BRIGHTDATA_API_TOKEN, datasetId: process.env.BRIGHTDATA_JOBS_DATASET, n: 1 },
  ];
  if (process.env.BRIGHTDATA_API_TOKEN_2 && process.env.BRIGHTDATA_JOBS_DATASET_2) {
    keys.push({ token: process.env.BRIGHTDATA_API_TOKEN_2, datasetId: process.env.BRIGHTDATA_JOBS_DATASET_2, n: 2 });
  }
  let lastErr;
  for (const key of keys) {
    try {
      const rows = await runDataset({
        token: key.token,
        datasetId: key.datasetId,
        inputs,
        discoverBy: 'keyword',
        limitPerInput: win.limitPerInput,
        limitTotal: win.limitTotal,
        timeoutMs,
        onLog: log,
      });
      return { rows, usedKey: key.n };
    } catch (err) {
      lastErr = err;
      if (err.snapshotId && !err.usedKey) err.usedKey = key.n;
      const canFailover = key.n < keys.length && EXHAUSTED_RE.test(err.message);
      log(`key ${key.n} falhou: ${err.message.slice(0, 120)}${canFailover ? ` — tentando key ${key.n + 1}` : ''}`);
      if (!canFailover) throw err;
    }
  }
  throw lastErr;
}

/**
 * mode: 'backfill' (30d) | 'incremental' (24h; vira 'catchup' de 7d se a rodada anterior
 *       falhou) | 'off'
 * Retorna { jobs, ok, note, sampleKeys, usedKey }. Sem token/dataset -> no-op silencioso.
 */
async function collectLinkedIn({ mode = 'off', onProgress } = {}) {
  const log = (m) => (onProgress ? onProgress(m) : undefined);
  if (mode === 'off') return { jobs: [], ok: true, note: 'LinkedIn (Bright Data) desligado.' };

  const token = process.env.BRIGHTDATA_API_TOKEN;
  const token2 = process.env.BRIGHTDATA_API_TOKEN_2;
  const jobsDataset = process.env.BRIGHTDATA_JOBS_DATASET;
  const postsDataset = process.env.BRIGHTDATA_POSTS_DATASET;

  if (!token || !jobsDataset) {
    return {
      jobs: [],
      ok: true,
      note: 'BRIGHTDATA_API_TOKEN / BRIGHTDATA_JOBS_DATASET não definidos — LinkedIn via API pulado.',
    };
  }

  // incremental vira catch-up (7 dias) se a última coleta OK foi há muito tempo.
  const state = readState();
  const lastOkMs = state.lastOkAt ? Date.parse(state.lastOkAt) : 0;
  const stale = lastOkMs && Date.now() - lastOkMs > CATCHUP_AFTER_MS;
  const effectiveMode = mode === 'incremental' && stale ? 'catchup' : mode;
  if (effectiveMode !== mode) {
    log(`última coleta OK em ${state.lastOkAt} — entrando em catch-up (janela de 7 dias)`);
  }

  const win = WINDOWS[effectiveMode] || WINDOWS.incremental;
  const timeoutMs = Number(process.env.BRIGHTDATA_POLL_TIMEOUT_MS) || win.timeoutMs || 480000;
  const out = [];
  const errors = [];
  const sampleKeys = {};
  const stats = { kept: 0, noUrl: 0, noMatch: 0, noCity: 0 };
  const rejects = [];
  const sampleReject = (rec, why) => {
    if (rejects.length >= 40) return;
    rejects.push({
      why,
      title: pick(rec, 'job_title', 'title') || null,
      location: pick(rec, 'job_location', 'location') || null,
      searched: rec && rec.input ? rec.input.location : null,
      snippet: stripHtml(String(pick(rec, 'job_summary', 'job_description_formatted') || '')).slice(0, 160),
    });
  };
  let usedKey = 1;

  // Snapshot pendente de uma rodada que estourou o timeout: tenta baixar antes de
  // disparar de novo (não gasta crédito extra).
  const recoveredIds = new Set();
  const pend = state.pendingJobsSnapshot;
  if (pend && pend.id) {
    const pendToken = pend.key === 2 && token2 ? token2 : token;
    try {
      const rows = await fetchSnapshot(pendToken, pend.id, 3 * 60 * 1000, log);
      if (rows[0]) sampleKeys.job = Object.keys(rows[0]);
      for (const rec of rows) {
        const nm = stats.noMatch, nc = stats.noCity;
        const job = normalizeJob(rec, stats);
        if (job) {
          out.push(job);
          recoveredIds.add(job.id);
        } else if (stats.noMatch > nm) sampleReject(rec, 'sem-match');
        else if (stats.noCity > nc) sampleReject(rec, 'sem-cidade');
      }
      log(`snapshot pendente ${pend.id} (${pend.mode || '?'}): ${rows.length} registro(s) -> ${out.length} após filtro`);
      writeState({ pendingJobsSnapshot: null });
    } catch (err) {
      if (err.snapshotId) log(`snapshot pendente ${pend.id} ainda processando — mantém pra próxima`);
      else {
        log(`snapshot pendente ${pend.id} descartado: ${err.message.slice(0, 120)}`);
        writeState({ pendingJobsSnapshot: null });
      }
    }
  }

  // --- Vagas ---
  try {
    const inputs = jobsSearchInputs(win.timeRange);
    const res = await collectJobsWithFailover({ inputs, win, timeoutMs, log });
    const rows = res.rows;
    usedKey = res.usedKey;
    if (rows[0]) sampleKeys.job = Object.keys(rows[0]);
    for (const rec of rows) {
      const nm = stats.noMatch, nc = stats.noCity;
      const job = normalizeJob(rec, stats);
      if (job) out.push(job);
      else if (stats.noMatch > nm) sampleReject(rec, 'sem-match');
      else if (stats.noCity > nc) sampleReject(rec, 'sem-cidade');
    }
    log(`vagas: ${rows.length} registro(s) -> ${out.length} após filtro (key ${usedKey})`);
  } catch (err) {
    errors.push(`vagas: ${err.message}`);
    if (err.snapshotId) {
      writeState({
        pendingJobsSnapshot: { id: err.snapshotId, key: err.usedKey || 1, mode: effectiveMode, at: new Date().toISOString() },
      });
      log(`snapshot ${err.snapshotId} salvo — recuperado na próxima rodada`);
    }
  }

  // --- Posts (só se BRIGHTDATA_POSTS_DATASET) ---
  // Ao ligar, confirme o modo do scraper de posts (aqui assume "collect by url").
  if (postsDataset) {
    try {
      const rows = await runDataset({
        token,
        datasetId: postsDataset,
        inputs: postsSearchUrls(win.postsDate).map((url) => ({ url })),
        timeoutMs,
        onLog: log,
      });
      if (rows[0]) sampleKeys.post = Object.keys(rows[0]);
      let kept = 0;
      for (const rec of rows) {
        const post = normalizePost(rec);
        if (post) {
          out.push(post);
          kept += 1;
        }
      }
      log(`posts: ${rows.length} registro(s) -> ${kept} após filtro`);
    } catch (err) {
      errors.push(`posts: ${err.message}`);
    }
  }

  // incremental corta p/ 48h (folga sobre a janela de 24h); catch-up mantém os 7 dias.
  let jobs = out;
  if (effectiveMode === 'incremental') {
    const cutoff = Date.now() - INCREMENTAL_MAX_AGE_MS;
    jobs = jobs.filter((j) => recoveredIds.has(j.id) || !j.postedAt || Date.parse(j.postedAt) >= cutoff);
  }

  // Dedupe por id.
  const byId = new Map();
  for (const j of jobs) if (!byId.has(j.id)) byId.set(j.id, j);

  // Diagnóstico do filtro + amostra de descartadas.
  const totalSeen = stats.kept + stats.noUrl + stats.noMatch + stats.noCity;
  if (totalSeen) {
    log(`filtro: ${stats.kept} ok · ${stats.noMatch} sem-match · ${stats.noCity} sem-cidade · ${stats.noUrl} sem-url (de ${totalSeen})`);
    try {
      fs.writeFileSync(
        path.join(path.dirname(STATE_FILE), 'linkedin-rejected-sample.json'),
        JSON.stringify({ at: new Date().toISOString(), mode: effectiveMode, stats, rejects }, null, 2)
      );
    } catch (err) {
      log(`amostra de rejeitadas não salva: ${err.message}`);
    }
  }

  const ok = errors.length === 0;
  // Marca "coleta OK" só sem erro — uma rodada que falhou deixa a próxima em catch-up.
  if (ok) writeState({ lastOkAt: new Date().toISOString(), lastMode: effectiveMode, lastKey: usedKey });

  return {
    jobs: [...byId.values()],
    ok,
    note: errors.length ? `Bright Data: ${errors.join(' | ')}` : null,
    sampleKeys,
    usedKey,
  };
}

module.exports = { collectLinkedIn };
