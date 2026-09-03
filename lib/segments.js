// Segmentos de vaga — fonte ÚNICA da verdade para busca + filtro do site + classificação.
//
// Cada segmento tem:
//   key    slug (valor do filtro e da categoria)
//   label  nome exibido
//   query  termos-CABEÇA para as buscas (poucos, os que os sites indexam melhor)
//   stems  radicais curtos p/ busca por substring (Gupy)
//   match  lista EXAUSTIVA de { label, re } — reconhece e rotula qualquer vaga que
//          volte de qualquer fonte. É aqui que mora toda a variação de escrita.
//
// A ordem importa: segmentos ESPECÍFICOS vêm antes de "Arquitetura & Projeto" (genérico),
// pra uma vaga "Arquiteto de Aprovação de Projetos" cair em Licenciamento, não em Arquitetura.

const SEGMENTS = [
  {
    key: 'licenciamento',
    label: 'Licenciamento & Regularização',
    query: [
      'regularização de imóveis',
      'regularização predial',
      'regularização fundiária',
      'REURB',
      'legalização de obras',
      'legalização de imóveis',
      'aprovação de projetos',
      'aprovação de projeto legal',
      'projeto legal',
      'licenciamento urbanístico',
      'licenciamento de obras',
      'licenciamento ambiental',
      'habite-se',
      'alvará de construção',
      'alvará de reforma',
      'AVCB',
      'projeto de prevenção contra incêndio',
      'georreferenciamento',
      'usucapião',
      'averbação de construção',
      'retificação de área',
      'desmembramento',
      'due diligence imobiliária',
      'analista de regularização',
      'analista de aprovação de projetos',
      'consultor imobiliário técnico',
    ],
    stems: ['regulariza', 'legaliza', 'licenciamento', 'aprovação de projeto', 'habite-se', 'alvará', 'avcb', 'usucapi', 'georreferenciamento', 'reurb', 'averbação'],
    match: [
      { label: 'regularização de imóveis', re: /regulariza[çc][ãa]o (de |)(im[óo]ve(l|is)|edifica[çc][õo]es|obras?|constru[çc][ãa]o|predial|edil[íi]cia)/i },
      { label: 'regularização fundiária', re: /regulariza[çc][ãa]o fundi[áa]ria|\breurb\b|reurb-?[se]/i },
      { label: 'regularização', re: /regulariza[çc][ãa]o/i },
      { label: 'legalização de obras', re: /legaliza[çc][ãa]o (de |)(im[óo]ve(l|is)|obras?|edifica[çc][õo]es|predial)/i },
      { label: 'legalização', re: /legaliza[çc][ãa]o/i },
      { label: 'anistia de obras', re: /anistia (de obras?|edil[íi]cia)/i },
      { label: 'averbação de construção', re: /averba[çc][ãa]o (de |)(constru[çc][ãa]o|área construída|edifica[çc][ãa]o)/i },
      { label: 'desdobro / desmembramento', re: /desmembramento|remembramento|unifica[çc][ãa]o de lotes?|\bdesdobro\b/i },
      { label: 'retificação de área', re: /retifica[çc][ãa]o (de |)([áa]rea|matr[íi]cula|administrativa)/i },
      { label: 'usucapião', re: /usucapi[ãa]o/i },
      { label: 'aprovação de projetos', re: /aprova[çc][ãa]o de (projetos?|plantas?)|projeto (legal|de prefeitura|para aprova[çc][ãa]o|de aprova[çc][ãa]o)|projeto aprovado na prefeitura/i },
      { label: 'consulta de viabilidade', re: /consulta de viabilidade|certid[ãa]o de uso do solo|diretrizes urban[íi]sticas/i },
      { label: 'licenciamento', re: /licenciamento (urban[íi]stico|edil[íi]cio|ambiental|de obras?|de constru[çc][ãa]o)/i },
      { label: 'licenciamento', re: /licenciamento/i },
      { label: 'alvará', re: /alvar[áa] de (constru[çc][ãa]o|aprova[çc][ãa]o|execu[çc][ãa]o|reforma|demoli[çc][ãa]o|funcionamento|obra)/i },
      { label: 'habite-se', re: /habite-?se|auto de conclus[ãa]o|carta de habita[çc][ãa]o|certificado de conclus[ãa]o de obra|\bcco\b/i },
      { label: 'AVCB', re: /\bavcb\b|\bclcb\b|auto de vistoria do corpo de bombeiros/i },
      { label: 'PPCI / projeto de incêndio', re: /\bppci\b|projeto de (preven[çc][ãa]o (contra|de) inc[êe]ndio|combate a inc[êe]ndio|inc[êe]ndio|seguran[çc]a contra inc[êe]ndio)|\bscip\b|\bcbmesp\b/i },
      { label: 'licenciamento ambiental', re: /licen[çc]a ambiental|licenciamento ambiental|\beia\/?rima\b|estudo de impacto ambiental|\boutorga\b|\bcar\b cadastro ambiental/i },
      { label: 'estudo de impacto de vizinhança', re: /estudo de impacto de vizinhan[çc]a|\beiv\b/i },
      { label: 'georreferenciamento', re: /georreferenciamento|certifica[çc][ãa]o incra|\bgeo\b incra/i },
      { label: 'levantamento / as built', re: /levantamento (topogr[áa]fico|planialtim[ée]trico|cadastral)|\bas built\b|cadastro (t[ée]cnico|imobili[áa]rio)/i },
      { label: 'due diligence imobiliária', re: /due diligence (imobili[áa]ria|de im[óo]ve(l|is))|an[áa]lise documental de im[óo]ve(l|is)|an[áa]lise de conformidade (predial|de im[óo]ve(l|is))/i },
      { label: 'parcelamento do solo', re: /parcelamento do solo|regulariza[çc][ãa]o de loteamento/i },
      { label: 'regularização (cargo)', re: /(analista|coordenador|especialista|consultor|t[ée]cnico|assistente)( de| em)? (regulariza[çc][ãa]o|aprova[çc][ãa]o de projetos?|licenciamento|legaliza[çc][ãa]o)|arquiteto (de aprova[çc][ãa]o|legalista|de prefeitura|de licenciamento)/i },
    ],
  },
  {
    key: 'restauro',
    label: 'Restauro & Patrimônio',
    query: ['restauro arquitetônico', 'restauro de edifícios', 'patrimônio histórico', 'patrimônio edificado', 'retrofit predial', 'retrofit de fachada', 'conservação e restauro', 'arquiteto de restauro', 'projeto de restauro'],
    stems: ['restauro', 'retrofit'],
    match: [
      { label: 'restauro', re: /restauro( arquitet[ôo]nico| de edif[íi]cios?| do patrim[ôo]nio)?|restaura[çc][ãa]o (arquitet[ôo]nica|de edif[íi]cios?|do patrim[ôo]nio)/i },
      { label: 'patrimônio histórico', re: /patrim[ôo]nio (hist[óo]rico|edificado|cultural|arquitet[ôo]nico)|bens tombados|\biphan\b|\bcondephaat\b|\bconpresp\b/i },
      { label: 'retrofit', re: /\bretrofit\b/i },
      { label: 'conservação', re: /conserva[çc][ãa]o (e restauro|do patrim[ôo]nio|preventiva)/i },
    ],
  },
  {
    key: 'pericia',
    label: 'Perícia & Avaliação de Imóveis',
    query: ['avaliação de imóveis', 'avaliação patrimonial', 'laudo pericial', 'laudo de vistoria', 'laudo técnico de edificação', 'perícia de engenharia', 'perícia predial', 'NBR 14653', 'laudo de acessibilidade', 'inspeção predial', 'vistoria cautelar', 'avaliação imobiliária'],
    stems: ['perícia', 'avaliação de imóvel', 'laudo'],
    match: [
      { label: 'avaliação de imóveis', re: /avalia[çc][ãa]o (de |)(im[óo]ve(l|is)|patrimonial|de bens? im[óo]ve(l|is))|\bnbr ?14653\b|\bnbr ?14.?653\b/i },
      { label: 'laudo pericial', re: /laudo (pericial|de vistoria|de avalia[çc][ãa]o|t[ée]cnico|de habitabilidade)|per[íi]cia (de engenharia|judicial|t[ée]cnica|de arquitetura)/i },
      { label: 'acessibilidade', re: /laudo de acessibilidade|\bnbr ?9050\b|acessibilidade (arquitet[ôo]nica|em edifica[çc][õo]es)/i },
      { label: 'assistência técnica pericial', re: /assistente t[ée]cnico pericial|assist[êe]ncia t[ée]cnica em per[íi]cia/i },
    ],
  },
  {
    key: 'sustentabilidade',
    label: 'Sustentabilidade & Certificações',
    query: ['arquitetura sustentável', 'construção sustentável', 'LEED', 'AQUA-HQE', 'GBC Brasil', 'certificação ambiental de edifícios', 'eficiência energética em edificações', 'conforto ambiental', 'desempenho térmico', 'NBR 15575', 'consultoria em sustentabilidade', 'analista de sustentabilidade predial'],
    stems: ['leed', 'sustentável'],
    match: [
      { label: 'LEED / AQUA / GBC', re: /\bleed\b|aqua-?hqe|\bgbc\b|selo casa azul|edge (certifica|building)|\bwell\b certifica/i },
      { label: 'arquitetura sustentável', re: /arquitetura sustent[áa]vel|constru[çc][ãa]o sustent[áa]vel|green building|edif[íi]cio verde/i },
      { label: 'eficiência energética', re: /efici[êe]ncia energ[ée]tica|desempenho t[ée]rmico|\bnbr ?15575\b|simula[çc][ãa]o (t[ée]rmica|energ[ée]tica)/i },
      { label: 'conforto ambiental', re: /conforto (ambiental|t[ée]rmico|ac[úu]stico|lum[íi]nico)|bioclim[áa]tic[ao]/i },
    ],
  },
  {
    key: 'viz3d',
    label: 'Visualização 3D & Maquete',
    query: ['maquete eletrônica', 'maquetaria', 'renderização arquitetura', 'render 3d arquitetura', 'Lumion', 'V-Ray', 'Enscape', 'Twinmotion', '3ds Max', 'SketchUp render', 'artista 3d arquitetura', 'visualização arquitetônica'],
    stems: ['maquete eletrônica', 'lumion', 'enscape'],
    match: [
      { label: 'maquete eletrônica', re: /maquete (eletr[ôo]nica|digital|3d|virtual)|maquete f[íi]sica|maquetaria/i },
      { label: 'renderização', re: /renderiza[çc][ãa]o|\brender\b (arquitet|de interiores|3d)|imagens? (fotorrealista|3d) (de |)(arquitet|interiores)/i },
      { label: 'Lumion / V-Ray / Enscape', re: /\blumion\b|\bv-?ray\b|\benscape\b|\bcorona render\b|\btwinmotion\b/i },
      { label: '3ds Max', re: /3ds ?max|cinema ?4d/i },
      { label: 'artista 3D (arquitetura)', re: /artista 3d|\b3d artist\b|visualiza[çc][ãa]o (arquitet[ôo]nica|3d)/i },
    ],
  },
  {
    key: 'bim',
    label: 'BIM & Compatibilização',
    query: ['BIM', 'coordenador BIM', 'modelador BIM', 'gerente BIM', 'projetista BIM', 'analista BIM', 'especialista BIM', 'compatibilização de projetos', 'coordenação de projetos BIM', 'Revit', 'Navisworks', 'BIM manager'],
    stems: ['compatibiliza'],
    match: [
      { label: 'BIM', re: /\bbim\b|building information model/i },
      { label: 'coordenação BIM', re: /(coordenador|gerente|l[íi]der|especialista|analista|modelador|projetista)( de| em)? bim|bim (manager|coordinator|modeler)/i },
      { label: 'compatibilização de projetos', re: /compatibiliza[çc][ãa]o de projetos?|clash detection|\bnavisworks\b|federa[çc][ãa]o de modelos/i },
    ],
  },
  {
    key: 'paisagismo',
    label: 'Paisagismo',
    query: ['paisagismo', 'arquiteto paisagista', 'paisagista', 'projeto paisagístico', 'projeto de paisagismo', 'arquitetura da paisagem', 'landscape design', 'designer de paisagismo'],
    stems: ['paisagis'],
    match: [
      { label: 'paisagismo', re: /paisagis(mo|ta|t[íi]co)|projeto paisag[íi]stico|arquitetura da paisagem|landscape (architect|design)/i },
    ],
  },
  {
    key: 'interiores',
    label: 'Interiores',
    query: ['arquitetura de interiores', 'design de interiores', 'designer de interiores', 'projeto de interiores', 'arquiteto de interiores', 'projetista de interiores', 'ambientação de interiores', 'interiores corporativos', 'interiores residenciais', 'decoração de interiores'],
    stems: ['interiores'],
    match: [
      { label: 'interiores', re: /(arquitetura|design|designer|projeto|projetista) de interiores|interior design|ambienta[çc][ãa]o de (espa[çc]os|ambientes)|arquiteto de interiores/i },
    ],
  },
  {
    key: 'obra',
    label: 'Obra & Acompanhamento',
    query: ['arquiteto de obra', 'arquiteto residente', 'acompanhamento de obra', 'as built', 'fiscalização de obra', 'coordenador de obra', 'gerenciamento de obras', 'compatibilização em obra', 'planejamento de obras', 'coordenação de campo', 'engenharia de campo arquitetura'],
    stems: [],
    match: [
      { label: 'obra / acompanhamento', re: /arquiteto (de |residente de |)obra|acompanhamento (de |t[ée]cnico de )obra|(fiscaliza[çc][ãa]o|gerenciamento|coordena[çc][ãa]o|gest[ãa]o) de obras?|\bcanteiro de obras?\b/i },
      { label: 'as built', re: /\bas ?built\b/i },
    ],
  },
  {
    key: 'cad',
    label: 'CAD, Projetista & Detalhamento',
    query: ['projetista', 'projetista de arquitetura', 'cadista', 'desenhista projetista', 'AutoCAD', 'ArchiCAD', 'SketchUp', 'Revit', 'projeto executivo', 'projeto executivo de arquitetura', 'detalhamento arquitetônico', 'caderno de especificações', 'projeto para produção'],
    stems: ['projetista', 'cadista', 'autocad', 'archicad', 'sketchup', 'detalhamento', 'revit'],
    match: [
      { label: 'projetista / cadista', re: /\bprojetista\b|\bcadista\b|desenhista (projetista|t[ée]cnico|de projetos)/i },
      { label: 'AutoCAD', re: /autocad/i },
      { label: 'ArchiCAD', re: /archicad/i },
      { label: 'SketchUp', re: /sketch ?up/i },
      { label: 'Revit', re: /\brevit\b/i },
      { label: 'projeto executivo / detalhamento', re: /projeto executivo( de arquitetura)?|detalhamento (de |)(arquitet[ôo]nico|projetos?|construtivo)|caderno de (especifica[çc][õo]es|detalhes)/i },
    ],
  },
  {
    key: 'urbanismo',
    label: 'Urbanismo & Planejamento',
    query: ['urbanismo', 'urbanista', 'arquiteto urbanista', 'planejamento urbano', 'planejamento territorial', 'plano diretor', 'desenho urbano', 'projeto urbano', 'mobilidade urbana', 'loteamento urbano', 'gestão urbana', 'operação urbana', 'habitação de interesse social'],
    stems: ['urbanis'],
    match: [
      { label: 'urbanismo', re: /urbanis(mo|ta|t[íi]co)/i },
      { label: 'planejamento urbano', re: /planejamento (urbano|territorial|metropolitano)|plano diretor|desenho urbano|projeto urbano|opera[çc][ãa]o urbana/i },
      { label: 'mobilidade urbana', re: /mobilidade urbana|plano de mobilidade|transporte urbano|desenho vi[áa]rio/i },
      { label: 'loteamento', re: /\bloteamento\b|\bloteador[ao]?\b|parcelamento urbano/i },
      { label: 'gestão urbana', re: /gest[ãa]o urbana|pol[íi]tica urbana|habita[çc][ãa]o de interesse social|\bHIS\b/ },
    ],
  },
  {
    key: 'arquitetura',
    label: 'Arquitetura & Projeto',
    query: ['arquiteto', 'arquiteta', 'arquitetura e urbanismo', 'projeto arquitetônico', 'projeto de arquitetura', 'anteprojeto', 'estudo preliminar', 'arquiteto pleno', 'arquiteto sênior', 'arquiteto júnior', 'estágio arquitetura', 'arquiteto de incorporação', 'arquiteto de varejo', 'arquiteto hospitalar', 'arquiteto corporativo'],
    stems: ['arquitet'],
    match: [
      { label: 'arquitetura', re: /arquitet[ôo]?(o|a|os|as|ura|[ôo]nico|[ôo]nica)|architect\b/i },
      { label: 'projeto arquitetônico', re: /projeto arquitet[ôo]nico|anteprojeto|estudo preliminar|estudo de massa|concep[çc][ãa]o arquitet[ôo]nica/i },
    ],
  },
];

// Termos de TI/dados/negócios que usam "arquitetura"/"arquiteto" mas não são a vaga.
const EXCLUDE = [
  /solu[cç][õo]es|software|\bdados\b|distribu[íi]da|integra[cç][ãa]o|integra[cç][õo]es|sistemas?\b|nuvem|cloud|\bti\b|devops|devsecops/i,
  /appsec|seguran[cç]a da informa[cç][ãa]o|martech|corporativa|empresarial|\bia\b|intelig[êe]ncia artificial|\bllms?\b/i,
  /information architect|solutions? architect|data architect|cloud architect|enterprise architect|software architect|security architect/i,
  /golang|\baws\b|\.net\b|salesforce|kubernetes|backend|full ?stack|mainframe|vmware|openshift/i,
  /scrum|kanban|\bjira\b|confluence|agile|telon|cobol|as\/?400|\boracle\b|\bsap\b|s\/?4\s?hana|\berp\b|\botm\b/i,
  /pr[ée][- ]vendas|\bcrm\b|servicenow|mendix|amazon connect|produtos e tecnologia|pegasystems|\bpega\b/i,
  /licenciamento de (software|marca|franquia|ve[íi]culos?|ti\b)|contratos? licenciad|software asset management|\bmicrosoft\b/i,
  /societ[áa]ri[ao]|contabilidade|cont[áa]bil|contador(a|es)?\b|legaliza[çc][ãa]o de empresas?|abertura de empresas?/i,
  /solid ?works|inventor autodesk|\bcatia\b|\bcreo\b|\bgame\b|\bjogos?\b|game ?design|game ?art|\bunity\b|\bunreal engine\b|personagens 3d|\bvfx\b/i,
  // "Projetista" de outras engenharias — não é arquitetura.
  /projetista (el[ée]tric[oa]|hidr[áa]ulic[oa]|mec[âa]nic[oa]|de tubula[çc]|de m[óo]veis|de produto|industrial|de estruturas met[áa]lic|de caldeiraria|de pcp|de instala[çc][õo]es (el[ée]tric|hidr))/i,
  /desenhista (mec[âa]nic|el[ée]tric|industrial|de produto)/i,
];

// Prioridade quando um título casa vários segmentos: menor índice ganha. Especialidades
// primeiro; "arquiteto" genérico antes das ferramentas; CAD por último.
const PRIORITY = [
  'licenciamento',
  'restauro',
  'pericia',
  'sustentabilidade',
  'bim',
  'paisagismo',
  'interiores',
  'obra',
  'viz3d',
  'urbanismo',
  'arquitetura',
  'cad',
];

const ORDERED = [...SEGMENTS].sort((a, b) => PRIORITY.indexOf(a.key) - PRIORITY.indexOf(b.key));

// Rede de segurança: passa nisto, não bate no EXCLUDE, mas nenhum segmento reconheceu
// -> mantém em "Outras / a revisar". Recall > precisão (o LLM refina depois).
const ADJACENT =
  /arquitet|urban[íi]|edif[íi]c|constru[çc][ãa]o civil|obras? (civil|predial|comercial|residencial)|im[óo]ve(l|is)|predial|incorpora[çc][ãa]o imobili|projeto (b[áa]sico|executivo|complementar|de arquitetura|urban)|\bcau\b|\bcau\/[a-z]{2}\b|prancheta|maquete|paisag|interiores|habite-se|alvar[áa]|licenciamento|regulariza|aprova[çc][ãa]o de projeto|\bbim\b|autocad|archicad|sketchup|\brevit\b/i;

// Balde extra só para o FILTRO do site (não entra no reconhecedor).
const OUTROS = { key: 'outros', label: 'Outras / a revisar' };
const FILTER_SEGMENTS = [...ORDERED.map((s) => ({ key: s.key, label: s.label })), OUTROS];

// 3 eixos além do segmento: CARGO (título), ESCOPO (o que pede) e PROGRAMA (software).
// Cada eixo devolve todos os rótulos que baterem. Vira job.roles/scope/tools + filtro.

// CARGO — casado no título.
const ROLES = [
  { label: 'Arquiteto(a)', re: /\barquitet[oa]s?\b|\barchitect\b/i },
  { label: 'Urbanista', re: /\burbanist[ao]s?\b/i },
  { label: 'Projetista', re: /\bprojetist[ao]s?\b/i },
  { label: 'Cadista', re: /\bcadist[ao]s?\b/i },
  { label: 'Desenhista', re: /\bdesenhist[ao]s?\b/i },
  { label: 'Designer de Interiores', re: /designer de interiores|interior designer/i },
  { label: 'Paisagista', re: /\bpaisagist[ao]s?\b|landscape (architect|designer)/i },
  { label: 'Modelador BIM', re: /modelador[a]? (de |)bim|bim modeler/i },
  { label: 'Coordenador de Projetos', re: /coordenador[a]? de projetos?|coordenador[a]? bim|l[íi]der de projetos?/i },
  { label: 'Gerente de Projetos', re: /gerente de projetos?|gerente bim|project manager/i },
  { label: 'Analista', re: /\banalista\b/i },
  { label: 'Assistente / Auxiliar', re: /\bassistente\b|\bauxiliar\b/i },
  { label: 'Estagiário', re: /est[áa]gi[áo]|\btrainee\b|aprendiz/i },
  { label: 'Técnico em Edificações', re: /t[ée]cnic[oa] (em |de |)edifica[çc][õo]es|t[ée]cnic[oa] em constru[çc][ãa]o/i },
  { label: 'Orçamentista', re: /or[çc]amentist[ao]|analista de or[çc]amentos?/i },
  { label: 'Consultor / Especialista', re: /\bconsultor[a]?\b|\bespecialista\b/i },
  { label: 'Fiscal / Mestre de Obras', re: /fiscal de obras?|mestre de obras?|encarregad[oa] de obras?/i },
];

// ESCOPO — o que a vaga pede/faz (título + descrição).
const SCOPE = [
  { label: 'Projeto arquitetônico', re: /projeto arquitet[ôo]nico|anteprojeto|estudo preliminar|estudo de massa|concep[çc][ãa]o arquitet[ôo]nica/i },
  { label: 'Projeto executivo', re: /projeto executivo|detalhamento (de |)(arquitet[ôo]nico|projetos?|construtivo)|caderno de (especifica[çc][õo]es|detalhes)|projeto para produ[çc][ãa]o/i },
  { label: 'Projeto legal / aprovação', re: /projeto legal|aprova[çc][ãa]o de (projetos?|plantas?)|projeto (de prefeitura|aprovado na prefeitura|para aprova[çc][ãa]o)/i },
  { label: 'Legalização / regularização', re: /legaliza[çc][ãa]o (de |)(im[óo]ve|obras?|edifica)|regulariza[çc][ãa]o (de |)(im[óo]ve|predial|edil|obras?|fundi[áa]ria)|\breurb\b|anistia (de obras?|edil)/i },
  { label: 'Licenciamento', re: /licenciamento (urban[íi]stico|edil[íi]cio|ambiental|de obras?)|licen[çc]a ambiental/i },
  { label: 'Habite-se / alvará / AVCB', re: /habite-?se|alvar[áa] de (constru|reforma|demoli|execu)|\bavcb\b|\bclcb\b|\bppci\b|auto de conclus[ãa]o/i },
  { label: 'Compatibilização', re: /compatibiliza[çc][ãa]o de projetos?|clash detection|federa[çc][ãa]o de modelos/i },
  { label: 'Levantamento / as built', re: /\bas ?built\b|levantamento (cadastral|arquitet[ôo]nico|m[ée]trico)|medi[çc][ãa]o em campo/i },
  { label: 'Acompanhamento de obra', re: /acompanhamento (de |t[ée]cnico de )obra|arquitet[oa] residente|fiscaliza[çc][ãa]o de obra|gerenciamento de obras?|\bcanteiro de obras?\b/i },
  { label: 'Orçamento / quantitativos', re: /or[çc]amento de obras?|levantamento de quantitativos?|composi[çc][ãa]o de custos/i },
  { label: 'Laudo / perícia / vistoria', re: /\blaudo\b|per[íi]cia|vistoria (cautelar|t[ée]cnica|predial)|inspe[çc][ãa]o predial|\bnbr ?1465/i },
  { label: 'Avaliação de imóveis', re: /avalia[çc][ãa]o (de |)im[óo]ve|avalia[çc][ãa]o patrimonial/i },
  { label: 'Restauro / retrofit', re: /restauro|restaura[çc][ãa]o (arquitet|de edif|do patrim)|\bretrofit\b|patrim[ôo]nio (hist[óo]rico|edificado)/i },
  { label: 'Sustentabilidade / LEED', re: /\bleed\b|aqua-?hqe|\bgbc\b|selo casa azul|\bedge\b|arquitetura sustent[áa]vel|efici[êe]ncia energ[ée]tica|\bnbr ?15575\b/i },
  { label: 'Maquete / renderização', re: /maquete (eletr[ôo]nica|f[íi]sica|3d)|maquetaria|renderiza[çc][ãa]o|imagens? (3d|fotorrealista)/i },
  { label: 'Interiores', re: /projeto de interiores|ambienta[çc][ãa]o|design de interiores|marcenaria|m[óo]veis planejados/i },
  { label: 'Paisagismo', re: /projeto paisag[íi]stico|paisagismo|arquitetura da paisagem/i },
  { label: 'Planejamento urbano', re: /plano diretor|planejamento (urbano|territorial)|desenho urbano|opera[çc][ãa]o urbana|mobilidade urbana/i },
  { label: 'Loteamento / parcelamento', re: /\bloteamento\b|parcelamento do solo|desmembramento|desdobro/i },
  { label: 'HIS / habitação social', re: /habita[çc][ãa]o de interesse social|\bHIS\b|regulariza[çc][ãa]o fundi[áa]ria/ },
  { label: 'Due diligence / georreferenciamento', re: /due diligence (imobili|de im[óo]ve)|georreferenciamento/i },
];

// PROGRAMA — só os que o usuário pediu (AutoCAD, SketchUp, ArchiCAD, Revit) + BIM.
const TOOLS = [
  { label: 'AutoCAD', re: /\bauto ?cad\b/i },
  { label: 'SketchUp', re: /\bsketch ?up\b/i },
  { label: 'ArchiCAD', re: /\barchi ?cad\b/i },
  { label: 'Revit', re: /\brevit\b/i },
  { label: 'BIM', re: /\bbim\b|building information model/i },
];

module.exports = { SEGMENTS: ORDERED, EXCLUDE, PRIORITY, ADJACENT, OUTROS, FILTER_SEGMENTS, ROLES, SCOPE, TOOLS };
