// Fonte: empregos.com.br — HTML servidor-renderizado (Vue SSR). Busca por termo em
// GET /vagas/{slug} (slug = termo sem acento, kebab), paginação ?page=N. Cada card
// (<div id="job-card">) traz título, empresa, cidade, modalidade, salário, data e a
// descrição inline. A busca é fuzzy/OR e traz ruído de "arquiteto de software" — o
// filtro estrito + a IA cortam. Slugs "legalizacao" e "reurb" dão 502 sempre: pulados.
const cheerio = require('cheerio');
const { matchArchitectureKeyword, detectSeniority, resolveCityOrRemote, detectWorkplaceType, isRemoteText, makeId, snippet } = require('../../lib/keywords');
const { HEAD_TERMS } = require('../../lib/searchTerms');

const BASE_URL = 'https://www.empregos.com.br';
// HEAD_TERMS (54) = mesma lista de largura média que Vagas.com/BNE/Catho usam. slug =
// sem acento + kebab. Slugs que dão 502 consistente no servidor deles: pulados.
const SKIP_SLUGS = new Set(['legalizacao', 'reurb']);
// O servidor deles solta 502 sob rajada (mais do IP do GitHub Actions). Daí: 1 página
// por termo (a p.2 já é pouco relevante), pausa longa entre termos, 2 retries com
// backoff e disjuntor tolerante.
const PAGES_PER_TERM = 1;
const TERM_PAUSE = 1500;
const PAGE_PAUSE = 700;
const RETRY_PAUSES = [2500, 6000]; // backoff das re-tentativas em 5xx
const MAX_CONSECUTIVE_ERR = 14; // disjuntor (só aborta se o site cair de vez)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toSlug(term) {
  return term
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function fetchUrl(url, { timeoutMs = 15000 } = {}) {
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

// "Publicada há 3 dias" / "Publicada hoje" / "Publicada ontem" -> ISO
function parsePublished(text) {
  const t = (text || '').toLowerCase();
  const now = Date.now();
  const day = 86400000;
  if (/publicad[ao]\s+hoje/.test(t)) return new Date(now).toISOString();
  if (/publicad[ao]\s+ontem/.test(t)) return new Date(now - day).toISOString();
  const m = t.match(/publicad[ao]\s+h[áa]\s+(\d+)\s+(dia|semana|m[êe]s|mes|hora)/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit.startsWith('hora')) return new Date(now).toISOString();
    if (unit.startsWith('dia')) return new Date(now - n * day).toISOString();
    if (unit.startsWith('semana')) return new Date(now - n * 7 * day).toISOString();
    return new Date(now - n * 30 * day).toISOString(); // mês
  }
  return null;
}

function parseListing(html) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('div#job-card').each((_, el) => {
    const $el = $(el);

    const aria = ($el.attr('aria-label') || '').replace(/^Abrir detalhes da vaga\s*/i, '').trim();
    const title = aria || $el.find('h2 span, h2').first().text().replace(/\s+/g, ' ').trim();

    const href = $el.find('a[href*="/vaga/"]').first().attr('href') || '';
    if (!title || !href) return;
    const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;

    // O 1º <a href*="/empresa/"> é o wrapper do logo (sem texto); o nome está no <a>
    // dentro do <h3>. Pega o primeiro link de empresa que tenha texto.
    let company = '';
    $el.find('a[href*="/empresa/"]').each((_i, a) => {
      const txt = $(a).text().replace(/\s+/g, ' ').trim();
      if (txt && !company) company = txt;
    });
    if (!company) company = 'Empresa não informada';

    const location = ($el.find('h3[title]').first().attr('title') || $el.find('h3[title]').first().text() || '')
      .replace(/\s+/g, ' ')
      .trim();

    // A descrição é o único bloco com um <strong> à frente ("ARQUITETO(A) ...").
    const $descHost = $el.find('strong').first().parent();
    const description = $descHost.length ? $descHost.text().replace(/\s+/g, ' ').trim() : '';

    const cardText = $el.text().replace(/\s+/g, ' ');
    const modalityRaw = (cardText.match(/\b(Presencial|Remoto|H[íi]brido)\b/) || [])[1] || '';

    jobs.push({
      title,
      url,
      company,
      location,
      description,
      workplaceHint: /remoto/i.test(modalityRaw) ? 'remote' : /h[íi]brido/i.test(modalityRaw) ? 'hybrid' : /presencial/i.test(modalityRaw) ? 'on-site' : null,
      postedAt: parsePublished(cardText),
    });
  });
  return jobs;
}

async function collect() {
  const seen = new Map();
  const errors = [];
  const terms = HEAD_TERMS.filter((t) => !SKIP_SLUGS.has(toSlug(t)));
  let consecErr = 0;
  let aborted = false;
  let queries = 0;

  for (const term of terms) {
    if (aborted) break;
    const slug = toSlug(term);
    for (let page = 1; page <= PAGES_PER_TERM; page += 1) {
      const url = `${BASE_URL}/vagas/${slug}${page > 1 ? `?page=${page}` : ''}`;
      try {
        let html;
        for (let attempt = 0; ; attempt += 1) {
          try {
            html = await fetchUrl(url);
            break;
          } catch (e1) {
            if (!/HTTP 5\d\d/.test(e1.message) || attempt >= RETRY_PAUSES.length) throw e1;
            await sleep(RETRY_PAUSES[attempt]); // 5xx do servidor deles: backoff
          }
        }
        queries += 1;
        const list = parseListing(html);
        consecErr = 0;
        if (list.length === 0) break; // fim da paginação
        for (const job of list) {
          const id = makeId(['empregos', job.url]);
          if (!seen.has(id)) seen.set(id, job);
        }
      } catch (err) {
        errors.push(`${slug}/p${page}: ${err.message}`);
        consecErr += 1;
        if (consecErr >= MAX_CONSECUTIVE_ERR) {
          errors.push(`disjuntor: ${consecErr} erros seguidos — abortando Empregos.com.br`);
          aborted = true;
        }
        break;
      }
      await sleep(PAGE_PAUSE);
    }
    await sleep(TERM_PAUSE);
  }

  const jobs = [];
  for (const [id, raw] of seen.entries()) {
    const matchedKeyword = matchArchitectureKeyword(raw.title, raw.description, { strict: true });
    if (!matchedKeyword) continue;
    const isRemote = raw.workplaceHint === 'remote' || isRemoteText(`${raw.title} ${raw.location} ${raw.description}`);
    const cityInfo = resolveCityOrRemote(raw.location, { isRemote });
    if (!cityInfo) continue;

    jobs.push({
      id,
      title: raw.title,
      company: raw.company,
      location: raw.location,
      cityKey: cityInfo.key,
      cityLabel: cityInfo.label,
      source: 'Empregos.com.br',
      sourceId: 'empregos',
      sourceType: 'scraped',
      seniority: detectSeniority(raw.title),
      workplaceType: detectWorkplaceType(`${raw.title} ${raw.location} ${raw.description}`, raw.workplaceHint),
      matchedKeyword,
      postedAt: raw.postedAt,
      url: raw.url,
      description: raw.description || '',
      descriptionSnippet: snippet(raw.description || ''),
      collectedAt: new Date().toISOString(),
    });
  }

  return { jobs, errors, queried: queries, aborted };
}

module.exports = { collect, id: 'empregos', name: 'Empregos.com.br' };
