# Arquitetou

> Agregador de vagas de arquitetura, urbanismo e licenciamento — Grande São Paulo + remoto (Brasil).

Agregador de vagas de **arquitetura e urbanismo** — incluindo **licenciamento /
regularização** e vagas de **AutoCAD / Revit / SketchUp / ArchiCAD** — em **São Paulo,
Osasco, Taboão da Serra, Guarulhos e Barueri**, e **qualquer cidade do Brasil quando a
vaga é 100% remota**.

**Como os dados chegam:**

- **Extração via API** onde a fonte oferece: Gupy (endpoint JSON público) e LinkedIn
  (Bright Data Web Scraper API, sobre página pública, sem usar conta do LinkedIn). O BNE
  lê um JSON embutido na própria página. As demais (Catho, InfoJobs, Vagas.com,
  Empregos.com.br, LinkedIn nativo) são scraping HTML com `cheerio`.
- **Análise por IA** ([`lib/classify.js`](lib/classify.js)): cada vaga nova passa pelo
  Gemini (`gemini-flash-lite-latest`), que devolve relevância, senioridade, modalidade,
  ferramentas citadas, faixa salarial e um resumo de uma linha, e descarta o que não é
  arquitetura (o que o filtro por regex deixa passar). Best-effort: sem a chave, o site
  funciona igual, só sem esses campos.
- **Sem servidor**: o GitHub Actions roda coleta e IA em cron, grava os JSON e publica
  `site/public/` no GitHub Pages. Sem custo de hospedagem.

**Para publicar (passo a passo): [`DEPLOY.md`](DEPLOY.md).**

---

## Como funciona

```
GitHub Actions (cron, grátis)                       GitHub Pages (grátis)
──────────────────────────────                      ─────────────────────
collect.yml "Atualizar vagas" — de 3 em 3h         site estático:
   (07/10/13/16/19/22 BRT):              ──▶          site/public/  lê data/*.json
   raspa Gupy, Vagas.com, InfoJobs, BNE,              filtros, "meu perfil",
   Catho, Empregos.com.br, LinkedIn nativo            tipos de vaga, remoto
   (cada fonte no seu job) -> parts/
   -> junta parts + retenção 90d
   -> lib/classify: Gemini nas vagas novas
   -> site/build: escreve data/*.json -> publica
   (LinkedIn via Bright Data: só 1×/semana)

publicar-site.yml — em push no front-end:
  só sobe site/public/ pro Pages (~30s, sem build)

discover.yml — 07:00 UTC:
  tools/discover  Gemini + web search acha fontes novas
  tools/probe     valida cada candidato
```

- **Coleta**: só requisições HTTP — grátis.
- **Classificação por IA** ([`lib/classify.js`](lib/classify.js)): opcional. Com
  `GEMINI_API_KEY` (grátis: aistudio.google.com), cada vaga nova passa pelo Gemini, que
  devolve senioridade, modalidade, ferramentas citadas, faixa salarial e um resumo — e
  descarta o que não é arquitetura (o que o filtro de regex erra). Só as vagas **novas**
  de cada rodada são classificadas, com teto por rodada e respeito à cota (as demais
  ficam em cache no repo); sem a chave, o site funciona igual, só sem esses campos.
- **LinkedIn** ([`collector/linkedin-brightdata.js`](collector/linkedin-brightdata.js)):
  via API pública da Bright Data (infra deles, sobre página pública, **sem usar sua conta
  do LinkedIn**). Free tier 5.000 registros/mês. Backfill único de 30 dias + pull diário
  incremental de 48h com upsert. Sem o token, o LinkedIn fica de fora.

## Fontes e cobertura

Matriz completa **segmento × fonte** em [`COBERTURA.md`](COBERTURA.md). Fontes com coleta:
Gupy (API JSON), Vagas.com, InfoJobs, BNE, Catho, Empregos.com.br (HTML), LinkedIn (nativo + Bright Data).
Indeed só como link direto.

- **12 segmentos** de vaga (Licenciamento & Regularização, Restauro, Perícia & Avaliação,
  Sustentabilidade, BIM, Paisagismo, Interiores, Obra, Visualização 3D, Urbanismo,
  Arquitetura, CAD/Projetista) — cada um com poucos termos-cabeça para a busca + uma lista
  exaustiva de padrões para reconhecer/rotular. Tudo em
  [`lib/segments.js`](lib/segments.js) — ajuste lá e busca, filtro do site e badges
  acompanham.
- Lista canônica de cidades: [`lib/cities.js`](lib/cities.js).
- Regra de localização: vaga em cidade-alvo → entra com a cidade; vaga em qualquer outra
  cidade do Brasil → só entra se for **remota** (aparece como "Cidade (remoto)"); vaga
  presencial fora das cidades-alvo → descartada.

## Estrutura do projeto

```
lib/                código compartilhado, sem I/O de servidor
  keywords.js         filtro de palavra-chave (inclui/exclui TI), senioridade, cidade, datas
  cities.js           cidades-alvo (nome, slug, formato por site)
  searchTerms.js      termos de busca canônicos (core / head / stems p/ Gupy / keywords Bright Data)
  segments.js         os 12 segmentos de vaga: termos-cabeça + padrões de rótulo/badge
  classify.js         enriquecimento de cada vaga via Gemini (opcional, degrada sem a chave)
collector/
  index.js            refreshAll() — orquestra os coletores (build nativo completo)
  run-source.js       roda UMA fonte -> site/public/data/parts/<id>.json (usado pelo collect.yml)
  db.js               leitura/escrita de data/jobs.json e data/sources-status.json
  deeplinks.js        gera os links diretos de LinkedIn/Indeed/Catho
  linkedin-brightdata.js   LinkedIn (vagas + posts) via Bright Data
  sources/
    gupy.js  vagasCom.js  infoJobs.js  bne.js  linkedin.js  catho.js
site/
  build.js            gera site/public/data/*.json (scrape → classify → JSON)
  public/             front-end estático (HTML/CSS/JS puro) + data/ (gerado)
tools/
  probe.js            valida uma URL de site de vagas (acessível? tem dados? bloqueado?)
  discover.js         descobre fontes novas (Gemini + web search) e roda o probe
  health.js           diagnóstico da coleta: health.json + history.jsonl, lista needsReprocess
data/
  firms.json          diretório curado de escritórios/incorporadoras
  candidates.json / .md   fila de fontes candidatas (gerado pelo discover)
  discover-seeds.txt  URLs extras pro discover testar
  jobs.json / sources-status.json   cache local (gerado; fora do git)
.github/workflows/
  collect.yml           "Atualizar vagas": ciclo de dados a cada 3h — raspa as 7 fontes
                        (job por fonte) + junta + classifica + publica. LinkedIn 1×/semana.
  publicar-site.yml     em push no front-end (layout): só sobe site/public/ pro Pages, ~30s
  reprocess.yml         manual: re-roda uma fonte específica (ou "auto" via health.json)
  discover.yml          07:00 UTC descoberta de fontes
  cleanup-runs.yml      domingo 03:00 UTC apaga runs antigos das Actions
```

## Rodar localmente

```bash
npm install
npm run build:local     # usa o cache data/jobs.json, sem rede, sem IA
npm run serve           # abre http://localhost:3000 servindo site/public
```

Build de verdade (raspa a rede; classifica se `GEMINI_API_KEY` estiver setada):

```bash
node site/build.js
```

Testar uma fonte candidata:

```bash
npm run probe -- https://algum-site-de-vagas.com.br/vagas/arquiteto
```

## Adicionar uma fonte nova

1. Rode o `probe` na URL de listagem. Se o veredito for `estruturado` ou `html`, vale a
   pena.
2. Crie `collector/sources/NOME.js` seguindo o padrão dos existentes: exporte
   `{ collect, id, name }`, use os helpers de [`lib/keywords.js`](lib/keywords.js)
   (`matchArchitectureKeyword`, `resolveCityOrRemote`, `detectSeniority`…) e os termos de
   [`lib/searchTerms.js`](lib/searchTerms.js).
3. Registre em `COLLECTORS` no [`collector/index.js`](collector/index.js).
4. Rode `node -e "require('./collector/sources/NOME').collect().then(r=>console.log(r.jobs.length, r.errors))"` e confira.
5. Marque o candidato como `"adopted": true` em `data/candidates.json`.
