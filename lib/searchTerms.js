// Base única de termos de pesquisa. Todo coletor gera suas consultas a partir daqui;
// adicionar um termo faz todas as fontes do tier dele pra baixo passarem a buscá-lo.
//
// Campos:
//   term   a frase de busca
//   seg    segmento (organização / relatório)
//   kind   'cargo' | 'escopo' | 'programa'
//   tier   'core'  -> vai pra TODAS as fontes, inclusive as caras/frágeis
//                     (LinkedIn nativo, Bright Data, Gupy, OR do LinkedIn).
//          'head'  -> core + fontes de lista média (Vagas.com/BNE por cidade,
//                     Catho, OR do Indeed). NÃO vai pro LinkedIn/Bright Data.
//          (sem tier) -> só as de lista completa (InfoJobs busca livre, passada
//                     nacional de Vagas.com/BNE).
//   stem   radical p/ substring (Gupy). Só nos `core`.
//
// REGRA DE OURO: nenhum termo `core`/`head` pode ter suas palavras contidas em outro
// do mesmo nível (senão a busca é redundante — "arquiteto de obra" ⊂ "arquiteto").
// checkRedundancy() valida; roda no build.

const BASE = [
  // --- Arquitetura & Projeto ---
  { term: 'arquiteto', seg: 'arquitetura', kind: 'cargo', tier: 'core', stem: 'arquitet' },
  { term: 'arquitetura', seg: 'arquitetura', kind: 'cargo', tier: 'head' },
  { term: 'projeto arquitetônico', seg: 'arquitetura', kind: 'escopo' },
  { term: 'anteprojeto', seg: 'arquitetura', kind: 'escopo' },
  { term: 'estudo preliminar', seg: 'arquitetura', kind: 'escopo' },
  { term: 'arquiteto de incorporação', seg: 'arquitetura', kind: 'cargo' },
  { term: 'arquiteto de varejo', seg: 'arquitetura', kind: 'cargo' },
  { term: 'arquiteto hospitalar', seg: 'arquitetura', kind: 'cargo' },
  { term: 'arquiteto corporativo', seg: 'arquitetura', kind: 'cargo' },

  // --- Urbanismo & Planejamento ---
  { term: 'urbanista', seg: 'urbanismo', kind: 'cargo', tier: 'core', stem: 'urbanis' },
  { term: 'urbanismo', seg: 'urbanismo', kind: 'cargo', tier: 'head' },
  { term: 'plano diretor', seg: 'urbanismo', kind: 'escopo', tier: 'core' },
  { term: 'planejamento urbano', seg: 'urbanismo', kind: 'escopo', tier: 'head' },
  { term: 'planejamento territorial', seg: 'urbanismo', kind: 'escopo' },
  { term: 'desenho urbano', seg: 'urbanismo', kind: 'escopo' },
  { term: 'projeto urbano', seg: 'urbanismo', kind: 'escopo' },
  { term: 'mobilidade urbana', seg: 'urbanismo', kind: 'escopo' },
  { term: 'operação urbana', seg: 'urbanismo', kind: 'escopo' },
  { term: 'loteamento', seg: 'urbanismo', kind: 'escopo', tier: 'head', stem: 'loteamento' },
  { term: 'parcelamento do solo', seg: 'urbanismo', kind: 'escopo' },
  { term: 'habitação de interesse social', seg: 'urbanismo', kind: 'escopo', tier: 'head' },

  // --- Licenciamento & Regularização ---
  { term: 'regularização', seg: 'licenciamento', kind: 'escopo', tier: 'core', stem: 'regulariza' },
  { term: 'legalização', seg: 'licenciamento', kind: 'escopo', tier: 'core', stem: 'legaliza' },
  { term: 'licenciamento', seg: 'licenciamento', kind: 'escopo', tier: 'core', stem: 'licenciamento' },
  { term: 'aprovação de projetos', seg: 'licenciamento', kind: 'escopo', tier: 'core', stem: 'aprovação de projeto' },
  { term: 'habite-se', seg: 'licenciamento', kind: 'escopo', tier: 'core', stem: 'habite-se' },
  { term: 'projeto legal', seg: 'licenciamento', kind: 'escopo', tier: 'head' },
  { term: 'alvará', seg: 'licenciamento', kind: 'escopo', tier: 'head', stem: 'alvará' },
  { term: 'AVCB', seg: 'licenciamento', kind: 'escopo', tier: 'head', stem: 'avcb' },
  { term: 'REURB', seg: 'licenciamento', kind: 'escopo', tier: 'head', stem: 'reurb' },
  { term: 'georreferenciamento', seg: 'licenciamento', kind: 'escopo', tier: 'head', stem: 'georreferenciamento' },
  { term: 'usucapião', seg: 'licenciamento', kind: 'escopo', tier: 'head', stem: 'usucapi' },
  { term: 'due diligence imobiliária', seg: 'licenciamento', kind: 'escopo', tier: 'head' },
  { term: 'averbação de construção', seg: 'licenciamento', kind: 'escopo' },
  { term: 'retificação de área', seg: 'licenciamento', kind: 'escopo' },
  { term: 'desmembramento', seg: 'licenciamento', kind: 'escopo' },
  { term: 'projeto de prevenção contra incêndio', seg: 'licenciamento', kind: 'escopo' },
  { term: 'PPCI', seg: 'licenciamento', kind: 'escopo' },
  { term: 'licença ambiental', seg: 'licenciamento', kind: 'escopo' },
  { term: 'estudo de impacto de vizinhança', seg: 'licenciamento', kind: 'escopo' },

  // --- Restauro & Patrimônio ---
  { term: 'restauro', seg: 'restauro', kind: 'escopo', tier: 'core', stem: 'restauro' },
  { term: 'retrofit', seg: 'restauro', kind: 'escopo', tier: 'head', stem: 'retrofit' },
  { term: 'patrimônio histórico', seg: 'restauro', kind: 'escopo', tier: 'head' },
  { term: 'patrimônio edificado', seg: 'restauro', kind: 'escopo' },
  { term: 'conservação e restauro', seg: 'restauro', kind: 'escopo' },

  // --- Perícia & Avaliação de Imóveis ---
  { term: 'laudo', seg: 'pericia', kind: 'escopo', tier: 'head', stem: 'laudo' },
  { term: 'perícia', seg: 'pericia', kind: 'escopo', tier: 'head', stem: 'perícia' },
  { term: 'avaliação de imóveis', seg: 'pericia', kind: 'escopo', tier: 'core', stem: 'avaliação de imóvel' },
  { term: 'vistoria cautelar', seg: 'pericia', kind: 'escopo', tier: 'head' },
  { term: 'inspeção predial', seg: 'pericia', kind: 'escopo', tier: 'head' },
  { term: 'NBR 14653', seg: 'pericia', kind: 'escopo' },
  { term: 'laudo de acessibilidade', seg: 'pericia', kind: 'escopo' },
  { term: 'avaliação patrimonial', seg: 'pericia', kind: 'escopo' },

  // --- Sustentabilidade & Certificações ---
  { term: 'construção sustentável', seg: 'sustentabilidade', kind: 'escopo', tier: 'head', stem: 'sustentável' },
  { term: 'LEED', seg: 'sustentabilidade', kind: 'escopo', tier: 'head', stem: 'leed' },
  { term: 'AQUA-HQE', seg: 'sustentabilidade', kind: 'escopo', tier: 'head' },
  { term: 'eficiência energética', seg: 'sustentabilidade', kind: 'escopo', tier: 'head' },
  { term: 'conforto ambiental', seg: 'sustentabilidade', kind: 'escopo', tier: 'head' },
  { term: 'arquitetura sustentável', seg: 'sustentabilidade', kind: 'escopo' },
  { term: 'certificação ambiental de edifícios', seg: 'sustentabilidade', kind: 'escopo' },
  { term: 'NBR 15575', seg: 'sustentabilidade', kind: 'escopo' },
  { term: 'desempenho térmico', seg: 'sustentabilidade', kind: 'escopo' },

  // --- BIM & Compatibilização ---
  { term: 'BIM', seg: 'bim', kind: 'programa', tier: 'core', stem: 'bim' },
  { term: 'compatibilização de projetos', seg: 'bim', kind: 'escopo', tier: 'core', stem: 'compatibiliza' },
  { term: 'Navisworks', seg: 'bim', kind: 'programa' },
  { term: 'coordenador de projetos', seg: 'bim', kind: 'cargo' },

  // --- Paisagismo ---
  { term: 'paisagismo', seg: 'paisagismo', kind: 'escopo', tier: 'core', stem: 'paisagis' },
  { term: 'landscape architect', seg: 'paisagismo', kind: 'cargo', tier: 'head' },
  { term: 'projeto paisagístico', seg: 'paisagismo', kind: 'escopo' },
  { term: 'arquitetura da paisagem', seg: 'paisagismo', kind: 'escopo' },

  // --- Interiores ---
  { term: 'interiores', seg: 'interiores', kind: 'escopo', tier: 'core', stem: 'interiores' },
  { term: 'ambientação de espaços', seg: 'interiores', kind: 'escopo' },
  { term: 'decoração de interiores', seg: 'interiores', kind: 'escopo' },
  { term: 'marcenaria', seg: 'interiores', kind: 'escopo' },

  // --- Obra & Acompanhamento ---
  { term: 'acompanhamento de obra', seg: 'obra', kind: 'escopo', tier: 'core' },
  { term: 'fiscalização de obra', seg: 'obra', kind: 'escopo', tier: 'head' },
  { term: 'gerenciamento de obras', seg: 'obra', kind: 'escopo', tier: 'head' },
  { term: 'as built', seg: 'obra', kind: 'escopo', tier: 'head' },
  { term: 'arquiteto residente', seg: 'obra', kind: 'cargo' },
  { term: 'compatibilização em obra', seg: 'obra', kind: 'escopo' },
  { term: 'planejamento de obras', seg: 'obra', kind: 'escopo' },

  // --- Visualização 3D & Maquete ---
  { term: 'maquete', seg: 'viz3d', kind: 'escopo', tier: 'core', stem: 'maquete' },
  { term: 'renderização', seg: 'viz3d', kind: 'escopo', tier: 'head', stem: 'renderiza' },
  { term: 'artista 3D', seg: 'viz3d', kind: 'cargo', tier: 'head' },
  { term: 'visualização arquitetônica', seg: 'viz3d', kind: 'escopo' },
  { term: 'Lumion', seg: 'viz3d', kind: 'programa', stem: 'lumion' },
  { term: 'V-Ray', seg: 'viz3d', kind: 'programa' },
  { term: 'Enscape', seg: 'viz3d', kind: 'programa', stem: 'enscape' },
  { term: 'Twinmotion', seg: 'viz3d', kind: 'programa' },
  { term: '3ds Max', seg: 'viz3d', kind: 'programa' },

  // --- CAD, Projetista & Detalhamento ---
  { term: 'projetista', seg: 'cad', kind: 'cargo', tier: 'core', stem: 'projetista' },
  { term: 'cadista', seg: 'cad', kind: 'cargo', tier: 'head', stem: 'cadista' },
  { term: 'desenhista', seg: 'cad', kind: 'cargo', tier: 'head', stem: 'desenhista' },
  { term: 'AutoCAD', seg: 'cad', kind: 'programa', tier: 'core', stem: 'autocad' },
  { term: 'ArchiCAD', seg: 'cad', kind: 'programa', tier: 'core', stem: 'archicad' },
  { term: 'SketchUp', seg: 'cad', kind: 'programa', tier: 'core', stem: 'sketchup' },
  { term: 'Revit', seg: 'cad', kind: 'programa', tier: 'core', stem: 'revit' },
  { term: 'projeto executivo', seg: 'cad', kind: 'escopo', tier: 'head' },
  { term: 'detalhamento', seg: 'cad', kind: 'escopo', tier: 'head', stem: 'detalhamento' },
  { term: 'caderno de especificações', seg: 'cad', kind: 'escopo' },
  { term: 'projeto para produção', seg: 'cad', kind: 'escopo' },

];

// --- derivações ---
const uniq = (arr) => [...new Set(arr)];

const CORE = BASE.filter((t) => t.tier === 'core');
const HEAD = BASE.filter((t) => t.tier === 'core' || t.tier === 'head');

const TERMS = uniq(BASE.map((t) => t.term)); // tudo (InfoJobs livre / passada nacional)
const CORE_TERMS = uniq(CORE.map((t) => t.term)); // LinkedIn nativo, Bright Data, OR do LinkedIn
const HEAD_TERMS = uniq(HEAD.map((t) => t.term)); // Vagas.com/BNE por cidade, Catho, OR do Indeed
const STEMS = uniq(BASE.map((t) => t.stem).filter(Boolean)); // Gupy (substring)
// Bright Data: cargos+escopo rodam com passada remota; programas só São Paulo.
const BD_ROLE_KEYWORDS = uniq(CORE.filter((t) => t.kind !== 'programa').map((t) => t.term));
const BD_TOOL_KEYWORDS = uniq(CORE.filter((t) => t.kind === 'programa').map((t) => t.term));

// OR pra Indeed / LinkedIn deeplink. quoteMulti = frase de 2+ palavras entre aspas.
function orQuery(terms, { quoteMulti = true } = {}) {
  return (terms || CORE_TERMS).map((t) => (quoteMulti && /\s/.test(t) ? `"${t}"` : t)).join(' OR ');
}

// Redundância: um termo core/head cujas palavras já estão TODAS em outro do mesmo nível.
function checkRedundancy() {
  const norm = (s) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1 && !['de', 'da', 'do', 'em', 'com', 'para'].includes(w));
  const bad = [];
  for (const level of [CORE_TERMS, HEAD_TERMS]) {
    const sets = level.map((t) => ({ term: t, words: new Set(norm(t)) }));
    for (const a of sets) {
      for (const b of sets) {
        if (a.term === b.term || a.words.size <= b.words.size) continue;
        if ([...b.words].every((w) => a.words.has(w))) bad.push(`"${a.term}" redundante — "${b.term}" já cobre`);
      }
    }
  }
  return uniq(bad);
}

module.exports = {
  BASE,
  CORE,
  HEAD,
  TERMS,
  CORE_TERMS,
  HEAD_TERMS,
  STEMS,
  BD_ROLE_KEYWORDS,
  BD_TOOL_KEYWORDS,
  orQuery,
  checkRedundancy,
};
