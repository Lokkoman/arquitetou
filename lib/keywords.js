const crypto = require('crypto');
const { CITY_PATTERNS, TARGET_CITY_KEYS } = require('./cities');
const { SEGMENTS, EXCLUDE, PRIORITY, ADJACENT, ROLES, SCOPE, TOOLS } = require('./segments');

// Reconhecimento e classificação de vaga, derivado de lib/segments.js. MATCHERS = todos
// os padrões { label, re, segment }, na ordem de prioridade (segmentos específicos antes
// do genérico). A 1ª regex que casa dá o label (badge) e o segmento.
const MATCHERS = SEGMENTS.flatMap((seg) => seg.match.map((m) => ({ label: m.label, re: m.re, segment: seg.key })));
const LABEL_TO_SEGMENT = new Map();
for (const seg of SEGMENTS) for (const m of seg.match) LABEL_TO_SEGMENT.set(m.label, seg.key);
const TECH_EXCLUDE = EXCLUDE;

function keywordCategory(label) {
  return LABEL_TO_SEGMENT.get(label) || 'arquitetura';
}

/**
 * Classificação MULTI-TAG de uma vaga.
 * strict=true: casa no título + aplica EXCLUDE. strict=false: título+descrição, sem EXCLUDE.
 * Retorna null (descartar) ou { label, segments: [...] }. Se tem cara de arquitetura mas
 * nada casou -> segments: ['outros'].
 */
function jobSegments(title, description = '', { strict = true } = {}) {
  const titleText = title || '';
  const full = `${titleText} ${description}`;
  if (strict && TECH_EXCLUDE.some((re) => re.test(full))) return null;
  const text = strict ? titleText : full;

  const hits = MATCHERS.filter((m) => m.re.test(text));
  if (hits.length) {
    const segments = [...new Set(hits.map((h) => h.segment))].sort(
      (a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b)
    );
    return { label: hits[0].label, segments };
  }
  // Rede de segurança: cara de arquitetura, não excluída -> mantém p/ revisão.
  if (ADJACENT.test(text)) return { label: 'a revisar', segments: ['outros'] };
  return null;
}

/**
 * Retorna só o label do 1º padrão, ou null. Os scrapers guardam em job.matchedKeyword;
 * o site depois re-roda jobSegments().
 */
function matchArchitectureKeyword(title, description = '', opts = {}) {
  const r = jobSegments(title, description, opts);
  return r ? r.label : null;
}

function matchAll(list, text) {
  return list.filter((m) => m.re.test(text)).map((m) => m.label);
}

/**
 * Classificação em 3 eixos, roda no build sobre toda vaga:
 *   roles  — cargo, casado no título
 *   scope  — o que a vaga pede/faz, título + descrição
 *   tools  — programas, título + descrição
 */
function classifyFacets(title = '', description = '') {
  const t = title || '';
  const full = `${t} ${description || ''}`;
  return {
    roles: matchAll(ROLES, t),
    scope: matchAll(SCOPE, full),
    tools: matchAll(TOOLS, full),
  };
}

function isArchitectureJob(title, description = '', opts = {}) {
  return matchArchitectureKeyword(title, description, opts) !== null;
}

const SENIORITY_PATTERNS = [
  { key: 'estagio', label: 'Estágio', re: /est[áa]gi[oa]|trainee/i },
  { key: 'junior', label: 'Júnior', re: /j[úu]nior|jr\.?\b/i },
  { key: 'pleno', label: 'Pleno', re: /pleno|pl\.?\b/i },
  { key: 'senior', label: 'Sênior', re: /s[êe]nior|sr\.?\b/i },
  { key: 'coordenacao', label: 'Coordenação/Liderança', re: /coordenador|l[íi]der|gerente|head\b/i },
];

function detectSeniority(title) {
  for (const s of SENIORITY_PATTERNS) {
    if (s.re.test(title)) return s.key;
  }
  return 'nao_informado';
}

// Deixa "Jacareí - SP" / "Rio de Janeiro, RJ" legível como só o nome da cidade.
function cleanCityLabel(text) {
  return text
    .replace(/\s*[-/,–]\s*[A-Za-z]{2}\.?\s*$/, '') // sufixo de UF: "- SP", ", RJ", "/ MG"
    .replace(/\s*[-/,–]\s*brasil\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCity(text) {
  if (!text) return { key: 'nao_informado', label: 'Não informado' };
  for (const c of CITY_PATTERNS) {
    if (c.re.test(text)) return { key: c.key, label: c.label };
  }
  return { key: 'outra', label: cleanCityLabel(text) || text.trim() };
}

const REMOTE_TEXT_RE = /home[- ]?office|100%\s*remoto|totalmente remoto|trabalho remoto|\bremoto\b/i;

function isRemoteText(text = '') {
  return REMOTE_TEXT_RE.test(text);
}

const HYBRID_RE = /h[íi]brido/i;
const ONSITE_RE = /presencial|no local|na empresa/i;

/**
 * Modalidade (remoto/híbrido/presencial) a partir de texto livre. Fallback quando a
 * fonte não tem campo próprio. `hint` deixa o valor de uma fonte estruturada vencer.
 */
function detectWorkplaceType(text = '', hint = null) {
  if (hint === 'remote' || hint === 'hybrid' || hint === 'on-site') return hint;
  if (REMOTE_TEXT_RE.test(text)) return 'remote';
  if (HYBRID_RE.test(text)) return 'hybrid';
  if (ONSITE_RE.test(text)) return 'on-site';
  return null;
}

/**
 * Localização final da vaga:
 *  - estrangeira -> null
 *  - cidade-alvo (cities.js) -> mantém com a cidade
 *  - outra cidade BR (ou não informada) + remota -> "Cidade (remoto)" / "Remoto (Brasil todo)"
 *  - outra cidade + presencial -> null
 */
// Rótulos que não são cidade específica -> "Remoto (Brasil todo)".
const NATIONWIDE_RE = /todo (o )?brasil|brasil todo|\bnacional\b|home[- ]?office|remoto|\bremote\b|h[íi]brido|presencial|anywhere|^brasil$|^brazil$|^\d/i;

// País/região fora do Brasil. Homônimas de cidades BR ("Porto") ficam de fora de
// propósito, pra não derrubar Porto Alegre/Velho.
const FOREIGN_RE =
  /estados unidos|united states|\beua\b|\bu\.?s\.?a\.?\b|remote\s*[-–—]\s*(us|usa|uk|eu|emea|latam)\b|us[- ]only|portugal|lisboa|\blisbon\b|espanha|espa[ñn]a|\bspain\b|madri\b|madrid|barcelona|argentina|buenos aires|\bchile\b|santiago de chile|m[ée]xico\b|mexico city|cidade do m[ée]xico|col[ôo]mbia|colombia|bogot[áa]|\bperu\b|\blima, per[úu]\b|uruguai|uruguay|montevid[ée]u|paraguai|paraguay|assun[çc][ãa]o do paraguai|bol[íi]via|equador\b|ecuador|venezuela|reino unido|united kingdom|inglaterra|\bengland\b|londres|\blondon\b|irlanda|\bireland\b|\bdublin\b|alemanha|germany|deutschland|berlim|\bberlin\b|fran[çc]a\b|\bfrance\b|\bparis\b|it[áa]lia|\bitaly\b|canad[áa]\b|\bcanada\b|toronto|austr[áa]lia|australia|holanda|netherlands|amsterd[ãa]|pol[ôo]nia|poland|jap[ãa]o|\bjapan\b|t[óo]quio|china\b|\b[íi]ndia\b|\bindia\b|dubai|emirados|singapura|singapore|calif[óo]rnia|california|palo alto|san francisco|\bnew york\b|nova iorque|\btexas\b|fl[óo]rida\b|\bflorida\b/i;

function isForeignLocation(text = '') {
  const t = String(text || '');
  return FOREIGN_RE.test(t) && !/brasil|brazil/i.test(t);
}

// Sinal positivo de Brasil: "brasil", nome de estado, ou UF ao final ("Recife, PE").
// Trava do fallback remoto: cidade específica sem sinal de Brasil = estrangeira.
const BR_STATES_RE =
  /\b(acre|alagoas|amap[áa]|amazonas|bahia|cear[áa]|distrito federal|esp[íi]rito santo|goi[áa]s|maranh[ãa]o|mato grosso(?: do sul)?|minas gerais|par[áa]|para[íi]ba|paran[áa]|pernambuco|piau[íi]|rio de janeiro|rio grande do (?:norte|sul)|rond[ôo]nia|roraima|santa catarina|s[ãa]o paulo|sergipe|tocantins)\b/i;
const BR_UF_TAIL_RE = /[,\-/\s–]\s*(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)\b/i;
// ~130 maiores cidades/capitais BR — allowlist p/ vaga remota que traz só o nome da
// cidade, sem UF nem "Brasil".
const BR_CITIES = new Set(
  ('sao paulo|rio de janeiro|brasilia|salvador|fortaleza|belo horizonte|manaus|curitiba|recife|goiania|belem|porto alegre|' +
    'guarulhos|campinas|sao luis|sao goncalo|maceio|duque de caxias|campo grande|natal|teresina|sao bernardo do campo|nova iguacu|' +
    'joao pessoa|santo andre|osasco|jaboatao dos guararapes|sao jose dos campos|ribeirao preto|uberlandia|contagem|sorocaba|aracaju|' +
    'feira de santana|cuiaba|joinville|juiz de fora|londrina|aparecida de goiania|ananindeua|niteroi|porto velho|serra|caxias do sul|' +
    'campos dos goytacazes|maua|vila velha|florianopolis|sao joao de meriti|mogi das cruzes|santos|betim|diadema|jundiai|carapicuiba|' +
    'piracicaba|montes claros|cariacica|bauru|maringa|anapolis|itaquaquecetuba|sao vicente|caucaia|caruaru|blumenau|franca|ponta grossa|' +
    'petrolina|canoas|paulista|ribeirao das neves|uberaba|cascavel|pelotas|guaruja|taubate|praia grande|vitoria|varzea grande|sao jose|' +
    'petropolis|barueri|santa maria|governador valadares|volta redonda|santarem|taboao da serra|itabuna|criciuma|maracanau|' +
    'sao carlos|sumare|marilia|imperatriz|gravatai|dourados|indaiatuba|itapevi|hortolandia|americana|passo fundo|araraquara|jacarei|' +
    'chapeco|rio branco|braganca paulista|maraba|palmas|sinop|sete lagoas|itajai|colombo|foz do iguacu|barreiras|luziania|ilheus|' +
    'boa vista|macapa|aracatuba|sao jose do rio preto|presidente prudente|divinopolis|santa barbara doeste|camacari|nova friburgo|' +
    'teofilo otoni|linhares|cabo frio|angra dos reis|patos de minas|pocos de caldas|ubatuba|maricá|marica|guaratingueta').split('|')
);
function looksBrazilian(text = '') {
  const t = String(text || '');
  if (/brasil|brazil/i.test(t) || BR_STATES_RE.test(t) || BR_UF_TAIL_RE.test(t)) return true;
  const bare = t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[-–/,(].*$/, '') // corta a partir de ", " / " - " / "(" — fica só o nome
    .trim();
  return BR_CITIES.has(bare);
}

function resolveCityOrRemote(locationText, { isRemote = false } = {}) {
  const txt = String(locationText || '');
  if (isForeignLocation(txt)) return null;
  const cityInfo = normalizeCity(locationText);
  if (TARGET_CITY_KEYS.includes(cityInfo.key)) return cityInfo;
  if (isRemote || isRemoteText(locationText)) {
    // Cidade BR identificável -> "Cidade (remoto)".
    const isKnownOtherCity =
      cityInfo.key === 'outra' && cityInfo.label.length >= 3 && !NATIONWIDE_RE.test(cityInfo.label);
    // Cidade sem sinal de Brasil = estrangeira.
    if (isKnownOtherCity && !looksBrazilian(txt)) return null;
    return { key: 'remoto', label: isKnownOtherCity ? `${cityInfo.label} (remoto)` : 'Remoto (Brasil todo)' };
  }
  return null;
}

function makeId(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function decodeEntities(text = '') {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&atilde;/g, 'ã')
    .replace(/&otilde;/g, 'õ').replace(/&ccedil;/g, 'ç').replace(/&ecirc;/g, 'ê')
    .replace(/&acirc;/g, 'â').replace(/&ocirc;/g, 'ô')
    .replace(/&amp;/g, '&');
}

function stripHtml(html = '') {
  return decodeEntities(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function snippet(text = '', max = 240) {
  const clean = stripHtml(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trim()}…`;
}

// "30/06/2026" (DD/MM/YYYY) -> ISO 8601.
function parseDateBR(dateStr) {
  if (!dateStr) return null;
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(dateStr.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "2026/08/17 05:43:00" -> ISO 8601.
function parseDateSlash(dateStr) {
  if (!dateStr) return null;
  const iso = dateStr.trim().replace(' ', 'T').replace(/\//g, '-');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function daysAgo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

module.exports = {
  SEGMENTS,
  isArchitectureJob,
  matchArchitectureKeyword,
  keywordCategory,
  jobSegments,
  classifyFacets,
  detectSeniority,
  normalizeCity,
  resolveCityOrRemote,
  isForeignLocation,
  looksBrazilian,
  isRemoteText,
  detectWorkplaceType,
  makeId,
  stripHtml,
  snippet,
  daysAgo,
  parseDateBR,
  parseDateSlash,
  decodeEntities,
  SENIORITY_PATTERNS,
  CITY_PATTERNS,
  TARGET_CITY_KEYS,
};
