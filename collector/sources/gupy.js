// Fonte: portal agregador da Gupy (employability-portal.gupy.io) — endpoint JSON
// público, sem auth, que agrega as vagas de quem usa a Gupy como ATS.
const { matchArchitectureKeyword, detectSeniority, resolveCityOrRemote, detectWorkplaceType, makeId, snippet, stripHtml } = require('../../lib/keywords');
const { STEMS } = require('../../lib/searchTerms');
const { TARGET_CITIES: CITIES } = require('../../lib/cities');

const BASE_URL = 'https://employability-portal.gupy.io/api/v1/jobs';
const TARGET_CITIES = CITIES.map((c) => c.gupy);
// A Gupy casa `jobName` por substring literal, então usamos radicais (frase exata quase
// não casa); o filtro estrito + a IA descartam o ruído. Pagina por `offset` (limit
// trava em 100) + uma passada com isRemoteWork=true.
const TERMS = STEMS;
const GUPY_MAX_ITEMS = 300; // teto de paginação por (termo × escopo)

async function fetchPage(jobName, { city, offset = 0, remote = false, timeoutMs = 12000 } = {}) {
  const params = { jobName, limit: '100', offset: String(offset) };
  if (city) params.city = city;
  if (remote) params.isRemoteWork = 'true';
  const url = `${BASE_URL}?${new URLSearchParams(params).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Arquitetou/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { items: Array.isArray(json.data) ? json.data : [], total: (json.pagination && json.pagination.total) || 0 };
  } finally {
    clearTimeout(timer);
  }
}

// Puxa todas as páginas de um (termo × escopo), até GUPY_MAX_ITEMS.
async function fetchAll(jobName, opts = {}) {
  const out = [];
  for (let offset = 0; offset < GUPY_MAX_ITEMS; offset += 100) {
    const { items, total } = await fetchPage(jobName, { ...opts, offset });
    out.push(...items);
    if (offset + 100 >= total || items.length < 100) break;
  }
  return out;
}

async function collect() {
  const seen = new Map();
  const errors = [];
  let queries = 0;
  const soak = async (term, opts, tag) => {
    try {
      const items = await fetchAll(term, opts);
      queries += 1;
      for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
    } catch (err) {
      errors.push(`${tag}: ${err.message}`);
    }
  };

  // Fan-out por cidade.
  for (const city of TARGET_CITIES) {
    for (const term of TERMS) await soak(term, { city }, `${term}/${city}`);
  }
  // Passada nacional: pega cidade-alvo que o filtro de cidade da API perde.
  for (const term of TERMS) await soak(term, {}, `${term}/nacional`);
  // Passada remota nacional (isRemoteWork=true).
  for (const term of TERMS) await soak(term, { remote: true }, `${term}/remoto`);

  const jobs = [];
  for (const raw of seen.values()) {
    const matchedKeyword = matchArchitectureKeyword(raw.name, raw.description, { strict: true });
    if (!matchedKeyword) continue;

    const isRemote = raw.workplaceType === 'remote' || raw.isRemoteWork === true;
    const cityInfo = resolveCityOrRemote(raw.city || raw.state, { isRemote });
    if (!cityInfo) continue; // nem cidade-alvo, nem remota

    jobs.push({
      id: makeId(['gupy-portal', String(raw.id)]),
      title: raw.name.trim(),
      company: raw.careerPageName ? raw.careerPageName.trim() : 'Empresa não informada',
      location: raw.city || cityInfo.label,
      cityKey: cityInfo.key,
      cityLabel: cityInfo.label,
      source: 'Gupy',
      sourceId: 'gupy-portal',
      sourceType: 'scraped',
      seniority: detectSeniority(raw.name),
      workplaceType: detectWorkplaceType(`${raw.name} ${raw.description || ''}`, raw.workplaceType || (raw.isRemoteWork ? 'remote' : null)),
      matchedKeyword,
      postedAt: raw.publishedDate || null,
      url: raw.jobUrl,
      description: stripHtml(raw.description || ''),
      descriptionSnippet: snippet(raw.description || ''),
      collectedAt: new Date().toISOString(),
    });
  }

  return { jobs, errors, queried: queries };
}

module.exports = { collect, id: 'gupy-portal', name: 'Gupy' };
