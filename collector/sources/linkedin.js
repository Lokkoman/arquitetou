// Fonte: LinkedIn — página pública de busca (sem login), usada pelo próprio LinkedIn
// para indexação/SEO.
//
// AVISO: os Termos de Uso do LinkedIn não permitem scraping automatizado, mesmo de
// páginas públicas. Feito aqui em volume muito baixo, sem login, para uso pessoal —
// pode ser bloqueado sem aviso. A interface também exibe isso (public/app.js).
const cheerio = require('cheerio');
const { matchArchitectureKeyword, detectSeniority, resolveCityOrRemote, detectWorkplaceType, makeId, snippet } = require('../../lib/keywords');
const { CORE_TERMS } = require('../../lib/searchTerms');
const { TARGET_CITIES } = require('../../lib/cities');

const CITIES = TARGET_CITIES.map((c) => ({ key: c.key, location: c.linkedin }));
// Consultas curtas (1 conceito cada) — frase longa degrada a busca do LinkedIn.
// Cada consulta roda por cidade + passada remota.
const TERMS = CORE_TERMS;

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

function parseListing(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  // O fragmento guest vem sem data-entity-urn — ancora no link da vaga e sobe até o card.
  $('a.base-card__full-link, a[href*="/jobs/view/"]').each((_, el) => {
    const $a = $(el);
    const $el = $a.closest('div.base-card, li, div.job-search-card');
    const url = $a.attr('href');
    const title = ($el.find('h3.base-search-card__title').first().text() || $a.text()).replace(/\s+/g, ' ').trim();
    if (!title || !url) return;

    const company =
      $el.find('h4.base-search-card__subtitle a, h4.base-search-card__subtitle').first().text().replace(/\s+/g, ' ').trim() ||
      'Empresa não informada';
    const location = $el.find('span.job-search-card__location').first().text().replace(/\s+/g, ' ').trim();
    const dateAttr = $el.find('time[datetime]').first().attr('datetime');

    jobs.push({
      title,
      url: url.split('?')[0], // remove tracking, mantém o link limpo (com o id da vaga)
      company,
      location,
      postedAt: dateAttr ? new Date(`${dateAttr}T12:00:00`).toISOString() : null,
    });
  });
  return jobs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A busca não traz descrição. Buscamos a página das N vagas mais recentes sem
// descrição (para no 1º 429). O resto ganha descrição via Bright Data ou Gemini.
const MAX_DETAIL_FETCHES = 20;

async function fetchDescription(url) {
  const html = await fetchUrl(url);
  const $ = cheerio.load(html);
  // A classe varia entre layouts: tenta a mais específica primeiro.
  const selectors = ['.show-more-less-html__markup', '.description__text', 'div[class*="jobs-description"]'];
  for (const sel of selectors) {
    const text = $(sel).first().text().replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

async function enrichWithDescriptions(jobs, errors) {
  const targets = jobs
    .filter((j) => !j.description)
    .sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || ''))
    .slice(0, MAX_DETAIL_FETCHES);
  for (const job of targets) {
    try {
      const description = await fetchDescription(job.url);
      job.description = description;
      job.descriptionSnippet = snippet(description);
    } catch (err) {
      errors.push(`descrição/${job.title}: ${err.message}`);
      if (/HTTP 429/.test(err.message)) break; // rate limit: para de tentar mais
    }
    await sleep(1000 + Math.floor(Math.random() * 800));
  }
}

async function collect() {
  const seen = new Map();
  const errors = [];
  let pagesFetched = 0;
  let cardsSeen = 0;
  let authwallHits = 0;

  const scan = (html, isRemote) => {
    pagesFetched += 1;
    if (/authwall|\/authwall|please sign in|faça login para/i.test(html)) authwallHits += 1;
    const list = parseListing(html);
    cardsSeen += list.length;
    for (const job of list) {
      const id = makeId(['linkedin', job.url]);
      if (!seen.has(id)) seen.set(id, { ...job, isRemote });
    }
  };

  // Endpoint guest "seeMoreJobPostings": fragmento leve, pagina por `start` (25/página).
  const GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
  const MAX_START = 75; // até ~100 vagas por (termo × escopo)

  const sweep = async (term, location, extra, isRemote, tag) => {
    for (let start = 0; start <= MAX_START; start += 25) {
      try {
        const url = `${GUEST}?${new URLSearchParams({
          keywords: term,
          location,
          f_TPR: 'r2592000', // últimos 30 dias
          start: String(start),
          ...extra,
        }).toString()}`;
        const html = await fetchUrl(url);
        const before = seen.size;
        scan(html, isRemote);
        if (seen.size === before && parseListing(html).length === 0) break; // fim da paginação
      } catch (err) {
        errors.push(`${tag} start=${start}: ${err.message}`);
        break;
      }
      await sleep(400 + Math.floor(Math.random() * 400));
    }
  };

  for (const city of CITIES) {
    for (const term of TERMS) await sweep(term, city.location, {}, false, `${term}/${city.key}`);
  }
  // Passada remota (f_WT=2) nacional para cada termo
  for (const term of TERMS) await sweep(term, 'Brasil', { f_WT: '2' }, true, `remoto/${term}`);

  // Bloqueio silencioso: o LinkedIn devolve HTTP 200 com página vazia/authwall pra IP
  // de datacenter. Sem isto, a rodada parece "ok" com pouquíssimas vagas.
  if (pagesFetched > 0 && cardsSeen === 0) {
    errors.push(`0 cards em ${pagesFetched} página(s) 200 — provável bloqueio silencioso (authwall/IP de datacenter)`);
  } else if (pagesFetched >= 5 && cardsSeen / pagesFetched < 2) {
    errors.push(`média de ${(cardsSeen / pagesFetched).toFixed(1)} card(s)/página em ${pagesFetched} — LinkedIn provavelmente truncando resultados`);
  }
  if (authwallHits > 0) errors.push(`authwall detectado em ${authwallHits} página(s)`);

  const jobs = [];
  for (const [id, raw] of seen.entries()) {
    const matchedKeyword = matchArchitectureKeyword(raw.title, '', { strict: true });
    if (!matchedKeyword) continue;
    const cityInfo = resolveCityOrRemote(raw.location, { isRemote: raw.isRemote });
    if (!cityInfo) continue;

    jobs.push({
      id,
      title: raw.title,
      company: raw.company,
      location: raw.location,
      cityKey: cityInfo.key,
      cityLabel: cityInfo.label,
      source: 'LinkedIn',
      sourceId: 'linkedin',
      sourceType: 'scraped-experimental',
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

  await enrichWithDescriptions(jobs, errors);

  // Com a descrição, refaz o filtro e a modalidade de quem ganhou descrição agora.
  const finalJobs = jobs.filter((job) => {
    if (!job.description) return true; // não enriquecida: já passou pelo filtro do título
    const refined = matchArchitectureKeyword(job.title, job.description, { strict: true });
    if (!refined) return false;
    job.matchedKeyword = refined;
    job.workplaceType = detectWorkplaceType(`${job.title} ${job.location} ${job.description}`, job.workplaceType);
    return true;
  });

  return { jobs: finalJobs, errors, queried: pagesFetched + MAX_DETAIL_FETCHES };
}

module.exports = {
  collect,
  id: 'linkedin',
  name: 'LinkedIn',
  note:
    'Extração experimental: os Termos de Uso do LinkedIn não permitem scraping automatizado, mesmo de páginas públicas sem login. Fazemos isso em volume baixo (poucas requisições por atualização) só para uso pessoal de busca de vagas — pode ser bloqueado ou parar de funcionar sem aviso a qualquer momento. A página de busca do LinkedIn não traz descrição, só título/empresa/local/data; buscamos o texto completo abrindo a página de cada vaga, mas o LinkedIn limita isso na prática (na maioria das atualizações só 1-2 vagas conseguem descrição) — para ver os detalhes das demais, clique em "Ver vaga". Se sumir daqui, use os links diretos na seção "Buscar diretamente" abaixo.',
};
