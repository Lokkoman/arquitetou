// Fonte: BNE (Bolsa Nacional de Empregos). A página embute um <input type="hidden"
// id="jobInfoLocal"> com todas as vagas da busca em JSON (descrição, data, empresa,
// cidade). O campo "Titulo" costuma vir vazio (usa a categoria genérica), então o
// filtro olha também a descrição completa.
const { matchArchitectureKeyword, detectSeniority, resolveCityOrRemote, detectWorkplaceType, makeId, snippet, stripHtml, decodeEntities } = require('../../lib/keywords');
const { TARGET_CITIES } = require('../../lib/cities');

const BASE_URL = 'https://www.bne.com.br';
// A URL do BNE só aceita slug de cargo da taxonomia dele (conceitos redirecionam pra
// home). Só estes 9 retornam resultados. Não pagina pra anônimo — ~20 vagas/consulta.
const TERMS = [
  'arquiteto', 'urbanista', 'arquiteto-urbanista', 'arquiteto-de-interiores',
  'designer-de-interiores', 'projetista', 'desenhista', 'desenhista-projetista',
  'coordenador-de-projetos',
];
const CITY_TERMS = TERMS; // os 9 valem por cidade e na passada nacional
const CITY_SLUGS = TARGET_CITIES.map((c) => c.slug);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_CONSECUTIVE_ERR = 10; // disjuntor p/ falha real de rede (não mais p/ slug inválido)

async function fetchPage(term, citySlug, { timeoutMs = 12000 } = {}) {
  const url = citySlug
    ? `${BASE_URL}/vagas-de-emprego-para-${term}-em-${citySlug}-sp`
    : `${BASE_URL}/vagas-de-emprego-para-${term}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractJobsJson(html) {
  const m = html.match(/id="jobInfoLocal"[^>]*value="([^"]*)"/);
  if (!m) return [];
  const decoded = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  try {
    const arr = JSON.parse(decoded);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function titleCase(str = '') {
  return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Aborta após MAX_CONSECUTIVE_ERR erros seguidos.
async function runPass(pairs, seen, errors) {
  let consecutiveErr = 0;
  for (const { term, citySlug, tag } of pairs) {
    try {
      const html = await fetchPage(term, citySlug);
      for (const item of extractJobsJson(html)) if (!seen.has(item.Id)) seen.set(item.Id, item);
      consecutiveErr = 0;
    } catch (err) {
      errors.push(`${tag}: ${err.message}`);
      consecutiveErr += 1;
      if (consecutiveErr >= MAX_CONSECUTIVE_ERR) {
        errors.push(`disjuntor: ${consecutiveErr} erros seguidos — passada abortada em "${tag}"`);
        return { aborted: true };
      }
    }
    await sleep(150);
  }
  return { aborted: false };
}

async function collect() {
  const seen = new Map();
  const errors = [];

  const cityPairs = [];
  for (const citySlug of CITY_SLUGS) {
    for (const term of CITY_TERMS) cityPairs.push({ term, citySlug, tag: `${term}/${citySlug}` });
  }
  await runPass(cityPairs, seen, errors);

  // Passada nacional (sem cidade na URL) com a lista completa: pega remotas de fora
  // das cidades-alvo.
  await runPass(
    TERMS.map((term) => ({ term, citySlug: null, tag: `${term}/nacional` })),
    seen,
    errors
  );

  const jobs = [];
  for (const raw of seen.values()) {
    const title = decodeEntities(raw.Titulo || titleCase(raw.Function?.Name || 'Vaga de Arquitetura'));
    const description = stripHtml(raw.GeneralDescription || '');
    const matchedKeyword = matchArchitectureKeyword(title, description, { strict: true });
    if (!matchedKeyword) continue;

    const cityName = decodeEntities(raw.City?.Name || '');
    const locationText = `${cityName}${raw.StateAbbreviation ? ` / ${raw.StateAbbreviation}` : ''}`;
    const cityInfo = resolveCityOrRemote(cityName || locationText, { isRemote: !!raw.Home_Office });
    if (!cityInfo) continue;

    jobs.push({
      id: makeId(['bne', String(raw.Id)]),
      title,
      company: raw.Confidential ? 'Confidencial' : decodeEntities(raw.CompanyName || 'Empresa não informada'),
      location: locationText,
      cityKey: cityInfo.key,
      cityLabel: cityInfo.label,
      source: 'BNE',
      sourceId: 'bne',
      sourceType: 'scraped',
      seniority: detectSeniority(title),
      workplaceType: detectWorkplaceType(description, raw.Home_Office ? 'remote' : null),
      matchedKeyword,
      postedAt: raw.PostDate || raw.ReleaseDate || null,
      url: raw.Url,
      description,
      descriptionSnippet: snippet(description),
      collectedAt: new Date().toISOString(),
    });
  }

  return { jobs, errors, queried: CITY_SLUGS.length * CITY_TERMS.length + TERMS.length };
}

module.exports = { collect, id: 'bne', name: 'BNE' };
