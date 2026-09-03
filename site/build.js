#!/usr/bin/env node
// Gera o site ESTÁTICO em public/ — sem servidor rodando.
//
//   node site/build.js                     (CI) raspa as fontes + classifica com LLM
//   node site/build.js --no-scrape         usa o data/jobs.json já existente
//   node site/build.js --no-native         não raspa as fontes nativas; remonta a partir
//                                          de parts/ (collect.yml) + retenção 90d + LinkedIn.
//                                          É o modo do ciclo agendado (collect.yml).
//   node site/build.js --no-ai             pula a classificação por LLM
//   node site/build.js --linkedin=backfill puxa 30d do LinkedIn via Bright Data (1ª vez)
//   node site/build.js --linkedin=incremental  puxa 48h do LinkedIn e faz upsert dessa janela
//   (sem --linkedin, ou --linkedin=off: não toca no LinkedIn via API)
//
// Saída: public/data/{jobs,sources,deeplinks,firms}.json — é o que o public/app.js lê.
//
// Cache da classificação: vagas que já têm o campo `ai` no public/data/jobs.json
// anterior são reaproveitadas, então cada rodada só paga o LLM pelas vagas novas.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DATA = path.join(ROOT, 'site', 'public', 'data');
const DATA_DIR = path.join(ROOT, 'data');

const args = new Set(process.argv.slice(2));
const NO_SCRAPE = args.has('--no-scrape');
const NO_NATIVE = args.has('--no-native');
const NO_AI = args.has('--no-ai');
const LINKEDIN_MODE = (() => {
  const a = process.argv.slice(2).find((s) => s.startsWith('--linkedin='));
  const m = a ? a.split('=')[1] : process.env.LINKEDIN_MODE || 'off';
  return ['off', 'backfill', 'incremental'].includes(m) ? m : 'off';
})();
const LINKEDIN_UPSERT_WINDOW_MS = 48 * 60 * 60 * 1000;
const RELEVANCE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  escrito ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024).toFixed(1)} kB)`);
}

// Título normalizado p/ agrupar a mesma vaga de fontes diferentes. Mantém a
// senioridade (pleno/júnior são vagas distintas), tira só ruído de formatação.
function titleKey(title = '') {
  return String(title)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(vaga|urgente|efetivo|clt|pj|home ?office|h[íi]brido|presencial|remoto|contrata-?se|oportunidade)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const MERGE_MAX_GAP_MS = 45 * 24 * 60 * 60 * 1000;

// Junta vagas iguais de fontes diferentes numa só; todos os links vão em job.links.
function mergeCrossSource(jobs) {
  const linkOf = (j) => ({ source: j.source, sourceId: j.sourceId, url: j.url });
  const groups = new Map();
  for (const job of jobs) {
    const company = (job.company || '').toLowerCase().trim();
    const tk = titleKey(job.title);
    // Só agrupa com empresa real + título com conteúdo + cidade.
    const mergeable = company && !/n[ãa]o informad|confidencial|empresa$/.test(company) && tk.length >= 5 && job.cityKey;
    const key = mergeable ? `${company}|${tk}|${job.cityKey}` : `solo:${job.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  const out = [];
  let merged = 0;
  for (const grp of groups.values()) {
    // Título igual com 45+ dias de diferença = recontratação, não duplicata.
    grp.sort((a, b) => (Date.parse(a.postedAt || 0) || 0) - (Date.parse(b.postedAt || 0) || 0));
    const clusters = [];
    for (const job of grp) {
      const t = Date.parse(job.postedAt || 0) || 0;
      const c = clusters.find((cl) => !t || !cl.t || Math.abs(t - cl.t) <= MERGE_MAX_GAP_MS);
      if (c) {
        c.items.push(job);
        if (t) c.t = t;
      } else {
        clusters.push({ t, items: [job] });
      }
    }
    for (const cl of clusters) {
      const items = cl.items;
      if (items.length === 1) {
        items[0].links = [linkOf(items[0])];
        out.push(items[0]);
        continue;
      }
      // Base = descrição mais rica (empate: mais recente).
      items.sort((a, b) => (b.description || '').length - (a.description || '').length || (Date.parse(b.postedAt || 0) || 0) - (Date.parse(a.postedAt || 0) || 0));
      const base = items[0];
      const srcSeen = new Set();
      base.links = [];
      for (const j of items) {
        // 1 link por fonte.
        if (j.url && !srcSeen.has(j.sourceId)) {
          srcSeen.add(j.sourceId);
          base.links.push(linkOf(j));
        }
      }
      base.sources = [...srcSeen];
      const dates = items.map((j) => Date.parse(j.postedAt || 0)).filter(Boolean);
      if (dates.length) base.postedAt = new Date(Math.min(...dates)).toISOString();
      merged += items.length - 1;
      out.push(base);
    }
  }
  if (merged) console.log(`[build-site] ${merged} vaga(s) duplicada(s) entre fontes juntadas (${out.length} únicas)`);
  return out;
}

async function main() {
  const startedAt = new Date().toISOString();
  const scrapeMode = NO_SCRAPE ? 'cache-local' : NO_NATIVE ? 'no-native' : 'full';
  console.log(`[build-site] início ${startedAt}  (scrape=${scrapeMode} ai=${!NO_AI} linkedin=${LINKEDIN_MODE})`);

  const prev = readJson(path.join(PUBLIC_DATA, 'jobs.json'), { jobs: [] });
  const prevJobs = prev.jobs || [];

  // 1. Vagas + status das fontes nativas. O LinkedIn nativo é pulado quando o LinkedIn
  //    vem pela Bright Data.
  const skipNativeLinkedin = LINKEDIN_MODE !== 'off';
  let jobs;
  let sourcesStatus;
  if (NO_SCRAPE) {
    jobs = readJson(path.join(DATA_DIR, 'jobs.json'), { jobs: [] }).jobs || [];
    sourcesStatus = readJson(path.join(DATA_DIR, 'sources-status.json'), { sources: {} });
    console.log(`[build-site] --no-scrape: ${jobs.length} vagas do cache local`);
  } else if (NO_NATIVE) {
    // Sem scrape monolítico: as nativas entram por parts/ (1a), o resto pela retenção
    // (1c). Carrega o status anterior pra caixa "Fontes" não zerar.
    jobs = [];
    const prevSources = readJson(path.join(PUBLIC_DATA, 'sources.json'), { sources: {} });
    sourcesStatus = { sources: prevSources.sources || {} };
    console.log('[build-site] --no-native: sem scrape monolítico (parts/ + retenção 90d)');
  } else {
    const { refreshAll } = require('../collector');
    const out = await refreshAll({
      skip: skipNativeLinkedin ? ['linkedin'] : [],
      onProgress: (id, s) => console.log(`  [${id}] ${s.ok ? 'ok' : 'ERRO'} — ${s.jobsFound} vaga(s)`),
    });
    jobs = out.jobs;
    sourcesStatus = { sources: out.sourcesStatus };
    console.log(`[build-site] scraping: ${jobs.length} vagas`);
    for (const [id, s] of Object.entries(out.sourcesStatus)) {
      const errs = s.errors || [];
      if (errs.length) console.log(`  [${id}] ${errs.length} erro(s) de consulta — ex.: ${errs.slice(0, 3).join(' | ')}`);
    }
  }

  // 1a. Parts de collector/run-source.js. O part vence o scrape monolítico (é mais fresco).
  try {
    const partsDir = path.join(PUBLIC_DATA, 'parts');
    const files = fs.existsSync(partsDir) ? fs.readdirSync(partsDir).filter((f) => f.endsWith('.json')) : [];
    for (const file of files) {
      const part = readJson(path.join(partsDir, file), null);
      if (!part || !Array.isArray(part.jobs) || !part.sourceId) continue;
      jobs = jobs.filter((j) => j.sourceId !== part.sourceId).concat(part.jobs);
      sourcesStatus.sources = sourcesStatus.sources || {};
      sourcesStatus.sources[part.sourceId] = {
        name: part.name || part.sourceId,
        ok: part.ok !== false,
        verdict: part.verdict || null,
        aborted: !!part.aborted,
        jobsFound: part.jobs.length,
        queriesRun: part.queriesRun || null,
        durationMs: part.durationMs || null,
        errors: part.errors || [],
        errorCount: part.errorCount != null ? part.errorCount : (part.errors || []).length,
        lastRunAt: part.collectedAt || null,
        note: part.note || 'Coletado em workflow próprio.',
      };
      console.log(`[build-site] part ${part.sourceId}: ${part.jobs.length} vaga(s) (${part.collectedAt || '?'})`);
    }
  } catch (err) {
    console.error(`[build-site] falha ao ler parts/: ${err.message}`);
  }

  // 1b. LinkedIn via Bright Data: linkedin-api (vagas) + linkedin-post (posts).
  //     backfill substitui tudo; incremental faz upsert da janela de 48h.
  const LI_API_SOURCES = new Set(['linkedin-api', 'linkedin-post']);
  let linkedinInfo = null;
  if (LINKEDIN_MODE !== 'off') {
    const { collectLinkedIn } = require('../collector/linkedin-brightdata');
    const res = await collectLinkedIn({
      mode: LINKEDIN_MODE,
      onProgress: (m) => console.log(`  [linkedin/${LINKEDIN_MODE}] ${m}`),
    });
    const freshById = new Map(res.jobs.map((j) => [j.id, j]));
    const prevLi = prevJobs.filter((j) => LI_API_SOURCES.has(j.sourceId));

    let mergedLi;
    if (LINKEDIN_MODE === 'backfill') {
      mergedLi = res.jobs;
    } else {
      // Upsert: mantém o que não voltou agora, o fresco vence em id repetido.
      const kept = prevLi.filter((j) => !freshById.has(j.id));
      mergedLi = [...kept, ...res.jobs];
    }
    const cutoff90 = Date.now() - RELEVANCE_WINDOW_MS;
    mergedLi = mergedLi.filter((j) => !j.postedAt || Date.parse(j.postedAt) >= cutoff90);

    jobs = [...jobs.filter((j) => !LI_API_SOURCES.has(j.sourceId)), ...mergedLi];
    linkedinInfo = {
      mode: LINKEDIN_MODE,
      fetched: res.jobs.length,
      total: mergedLi.length,
      ok: res.ok,
      note: res.note || null,
      sampleKeys: res.sampleKeys || null,
    };
    console.log(
      `[build-site] LinkedIn/${LINKEDIN_MODE}: ${res.jobs.length} da API, ${mergedLi.length} no total da fonte` +
        (res.note ? ` — ${res.note}` : '')
    );
    if (res.sampleKeys && (res.sampleKeys.job || res.sampleKeys.post)) {
      console.log(`[build-site] campos do Bright Data: ${JSON.stringify(res.sampleKeys)}`);
    }
  } else {
    // Sem tocar na API: preserva o LinkedIn já publicado.
    const prevLi = prevJobs.filter((j) => LI_API_SOURCES.has(j.sourceId));
    if (prevLi.length && !jobs.some((j) => LI_API_SOURCES.has(j.sourceId))) {
      jobs = [...jobs, ...prevLi];
    }
  }

  // 1c. Retenção: mantém vagas das gerações anteriores dentro da janela de 90 dias,
  //     mesmo que uma fonte tenha voltado com menos nesta rodada.
  {
    const cutoff = Date.now() - RELEVANCE_WINDOW_MS;
    const have = new Set(jobs.map((j) => j.id));
    let kept = 0;
    for (const pj of prevJobs) {
      if (have.has(pj.id)) continue;
      const postedMs = pj.postedAt ? Date.parse(pj.postedAt) : 0;
      if (postedMs && postedMs < cutoff) continue;
      jobs.push(pj);
      kept += 1;
    }
    if (kept) console.log(`[build-site] ${kept} vaga(s) mantidas de gerações anteriores (janela 90d)`);
  }

  // 2. Reaproveita a classificação já feita (cache por id).
  const prevAi = new Map((prev.jobs || []).filter((j) => j.ai).map((j) => [j.id, j.ai]));
  let reused = 0;
  for (const job of jobs) {
    if (!job.ai && prevAi.has(job.id)) {
      job.ai = prevAi.get(job.id);
      reused += 1;
    }
  }
  if (reused) console.log(`[build-site] ${reused} classificação(ões) reaproveitada(s) do cache`);

  // 3. Enriquecimento por LLM (best-effort).
  let aiInfo = { enriched: 0, dropped: 0, skipped: jobs.length, ok: true, note: 'IA desligada (--no-ai).' };
  if (!NO_AI) {
    const { enrichJobs } = require('../lib/classify');
    const res = await enrichJobs(jobs, {
      onProgress: (done, total) => console.log(`  [classify] ${done}/${total}`),
    });
    jobs = res.jobs;
    aiInfo = res;
    console.log(
      `[build-site] IA: ${res.enriched} nova(s), ${res.skipped} em cache, ${res.dropped} descartada(s) como irrelevante` +
        (res.note ? ` — ${res.note}` : '')
    );
  }

  // Re-roda o reconhecedor (lib/segments.js) em toda vaga — palavra-chave, segmento e
  // badge acompanham a lista canônica mesmo no cache/retenção. Descarta fora do Brasil
  // ou fora do filtro atual.
  const { jobSegments, classifyFacets, isForeignLocation, looksBrazilian } = require('../lib/keywords');
  const before = jobs.length;
  jobs = jobs.filter((job) => {
    const loc = `${job.location || ''} ${job.cityLabel || ''}`;
    if (isForeignLocation(loc)) return false;
    // Vaga da retenção rotulada "{Cidade} (remoto)" sem sinal de Brasil = estrangeira
    // (Houston, St. Louis...) — descarta.
    if (job.cityKey === 'remoto' && / \(remoto\)$/.test(job.cityLabel || '') && !looksBrazilian(loc)) return false;
    // null = descartar.
    const cls = jobSegments(job.title, job.description, { strict: true });
    if (!cls) return false;
    job.matchedKeyword = cls.label;
    job.segments = cls.segments;
    job.category = cls.segments[0]; // principal
    // 3 eixos: cargo / escopo / programa.
    const f = classifyFacets(job.title, job.description);
    job.roles = f.roles;
    job.scope = f.scope;
    job.tools = f.tools;
    return true;
  });
  if (jobs.length !== before) {
    console.log(`[build-site] ${before - jobs.length} vaga(s) descartada(s) (fora do Brasil ou fora do filtro atual)`);
  }

  // Dedupe entre fontes: chave = empresa + título normalizado + cidade.
  jobs = mergeCrossSource(jobs);

  jobs.sort((a, b) => {
    const da = a.postedAt ? Date.parse(a.postedAt) : 0;
    const db = b.postedAt ? Date.parse(b.postedAt) : 0;
    return db - da;
  });

  // 4. Escreve os JSON estáticos.
  const generatedAt = new Date().toISOString();
  writeJson(path.join(PUBLIC_DATA, 'jobs.json'), { updatedAt: generatedAt, total: jobs.length, jobs });

  // Status separado: linkedin-api (vagas) e linkedin-post (posts).
  const linkedinApiCount = jobs.filter((j) => j.sourceId === 'linkedin-api').length;
  const linkedinPostCount = jobs.filter((j) => j.sourceId === 'linkedin-post').length;
  if (linkedinApiCount || (sourcesStatus.sources && sourcesStatus.sources['linkedin-api'])) {
    sourcesStatus.sources = sourcesStatus.sources || {};
    const prevLiStatus = sourcesStatus.sources['linkedin-api'] || {};
    sourcesStatus.sources['linkedin-api'] = {
      name: 'LinkedIn (vagas)',
      ok: linkedinInfo ? linkedinInfo.ok : prevLiStatus.ok !== false,
      jobsFound: linkedinApiCount,
      errors: linkedinInfo && linkedinInfo.note ? [linkedinInfo.note] : [],
      lastRunAt: linkedinInfo ? generatedAt : prevLiStatus.lastRunAt || null,
      note:
        (linkedinInfo && `Modo ${linkedinInfo.mode}: ${linkedinInfo.fetched} da API.`) ||
        prevLiStatus.note ||
        'Vagas do LinkedIn via API pública (Bright Data) — sem usar conta do LinkedIn.',
    };
  }
  if (linkedinPostCount || (sourcesStatus.sources && sourcesStatus.sources['linkedin-post'])) {
    sourcesStatus.sources = sourcesStatus.sources || {};
    const prevPostStatus = (sourcesStatus.sources && sourcesStatus.sources['linkedin-post']) || {};
    sourcesStatus.sources['linkedin-post'] = {
      name: 'LinkedIn (posts)',
      ok: linkedinInfo ? linkedinInfo.ok : prevPostStatus.ok !== false,
      jobsFound: linkedinPostCount,
      errors: [],
      lastRunAt: linkedinInfo ? generatedAt : prevPostStatus.lastRunAt || null,
      note:
        prevPostStatus.note ||
        'Posts de recrutadores no feed do LinkedIn (Bright Data). Texto livre — a IA extrai os campos.',
    };
  }

  writeJson(path.join(PUBLIC_DATA, 'sources.json'), {
    ...sourcesStatus,
    lastRun: generatedAt,
    startedAt,
    finishedAt: generatedAt,
    linkedin: linkedinInfo,
    ai: {
      model: aiInfo.model || null,
      enriched: aiInfo.enriched,
      dropped: aiInfo.dropped,
      cached: aiInfo.skipped,
      ok: aiInfo.ok,
      note: aiInfo.note || null,
    },
  });

  // Diagnóstico de coleta: grava health.json + history.jsonl, emite ::warning::.
  // Pulado no --no-native (não houve coleta; quem grava é o collect.yml).
  if (NO_NATIVE) {
    console.log('[build-site] health: --no-native, mantém o health.json da última coleta');
  } else {
    try {
      const { assessHealth } = require('../tools/health');
      const health = assessHealth({ sources: sourcesStatus.sources || {} });
      if (health.alerts.length) {
        for (const a of health.alerts) console.log(`::warning title=coleta::${a}`);
        console.log(
          `[build-site] health: ${health.alerts.length} alerta(s). Reprocessar: ${health.needsReprocess.join(', ') || '—'}`
        );
      } else {
        console.log('[build-site] health: todas as fontes OK');
      }
    } catch (err) {
      console.error(`[health] falhou (ignorado): ${err.message}`);
    }
  }

  const { build: buildDeeplinks } = require('../collector/deeplinks');
  writeJson(path.join(PUBLIC_DATA, 'deeplinks.json'), { entries: buildDeeplinks() });

  const firms = readJson(path.join(DATA_DIR, 'firms.json'), { firms: [] });
  writeJson(path.join(PUBLIC_DATA, 'firms.json'), firms);

  // Avisa se algum termo core/head fica redundante.
  try {
    const { checkRedundancy } = require('../lib/searchTerms');
    for (const r of checkRedundancy()) console.log(`::warning title=termos::${r}`);
  } catch {
    /* noop */
  }

  // Segmentos (tipos de vaga): o front monta o filtro e os badges a partir daqui.
  const { FILTER_SEGMENTS, ROLES, SCOPE, TOOLS } = require('../lib/segments');
  writeJson(path.join(PUBLIC_DATA, 'segments.json'), { segments: FILTER_SEGMENTS });

  // Eixos: label + contagem, p/ os filtros do site.
  const countFacet = (field) => {
    const c = {};
    for (const j of jobs) for (const v of j[field] || []) c[v] = (c[v] || 0) + 1;
    return c;
  };
  const facetList = (defs, counts) => defs.map((d) => ({ label: d.label, n: counts[d.label] || 0 })).filter((x) => x.n > 0);
  writeJson(path.join(PUBLIC_DATA, 'facets.json'), {
    roles: facetList(ROLES, countFacet('roles')),
    scope: facetList(SCOPE, countFacet('scope')),
    tools: facetList(TOOLS, countFacet('tools')),
  });

  console.log(`[build-site] concluído ${generatedAt}`);
}

main().catch((err) => {
  console.error('[build-site] ERRO FATAL:', err);
  process.exit(1);
});
