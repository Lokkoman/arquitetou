// Fonte: catho.com.br — HTML servidor-renderizado, sem descrição no card. Pagina por
// ?page=N e aceita qualquer slug na URL (busca frouxa + "cargos similares"). Varre
// ~15 slugs × 5 cidades × até MAX_PAGES, parando na 1ª página vazia. Disjuntor: N
// erros seguidos => aborta.
const cheerio = require('cheerio');
const { matchArchitectureKeyword, detectSeniority, resolveCityOrRemote, detectWorkplaceType, makeId, parseDateBR } = require('../../lib/keywords');
const { TARGET_CITIES } = require('../../lib/cities');

const BASE_URL = 'https://www.catho.com.br';
// Slugs que rendem título de arquitetura na Catho (cargo + ferramentas). Conceitos
// puros — licenciamento, regularização, bim — retornam volume mas o título costuma ser
// "Engenheiro Civil"/"Analista de Meio Ambiente" e cai no filtro estrito; ficam de fora.
const ROLE_SLUGS = [
  'arquiteto', 'arquiteta', 'arquiteto-urbanista', 'urbanista',
  'arquiteto-de-interiores', 'designer-de-interiores', 'paisagista',
  'projetista', 'cadista', 'desenhista-projetista', 'desenhista',
  'projeto-executivo', 'revit', 'autocad', 'archicad', 'sketchup',
];
const CITY_SLUGS = TARGET_CITIES.map((c) => c.catho);
const MAX_PAGES = 6;
const MAX_CONSECUTIVE_ERR = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchUrl(url, { timeoutMs = 12000 } = {}) {
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

function toIsoFromDDMM(text) {
  const m = /Atualizada em (\d{2})\/(\d{2})/.exec(text || '');
  if (!m) return null;
  const now = new Date();
  let year = now.getUTCFullYear();
  const [, dd, mm] = m;
  // se o mês/dia for no futuro, é do ano passado
  const guess = new Date(`${year}-${mm}-${dd}T12:00:00Z`);
  if (guess.getTime() > now.getTime() + 86400000) year -= 1;
  return parseDateBR(`${dd}/${mm}/${year}`);
}

function parseListing(html, cityLabel, isRemote) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('li[data-offer-item]').each((_, el) => {
    const $el = $(el);
    const a = $el.find('h2.title_offer a').first();
    const title = (a.attr('title') || a.text() || '').replace(/\s+/g, ' ').trim();
    const href = a.attr('href');
    if (!title || !href) return;

    const company = $el.find('p span.text-12').first().text().replace(/\s+/g, ' ').trim() || 'Empresa não informada';

    const locP = $el
      .find('p')
      .filter((i, p) => $(p).find('.i_job_location').length > 0)
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const location = (locP.split(' - ').pop() || '').trim() || cityLabel;

    const dateText = $el.find('.tag[class*="pub_"]').first().text();

    jobs.push({
      id: makeId(['catho', href.split('/').pop() || href]),
      title,
      company,
      location,
      url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
      postedAt: toIsoFromDDMM(dateText),
      isRemote,
    });
  });
  return jobs;
}

async function collect() {
  const seen = new Map();
  const errors = [];
  let consecErr = 0;
  let queries = 0;
  let aborted = false;

  // Varre um (slug × path) paginando até uma página voltar vazia ou bater MAX_PAGES.
  async function sweep(role, pathSeg, cityLabel, isRemote) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const suffix = page > 1 ? `?page=${page}` : '';
      try {
        const html = await fetchUrl(`${BASE_URL}/vagas/${role}/${pathSeg}/${suffix}`);
        queries += 1;
        consecErr = 0;
        const list = parseListing(html, cityLabel, isRemote);
        if (list.length === 0) break; // fim da paginação
        for (const job of list) if (!seen.has(job.id)) seen.set(job.id, job);
      } catch (err) {
        errors.push(`${role}/${pathSeg} p${page}: ${err.message}`);
        consecErr += 1;
        if (consecErr >= MAX_CONSECUTIVE_ERR) {
          errors.push(`disjuntor: ${consecErr} erros seguidos — abortando Catho`);
          aborted = true;
          return;
        }
        break; // erro numa página: pula pro próximo slug
      }
      await sleep(400);
    }
  }

  for (const citySlug of CITY_SLUGS) {
    for (const role of ROLE_SLUGS) {
      if (aborted) break;
      await sweep(role, citySlug, citySlug, false);
    }
    if (aborted) break;
  }
  // Home office (qualquer cidade do Brasil)
  for (const role of ROLE_SLUGS) {
    if (aborted) break;
    await sweep(role, 'home-office', 'Remoto', true);
  }

  const jobs = [];
  for (const raw of seen.values()) {
    const matchedKeyword = matchArchitectureKeyword(raw.title, '', { strict: true });
    if (!matchedKeyword) continue;
    const cityInfo = resolveCityOrRemote(raw.location, { isRemote: raw.isRemote });
    if (!cityInfo) continue;

    jobs.push({
      id: raw.id,
      title: raw.title,
      company: raw.company,
      location: raw.location,
      cityKey: cityInfo.key,
      cityLabel: cityInfo.label,
      source: 'Catho',
      sourceId: 'catho',
      sourceType: 'scraped',
      seniority: detectSeniority(raw.title),
      workplaceType: detectWorkplaceType(`${raw.title} ${raw.location}`, raw.isRemote ? 'remote' : null),
      matchedKeyword,
      postedAt: raw.postedAt,
      url: raw.url,
      description: '',
      descriptionSnippet: '',
      collectedAt: new Date().toISOString(),
    });
  }

  return { jobs, errors, queried: queries };
}

module.exports = { collect, id: 'catho', name: 'Catho' };
