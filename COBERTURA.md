# Arquitetou · Cobertura — tipos de vaga × fontes

Revisão 2026-08-27. Fonte da verdade: [`lib/segments.js`](lib/segments.js) (segmentos +
termos + classificador) · [`lib/cities.js`](lib/cities.js) (cidades).

## Segmentos de vaga (12) — viram o filtro "Tipo de vaga" no site

Cada segmento tem: **poucos termos-cabeça** para a busca + uma **lista exaustiva** de
padrões (`match`) que reconhece e rotula qualquer vaga que voltar de qualquer fonte.
Ordem = prioridade de classificação (campo específico antes de "Arquitetura & Projeto";
CAD por último, só pega "Projetista/Cadista" puro).

| # | Segmento | Cobre (exemplos) |
|---|---|---|
| 1 | **Licenciamento & Regularização** | regularização (imóveis/predial/edilícia/fundiária), REURB, legalização de obras, anistia, averbação, desmembramento/desdobro, retificação de área/matrícula, usucapião, aprovação de projetos, projeto legal, consulta de viabilidade, licenciamento urbanístico/ambiental, alvará (construção/reforma/demolição/funcionamento), habite-se/CCO, AVCB/CLCB, PPCI/projeto de incêndio, EIA-RIMA/EIV/outorga, georreferenciamento, levantamento/as built, due diligence imobiliária, parcelamento do solo, cargos (analista/coordenador de regularização/aprovação) |
| 2 | **Restauro & Patrimônio** | restauro arquitetônico, patrimônio histórico/edificado, IPHAN/CONDEPHAAT/CONPRESP, retrofit, conservação |
| 3 | **Perícia & Avaliação de Imóveis** | avaliação de imóveis, NBR 14653, laudo pericial/de vistoria/técnico, perícia de engenharia, acessibilidade/NBR 9050, assistência técnica pericial |
| 4 | **Sustentabilidade & Certificações** | LEED, AQUA-HQE, GBC, Selo Casa Azul, EDGE, arquitetura/construção sustentável, eficiência energética, NBR 15575, conforto ambiental/térmico/acústico, bioclimático |
| 5 | **BIM & Compatibilização** | BIM, coordenador/gerente/modelador BIM, compatibilização de projetos, clash detection, Navisworks |
| 6 | **Paisagismo** | paisagismo, paisagista, projeto paisagístico, arquitetura da paisagem, landscape design |
| 7 | **Interiores** | arquitetura/design/projeto de interiores, ambientação de espaços |
| 8 | **Obra & Acompanhamento** | arquiteto de obra/residente, acompanhamento/fiscalização/gerenciamento/coordenação de obra, canteiro, as built |
| 9 | **Visualização 3D & Maquete** | maquete eletrônica/física, renderização, Lumion, V-Ray, Enscape, Corona, Twinmotion, 3ds Max, Cinema 4D, artista 3D |
| 10 | **Urbanismo & Planejamento** | urbanismo/urbanista, planejamento urbano/territorial/metropolitano, plano diretor, desenho urbano, operação urbana, mobilidade urbana, loteamento, gestão/política urbana, HIS |
| 11 | **Arquitetura & Projeto** | arquiteto(a)/arquitetura, projeto arquitetônico, anteprojeto, estudo preliminar/de massa |
| 12 | **CAD, Projetista & Detalhamento** | projetista, cadista, desenhista projetista, AutoCAD, ArchiCAD, SketchUp, Revit, projeto executivo, detalhamento, caderno de especificações |

Filtro de precisão comum a tudo (`EXCLUDE`): arquitetura de software/dados/nuvem, TI,
DevOps, SAP/Oracle/ERP, legalização/regularização **de empresas** (contábil/societário),
licenciamento de software/marca/veículo, projetista/desenhista de outras engenharias
(elétrico/mecânico/hidráulico/móveis/produto), games (Unity/Unreal/VFX), SolidWorks. Com
`GEMINI_API_KEY`, o classificador (Gemini) faz um 2º passe.

**Multi-tag:** cada vaga carrega **todos os segmentos que toca** (não um só) — "Arquiteto
de Interiores" aparece em *Interiores* **e** em *Arquitetura & Projeto*. O badge mostra
o(s) mais específico(s).

**Rede de segurança:** título com cara de arquitetura (`ADJACENT`: arquitet, urban,
edifíc, imóvel, predial, habite-se, alvará, BIM, AutoCAD…) que não bate no `EXCLUDE` mas
nenhum segmento reconheceu → **mantido** no balde **"Outras / a revisar"** em vez de
descartado. Recall > precisão; o LLM/pessoa refina depois.

## Regra de localização (aplicada em TODA fonte com coleta — `resolveCityOrRemote`)

| Situação | Resultado |
|---|---|
| Cidade-alvo (**São Paulo, Osasco, Taboão da Serra, Guarulhos, Barueri**) | entra com a cidade |
| **Qualquer outra cidade do Brasil + vaga remota** | entra como "Cidade (remoto)" / "Remoto (Brasil todo)" |
| Outra cidade do Brasil + **presencial** | descartada |
| País estrangeiro explícito (EUA, Portugal, etc.) | descartada |

## Como cada fonte busca + o critério de cidade/remoto

Estratégia: **classificador exaustivo** (`lib/segments.js`) que reconhece qualquer
variação de escrita + busca ampla, calibrada por fonte conforme a tolerância de cada
site a volume (fontes que tomam bloqueio fazem fan-out por cidade só nos 12 termos-cabeça
e reservam a lista completa para a passada nacional). Cada fonte roda no seu próprio
workflow (`.github/workflows/collect.yml`, `collector/run-source.js` →
`site/public/data/parts/`, 07:00 UTC); a publicação diária do `deploy.yml` (08:50 UTC,
pronta até 07:00 BRT) junta os `parts/` + retenção de 90d. Diagnóstico e re-tentativa:
seção "Diagnóstico e reprocessamento".

| Fonte | Coleta | Como busca | Cidades-alvo | Remoto (qualquer cidade BR) | Posts LinkedIn |
|---|---|---|---|---|:--:|
| **Gupy** | API JSON | 33 radicais (por cidade + nacional) | `city=` × 5 cidades | passada nacional + flag `isRemoteWork` | — |
| **Vagas.com** | HTML | 12 termos-cabeça por cidade + lista completa (~152) na passada "100% Home Office"; disjuntor após 12×HTTP 429 | `/vagas-de-{termo}-em-{cidade}` × 5 | passada `?m[]=100% Home Office` | — |
| **InfoJobs** | HTML | arquiteto/arquitetura/urbanismo como categoria (2 pg) + todo o resto via busca livre `?palabra=` (2 pg) | filtro pelo texto de localização de cada vaga | páginas `-home-office` (núcleo) + detecção de "remoto" no texto (resto) | — |
| **BNE** | HTML + JSON | 12 termos-cabeça por cidade + lista completa (~152) na passada nacional; disjuntor após 20 erros seguidos | `/vagas-de-emprego-para-{termo}-em-{cidade}-sp` × 5 | passada nacional + flag `Home_Office` | — |
| **LinkedIn — vagas** | HTML público + (Bright Data) | 11 consultas combinadas (cobrem os 12 segmentos), por cidade + passada remota `f_WT=2` para cada grupo | `location=` × 5 cidades | `f_WT=2`, `location=Brasil`, por grupo | ❌ nativo só vagas |
| **LinkedIn — posts** | Bright Data (API) | 3 grupos de palavra-chave em `/search/results/content/` | filtro pelo texto do post | idem | ✅ **requer `BRIGHTDATA_API_TOKEN`** |
| **Indeed** | só link direto | 3 variações (arq / licenciamento / CAD) por cidade | `l=` × cidade | variação "Remoto (Brasil todo)" | — |
| **Catho** | HTML | 7 slugs de cargo (arquiteto, urbanista, interiores, projetista, paisagista…) × 5 cidades + home office | `/vagas/{cargo}/{cidade}/` × 5 | `/vagas/{cargo}/home-office/` | — |

## Matriz segmento × fonte

Toda fonte com coleta busca o termo-cabeça de **todos os 12 segmentos** e o classificador
exaustivo reconhece qualquer variação. Portanto:

| | Gupy | Vagas.com | InfoJobs | BNE | Catho | LinkedIn vagas | LinkedIn posts ² | Indeed ¹ |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Os 12 segmentos** (Licenciamento, Restauro, Perícia, Sustentabilidade, BIM, Paisagismo, Interiores, Obra, Viz 3D, Urbanismo, Arquitetura, CAD) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| **Cidades-alvo** (SP · Osasco · Taboão · Guarulhos · Barueri) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Remoto de qualquer cidade do Brasil** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

¹ **Indeed** — só link de busca pronto (bloqueia scraping). ⚠️ = link cobre 3 variações
(arq / licenciamento / CAD).
² **LinkedIn — posts** — só via Bright Data; sem `BRIGHTDATA_API_TOKEN`, zero posts (o
nativo pega só as vagas de `/jobs/search/`).

## Lacunas fechadas

| Lacuna | Correção |
|---|---|
| Gupy: fan-out por cidade só com o núcleo | fan-out por cidade usa todos os 33 radicais + passada nacional |
| Vagas.com: fan-out completo por cidade derrubava a fonte (HTTP 429 em série, ~1 vaga/rodada no CI) | fan-out por cidade só nos 12 termos-cabeça + disjuntor de 429; lista completa fica na passada "100% Home Office" |
| BNE: fan-out completo por cidade = ~26 min/rodada (perto do teto de 6h) | fan-out por cidade só nos 12 termos-cabeça + disjuntor; lista completa na passada nacional |
| LinkedIn nativo: passada remota só buscava "arquitetura e urbanismo" | passada remota roda para cada um dos 11 grupos combinados |
| LinkedIn: bloqueio silencioso (HTTP 200 com página vazia) passava como "ok" | coletor conta cards/página + detecta authwall → vira `degraded`/`failed` no health |
| InfoJobs: busca livre marcava `isRemote=false` fixo | detecta remoto pelo texto (título + local + descrição) |
| Fonte que falha/cai de volume passava despercebida | `tools/health.js` grava `health.json` + `history.jsonl`, compara com a mediana e lista `needsReprocess` |
| Não havia como re-rodar só a fonte que falhou | `.github/workflows/reprocess.yml` (manual ou agendado, modo `auto` lê o `health.json`) |

## Diagnóstico e reprocessamento

Todo build grava dois arquivos em `site/public/data/` (via [`tools/health.js`](tools/health.js)):

| Arquivo | O que é |
|---|---|
| `history.jsonl` | 1 linha por fonte por rodada (janela de 40) — vira a linha de base (mediana) |
| `health.json` | retrato da última rodada: veredito por fonte + lista `needsReprocess` |

Vereditos: `ok` · `low` (rodou sem erro mas voltou ≥50% abaixo da mediana — bloqueio
"silencioso") · `degraded` (erro em ≥25% das consultas) · `failed` (0 vagas ou erro em
≥80%) · `unknown` (1ª vez). Alertas viram `::warning::` no resumo do Actions e uma
faixa no topo das notas do site.

**Reprocessar** ([`.github/workflows/reprocess.yml`](.github/workflows/reprocess.yml)):
manual, re-roda fontes específicas e regrava só o `parts/<id>.json` delas; o próximo ciclo
do "Atualizar vagas" junta o part fresco. (Não é mais agendado: o ciclo de 3h já re-raspa
sozinho a fonte que falhou.)

- *Actions → Reprocessar fontes → Run workflow* → `sources = vagas-com,linkedin` (ou `auto`
  p/ ler `health.json`).
- Localmente: `node collector/run-source.js vagas-com` (sai 1 e não sobrescreve o part se
  vier 0 vaga — a retenção de 90 dias cobre).

## Pendências (não é lacuna de lógica — é config)

- **`collect.yml` "Atualizar vagas"**: ciclo de dados a cada 3h — job por fonte (paralelo)
  → junta `parts/` + retenção 90d → classifica → publica. LinkedIn (Bright Data) só 1×/semana.
- **Posts do LinkedIn**: só o coletor Bright Data pega posts (`/search/results/content/`
  exige login; o nativo só lê `/jobs/search/`). Enquanto `BRIGHTDATA_API_TOKEN` não
  estiver configurado, **nenhum post é coletado** — só vagas do LinkedIn (via nativo).
- **Volume no CI**: o IP de datacenter do GitHub derruba **Vagas.com** (HTTP 429 em série
  — agora com disjuntor: fan-out por cidade só nos termos-cabeça + aborta após 12×429) e
  reduz InfoJobs (~½) e LinkedIn nativo (~½, sem paginar além da 1ª página + janela de 30
  dias + só 8 descrições/rodada). O LinkedIn se recupera 100% com o Bright Data; o resto é
  suavizado pela retenção de 90 dias e pelas re-raspagens a cada 3h.
- **LinkedIn — bloqueio silencioso**: o coletor conta cards/página e detecta authwall;
  se a média cair para <2 cards/página ou 0 cards em 200, registra erro (vira `degraded`/
  `failed` no health).
- **BNE**: lento (fan-out por cidade reduzido p/ termos-cabeça; nacional completo;
  disjuntor após 20 erros seguidos). Slug exótico sem página de categoria cai em erro
  logado — a cobertura real desses termos raros vem de Gupy, InfoJobs e LinkedIn.
