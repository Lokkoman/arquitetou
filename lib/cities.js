// Lista CANÔNICA de cidades-alvo. Toda fonte parte daqui; cada scraper usa o campo no
// formato que o site dele aceita.
//
// Regra de localização (aplicada em util.js -> resolveCityOrRemote):
//   - vaga numa cidade-alvo  -> entra com a cidade
//   - vaga em QUALQUER outra cidade do Brasil -> só entra se for REMOTA
//     (aparece como "Cidade (remoto)" ou "Remoto (Brasil todo)")
//   - vaga presencial fora das cidades-alvo -> descartada

const TARGET_CITIES = [
  { key: 'sao_paulo', label: 'São Paulo', gupy: 'São Paulo', slug: 'sao-paulo', linkedin: 'São Paulo, Brasil', indeed: 'São Paulo', catho: 'sao-paulo-sp' },
  { key: 'osasco', label: 'Osasco', gupy: 'Osasco', slug: 'osasco', linkedin: 'Osasco, São Paulo, Brasil', indeed: 'Osasco', catho: 'osasco-sp' },
  { key: 'guarulhos', label: 'Guarulhos', gupy: 'Guarulhos', slug: 'guarulhos', linkedin: 'Guarulhos, São Paulo, Brasil', indeed: 'Guarulhos', catho: 'guarulhos-sp' },
  { key: 'barueri', label: 'Barueri', gupy: 'Barueri', slug: 'barueri', linkedin: 'Barueri, São Paulo, Brasil', indeed: 'Barueri', catho: 'barueri-sp' },
  { key: 'taboao', label: 'Taboão da Serra', gupy: 'Taboão da Serra', slug: 'taboao-da-serra', linkedin: 'Taboão da Serra, São Paulo, Brasil', indeed: 'Taboão da Serra', catho: 'taboao-da-serra-sp' },
];

const TARGET_CITY_KEYS = TARGET_CITIES.map((c) => c.key);

// Padrões para reconhecer a cidade-alvo no texto livre da vaga. Cada um casa o NOME da
// cidade, não a sigla do estado. IMPORTANTE: São Paulo é só /são paulo/ — NÃO `\bsp\b`,
// senão "Jacareí - SP", "Campinas / SP" etc. (estado inteiro) virariam a capital em vez
// de caírem como "outra cidade" (que só entra se for remota).
const CITY_PATTERNS = [
  { key: 'taboao', label: 'Taboão da Serra', re: /tabo[ãa]o da serra|\btabo[ãa]o\b/i },
  { key: 'osasco', label: 'Osasco', re: /\bosasco\b/i },
  { key: 'guarulhos', label: 'Guarulhos', re: /\bguarulhos\b/i },
  { key: 'barueri', label: 'Barueri', re: /\bbarueri\b/i },
  { key: 'sao_paulo', label: 'São Paulo', re: /s[ãa]o paulo(?!\s+d[eo]\b)/i },
];

module.exports = { TARGET_CITIES, TARGET_CITY_KEYS, CITY_PATTERNS };
