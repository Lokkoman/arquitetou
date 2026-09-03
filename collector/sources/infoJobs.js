// Fonte: infojobs.com.br — HTML servidor-renderizado. A URL "vagas-de-X-em-{cidade}.aspx"
// NÃO filtra por cidade no servidor (uma cidade inexistente devolve o mesmo conjunto),
// então buscamos por termo nacionalmente e filtramos por cidade aqui, pelo texto de
// localização de cada card. Já "vagas-de-emprego-X-trabalho-home-office.aspx" é filtro
// real e serve pra achar remotas.
const cheerio = require('cheerio');
const { matchArchitectureKeyword, detectSeniority, resolveCityOrRemote, detectWorkplaceType, isRemoteText, makeId, snippet, parseDateSlash } = require('../../lib/keywords');

const BASE_URL = 'https://www.infojobs.com.br';
// Só estas categorias "vagas-de-X.aspx" existem de verdade — o resto redireciona pra uma
// listagem genérica.
const TERMS = ['arquiteto', 'arquitetura', 'urbanismo', 'projetista'];
// Só estas 3 têm página dedicada de home office.
const HOME_OFFICE_TERMS = ['arquiteto', 'arquitetura', 'urbanismo'];
// Busca livre "/empregos.aspx?palabra=X". A relevância despenca depois da p.2. Mandar
// ~100 termos em rajada dispara bloqueio de bot (403 em massa) — daí a lista curada +
// pausa entre termos + disjuntor. Cobre todos os segmentos.
const EXTRA_TERMS = [
  'arquiteto de interiores', 'design de interiores', 'designer de interiores', 'decoração de interiores',
  'paisagismo', 'arquiteto paisagista', 'cadista', 'desenhista projetista',
  'projeto executivo', 'detalhamento', 'compatibilização de projetos', 'coordenador de projetos',
  'BIM', 'modelador BIM', 'revit', 'archicad', 'sketchup', 'autocad', 'navisworks',
  'maquete eletrônica', 'renderização', 'lumion', 'enscape',
  'licenciamento', 'regularização de imóveis', 'regularização fundiária', 'legalização de obras',
  'aprovação de projetos', 'projeto legal', 'habite-se', 'alvará de construção', 'AVCB',
  'georreferenciamento', 'due diligence imobiliária',
  'restauro', 'retrofit', 'patrimônio histórico',
  'laudo pericial', 'avaliação de imóveis', 'inspeção predial', 'vistoria cautelar',
  'construção sustentável', 'eficiência energética', 'LEED',
  'urbanismo', 'plano diretor', 'loteamento', 'planejamento urbano',
  'acompanhamento de obra', 'fiscalização de obra', 'gerenciamento de obras', 'arquiteto residente',
];
const PAGES_PER_TERM = 3;
const EXTRA_PAGES = 2;
const TERM_PAUSE = 450; // pausa ENTRE termos — InfoJobs bloqueia rajada
const MAX_CONSECUTIVE_ERR = 8; // disjuntor: N termos seguidos sem resultado => aborta
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

function parseListing(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('div[id^="vacancy"][data-href]').each((_, el) => {
    const $el = $(el);
    const title = $el.find('.js_vacancyTitle').first().text().replace(/\s+/g, ' ').trim();
    const href = $el.attr('data-href');
    if (!title || !href) return;

    const dateValue = $el.find('.js_date').first().attr('data-value');

    const locationEl = $el.find('.mb-8').first().clone();
    locationEl.find('span').remove();
    const location = locationEl.text().replace(/\s+/g, ' ').trim();

    // Quando a empresa tem nota/avaliação, um bloco ".mr-8" com a nota (ex: "4,0")
    // aparece ANTES do nome dentro do mesmo container e também usa a classe
    // ".text-body" — por isso removemos esse bloco de nota antes de ler o texto.
    const companyContainer = $el.find('.d-flex.align-items-baseline').first().clone();
    companyContainer.find('.mr-8').remove(); // bloco de nota/avaliação (ex.: "4,0")
    companyContainer.find('.cursor-pointer').remove(); // badge "verificada" (só ícone)
    let company = companyContainer.text().replace(/\s+/g, ' ').replace(/^Empresa\s*/, '').trim();
    if (!company || /^\d,\d$/.test(company)) company = 'Empresa não informada';

    // O resumo ("Principais responsabilidades...") fica num <div class="text-medium">
    // isolado (sem outras classes) — há OUTROS ".text-medium" no card (data relativa
    // tipo "Ontem", badges de salário/modalidade) que têm classes extras, então
    // filtramos pelo atributo class exato para pegar só o bloco de resumo.
    const description = $el
      .find('div.text-medium')
      .filter((i, e) => ($(e).attr('class') || '').trim() === 'text-medium')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    jobs.push({
      title,
      url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
      company,
      location,
      description,
      postedAt: parseDateSlash(dateValue),
    });
  });
  return jobs;
}

async function fetchPaginated(urlBuilder, { errors, prefix, pages = PAGES_PER_TERM }) {
  const results = [];
  for (let page = 1; page <= pages; page += 1) {
    try {
      const html = await fetchUrl(urlBuilder(page));
      const jobs = parseListing(html);
      if (jobs.length === 0) break; // fim da paginação
      results.push(...jobs);
    } catch (err) {
      errors.push(`${prefix}/p${page}: ${err.message}`);
      break;
    }
    await sleep(200 + Math.floor(Math.random() * 200));
  }
  return results;
}

async function collect() {
  const seen = new Map();
  const errors = [];
  let consecEmpty = 0;
  let aborted = false;

  // Roda um termo, respeita o disjuntor e pausa entre termos (InfoJobs bloqueia rajada).
  const runTerm = async (urlFn, opts, isRemote) => {
    if (aborted) return;
    const jobs = await fetchPaginated(urlFn, opts);
    if (jobs.length === 0) {
      consecEmpty += 1;
      if (consecEmpty >= MAX_CONSECUTIVE_ERR) {
        errors.push(`disjuntor: ${consecEmpty} termos seguidos sem resultado — abortando InfoJobs`);
        aborted = true;
      }
    } else {
      consecEmpty = 0;
    }
    for (const job of jobs) {
      const id = makeId(['infojobs', job.url]);
      const remote = isRemote === 'auto' ? isRemoteText(`${job.title} ${job.location} ${job.description || ''}`) : isRemote;
      if (!seen.has(id)) seen.set(id, { ...job, isRemote: remote });
    }
    await sleep(TERM_PAUSE);
  };

  for (const term of TERMS) {
    await runTerm((page) => `${BASE_URL}/vagas-de-${term}.aspx?Page=${page}`, { errors, prefix: term }, false);
  }
  for (const term of HOME_OFFICE_TERMS) {
    await runTerm(
      (page) => `${BASE_URL}/vagas-de-emprego-${term}-trabalho-home-office.aspx?Page=${page}`,
      { errors, prefix: `${term}/remoto` },
      true
    );
  }
  for (const term of EXTRA_TERMS) {
    await runTerm(
      (page) => `${BASE_URL}/empregos.aspx?${new URLSearchParams({ palabra: term, Page: String(page) }).toString()}`,
      { errors, prefix: term, pages: EXTRA_PAGES },
      'auto'
    );
  }

  const jobs = [];
  for (const [id, raw] of seen.entries()) {
    const matchedKeyword = matchArchitectureKeyword(raw.title, raw.description, { strict: true });
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
      source: 'InfoJobs',
      sourceId: 'infojobs',
      sourceType: 'scraped',
      seniority: detectSeniority(raw.title),
      workplaceType: detectWorkplaceType(`${raw.title} ${raw.location} ${raw.description}`, raw.isRemote ? 'remote' : null),
      matchedKeyword,
      postedAt: raw.postedAt,
      url: raw.url,
      description: raw.description || '',
      descriptionSnippet: snippet(raw.description || ''),
      collectedAt: new Date().toISOString(),
    });
  }

  return {
    jobs,
    errors,
    queried: (TERMS.length + HOME_OFFICE_TERMS.length) * PAGES_PER_TERM + EXTRA_TERMS.length * EXTRA_PAGES,
    aborted,
  };
}

module.exports = { collect, id: 'infojobs', name: 'InfoJobs' };
