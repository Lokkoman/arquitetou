// Fontes que bloqueiam scraping ou dão risco alto em uso agendado. Pra essas geramos
// links de busca já filtrados: o usuário clica e cai na busca certa no site oficial.
const { TARGET_CITIES: CITIES } = require('../lib/cities');
const { orQuery, HEAD_TERMS, CORE_TERMS } = require('../lib/searchTerms');

const RECENCY_OPTIONS = [
  { key: '1', label: 'Últimas 24h', linkedinTpr: 'r86400', indeedFromage: '1' },
  { key: '7', label: 'Última semana', linkedinTpr: 'r604800', indeedFromage: '7' },
  { key: '30', label: 'Último mês', linkedinTpr: 'r2592000', indeedFromage: '30' },
];

// Um link por cidade, termos da base em OR. Indeed = tier HEAD; LinkedIn = tier CORE
// (o booleano dele é mais fraco em query longa).
const Q_INDEED = `${orQuery(HEAD_TERMS)} -SolidWorks`;
const Q_LINKEDIN = orQuery(CORE_TERMS);

function build() {
  const entries = [];

  for (const city of CITIES) {
    for (const recency of RECENCY_OPTIONS) {
      entries.push({
        id: `linkedin-${city.key}-${recency.key}`,
        source: 'LinkedIn',
        sourceId: 'linkedin',
        cityKey: city.key,
        cityLabel: city.label,
        recencyKey: recency.key,
        recencyLabel: recency.label,
        url: `https://www.linkedin.com/jobs/search/?${new URLSearchParams({
          keywords: Q_LINKEDIN,
          location: city.linkedin,
          f_TPR: recency.linkedinTpr,
        }).toString()}`,
        note: 'Busca com todos os termos em OR. Acesso público mostra os primeiros resultados; login para a lista completa.',
      });

      entries.push({
        id: `indeed-${city.key}-${recency.key}`,
        source: 'Indeed',
        sourceId: 'indeed',
        cityKey: city.key,
        cityLabel: city.label,
        recencyKey: recency.key,
        recencyLabel: recency.label,
        url: `https://br.indeed.com/jobs?${new URLSearchParams({
          q: Q_INDEED,
          l: city.indeed,
          fromage: recency.indeedFromage,
        }).toString()}`,
        note: 'Busca única com todos os termos em OR (arquiteto, projetista, licenciamento, BIM, restauro, programas…).',
      });
    }

    entries.push({
      id: `catho-${city.key}`,
      source: 'Catho',
      sourceId: 'catho',
      cityKey: city.key,
      cityLabel: city.label,
      recencyKey: null,
      recencyLabel: null,
      url: `https://www.catho.com.br/vagas/arquiteto/${city.catho}/`,
      note: 'Catho sinaliza proteção anti-bot no robots.txt — por segurança não fazemos scraping automático aqui.',
    });
  }

  // Remoto: LinkedIn f_TPR + f_WT=2; Indeed via palavra-chave (não tem parâmetro);
  // Catho pelo caminho /home-office/.
  for (const recency of RECENCY_OPTIONS) {
    entries.push({
      id: `linkedin-remoto-${recency.key}`,
      source: 'LinkedIn',
      sourceId: 'linkedin',
      cityKey: 'remoto',
      cityLabel: 'Remoto (Brasil todo)',
      recencyKey: recency.key,
      recencyLabel: recency.label,
      url: `https://www.linkedin.com/jobs/search/?${new URLSearchParams({
        keywords: Q_LINKEDIN,
        location: 'Brasil',
        f_TPR: recency.linkedinTpr,
        f_WT: '2',
      }).toString()}`,
      note: 'Filtro "Remoto" (f_WT=2) do LinkedIn + todos os termos em OR.',
    });

    entries.push({
      id: `indeed-remoto-${recency.key}`,
      source: 'Indeed',
      sourceId: 'indeed',
      cityKey: 'remoto',
      cityLabel: 'Remoto (Brasil todo)',
      recencyKey: recency.key,
      recencyLabel: recency.label,
      url: `https://br.indeed.com/jobs?${new URLSearchParams({
        q: `(${Q_INDEED}) (home office OR remoto OR híbrido)`,
        l: 'Brasil',
        fromage: recency.indeedFromage,
      }).toString()}`,
      note: 'Indeed não tem filtro de "remoto" por URL — todos os termos em OR + "home office/remoto" na busca.',
    });
  }

  entries.push({
    id: 'catho-remoto',
    source: 'Catho',
    sourceId: 'catho',
    cityKey: 'remoto',
    cityLabel: 'Remoto (Brasil todo)',
    recencyKey: null,
    recencyLabel: null,
    url: 'https://www.catho.com.br/vagas/arquiteto/home-office/',
    note: 'Catho sinaliza proteção anti-bot no robots.txt — por segurança não fazemos scraping automático aqui.',
  });

  return entries;
}

module.exports = { build, CITIES, RECENCY_OPTIONS };
