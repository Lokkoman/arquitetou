// Fonte: vagas.com.br — HTML servidor-renderizado. A busca (/vagas-de-{termo}) está
// atrás de um WAF Cloudflare, mas as páginas de empresa (/empregos/{slug}) não. Então:
// pega os slugs de empresa de construção/arquitetura no sitemap.xml e raspa
// /empregos/{slug} de cada uma (mesma estrutura HTML, descrição inline).
const cheerio = require('cheerio');
const { matchArchitectureKeyword, detectSeniority, resolveCityOrRemote, detectWorkplaceType, makeId, snippet, parseDateBR } = require('../../lib/keywords');

const BASE_URL = 'https://www.vagas.com.br';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_CONSECUTIVE_ERR = 10;

// Slug de empresa "tem cara de" construção/arquitetura/imobiliário.
const COMPANY_RE = /arquitet|construt|construc|constru-|engenharia|engenharia-|incorporad|urbanis|projeto|projet-|imobiliar|imovel|imoveis|obras|edifica|paisag|interiores|reforma|predial|empreendiment|loteador|habitac/i;

// Seed fixo — construtoras/incorporadoras grandes que costumam ter página na Vagas.com.
// (o slug real é confirmado em runtime pelo sitemap; este é só um reforço.)
const SEED_COMPANIES = [
  'alya-construtora', 'mrv-engenharia', 'direcional-engenharia', 'htb-engenharia',
  'benx-incorporadora', 'atua-construtora', 'fbs-construtora', 'pacaembu-construtora',
  'akaer-engenharia', 'alfa-engenharia', 'cadari-engenharia', 'epc-engenharia',
  'factor-engenharia', 'lyon-engenharia', 'marte-engenharia', 'ktm-engenharia',
  'precon-engenharia', 'afonso-franca',
];

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

// Extrai slugs de empresa "construção/arquitetura" do sitemap.
async function companySlugsFromSitemap(errors) {
  try {
    const xml = await fetchUrl(`${BASE_URL}/sitemap.xml`, { timeoutMs: 20000 });
    const slugs = new Set();
    const re = /\/empregos\/([a-z0-9-]+)</gi;
    let m;
    while ((m = re.exec(xml))) {
      if (COMPANY_RE.test(m[1])) slugs.add(m[1]);
    }
    return [...slugs];
  } catch (err) {
    errors.push(`sitemap: ${err.message}`);
    return [];
  }
}

function parseListing(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('li.vaga').each((_, el) => {
    const $el = $(el);
    const titleLink = $el.find('a.link-detalhes-vaga').first();
    const title = (titleLink.attr('title') || titleLink.text() || '').replace(/\s+/g, ' ').trim();
    const href = titleLink.attr('href');
    if (!title || !href) return;

    const company = $el.find('span.emprVaga').first().text().replace(/\s+/g, ' ').trim() || 'Empresa não informada';
    const seniority = $el.find('span.nivelVaga').first().text().replace(/\s+/g, ' ').trim();
    const description = $el
      .find('div.detalhes p')
      .first()
      .text()
      .replace(/^Descrição:\s*Descrição:/, 'Descrição:')
      .replace(/\s+/g, ' ')
      .trim();

    const locationEl = $el.find('.vaga-local').clone();
    locationEl.find('.tooltip-place, i').remove();
    const location = locationEl.text().replace(/\s+/g, ' ').trim();

    const dateText = $el.find('.data-publicacao').first().text().replace(/\s+/g, ' ').trim();

    jobs.push({
      title,
      url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
      company,
      seniority,
      description,
      location,
      postedAt: parseDateBR(dateText),
    });
  });
  return jobs;
}

async function collect() {
  const seen = new Map();
  const errors = [];

  const fromSitemap = await companySlugsFromSitemap(errors);
  const companies = [...new Set([...fromSitemap, ...SEED_COMPANIES])];

  let consecErr = 0;
  let done = 0;
  for (const slug of companies) {
    try {
      const html = await fetchUrl(`${BASE_URL}/empregos/${slug}`);
      consecErr = 0;
      done += 1;
      for (const job of parseListing(html)) {
        const id = makeId(['vagas-com', job.url]);
        if (!seen.has(id)) seen.set(id, job);
      }
    } catch (err) {
      errors.push(`${slug}: ${err.message}`);
      consecErr += 1;
      if (consecErr >= MAX_CONSECUTIVE_ERR) {
        errors.push(`disjuntor: ${consecErr} erros seguidos — abortando Vagas.com`);
        break;
      }
    }
    await sleep(400 + Math.floor(Math.random() * 300));
  }

  const jobs = [];
  for (const [id, raw] of seen.entries()) {
    const matchedKeyword = matchArchitectureKeyword(raw.title, raw.description, { strict: true });
    if (!matchedKeyword) continue;
    const isRemote = /home\s*office|100%\s*remoto|remoto|qualquer cidade do brasil/i.test(`${raw.location} ${raw.description}`);
    const cityInfo = resolveCityOrRemote(raw.location, { isRemote });
    if (!cityInfo) continue;

    jobs.push({
      id,
      title: raw.title,
      company: raw.company,
      location: raw.location,
      cityKey: cityInfo.key,
      cityLabel: cityInfo.label,
      source: 'Vagas.com',
      sourceId: 'vagas-com',
      sourceType: 'scraped',
      seniority: raw.seniority ? raw.seniority.toLowerCase() : detectSeniority(raw.title),
      workplaceType: detectWorkplaceType(`${raw.location} ${raw.description}`, isRemote ? 'remote' : null),
      matchedKeyword,
      postedAt: raw.postedAt,
      url: raw.url,
      description: raw.description,
      descriptionSnippet: snippet(raw.description),
      collectedAt: new Date().toISOString(),
    });
  }

  return { jobs, errors, queried: done };
}

module.exports = { collect, id: 'vagas-com', name: 'Vagas.com' };
