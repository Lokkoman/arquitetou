# Publicar o Arquitetou — checklist

Site 100% grátis: GitHub Actions roda os coletores + IA e publica `site/public/` no
GitHub Pages. Sem servidor, sem domínio. Resultado: uma URL tipo
`https://SEU-USUARIO.github.io/arquitetou`.

Faça na ordem. Os passos marcados **(opcional)** podem ficar pra depois — o site funciona
sem eles.

---

## 1. Subir o código pro GitHub

O repositório local já está inicializado e commitado (branch `main`). Crie um
repositório **público** vazio em <https://github.com/new> chamado `arquitetou`
(sem README/.gitignore/license) e conecte:

```bash
git remote add origin https://github.com/SEU-USUARIO/arquitetou.git
git push -u origin main
```

> Se estiver começando de um clone limpo, antes disso: `git init && git add . && git commit -m "primeira versão" && git branch -M main`.

## 2. Ligar o GitHub Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

## 3. Dar permissão de escrita ao robô

**Settings → Actions → General → Workflow permissions → Read and write permissions** → Save.

(É o que deixa o robô salvar o cache da classificação e a fila de candidatos entre as
rodadas. Sem isso o site ainda publica, mas reclassifica tudo toda vez.)

## 4. (Opcional) Ligar a classificação por IA

Sem isso o site funciona igual, só sem resumo / ferramentas / faixa salarial, sem o
filtro que remove "projetista mecânico" e afins, e sem a **descoberta automática de
escritórios novos** (a verificação dos que já estão no diretório continua).

A classificação usa o **Google Gemini** (grátis, sem cartão):

1. <https://aistudio.google.com/apikey> → login com conta Google → **Create API key**
   (gratuito; free tier ~1.500 req/dia, com Google Search pra descoberta).
2. **Settings → Secrets and variables → Actions → New repository secret**
   - Nome: `GEMINI_API_KEY` · Valor: a chave (`AIza…`)
3. (Opcional) aba **Variables**: `GEMINI_MODEL` (padrão `gemini-flash-lite-latest`, alias
   que o Google mantém no flash-lite atual do free tier) · `DISCOVER_GEMINI_MODEL` idem.

**Custo:** só as vagas NOVAS de cada rodada passam pelo modelo, com teto de ~200/rodada.
Gemini free tier → R$ 0.

## 5. (Opcional) Ligar o LinkedIn via Bright Data

Scraping roda na infra da Bright Data, sobre página pública, **sem usar sua conta do
LinkedIn**. Free tier: **5.000 créditos/mês, sem cartão** (1 crédito = 1 registro; não
acumulam; quando acabam, para — não cobra, a menos que você deposite fundos).

1. Conta grátis em <https://brightdata.com/> (Google/e-mail).
2. **Scrapers → Scrapers Library → linkedin.com → "LinkedIn job listings information" →
   "Discover by keyword"**. O `dataset id` é **`gd_lpfll7v5hcqtkxl6l`** (mesmo id para
   "discover by url"; o código usa o modo *keyword*, com inputs estruturados
   `location/keyword/country/time_range` — não quebra quando o LinkedIn mexe na URL).
3. **Rode o scraper 1× na mão** nessa tela: ele já vem com inputs de exemplo → **"Run
   manually"**. Isso **provisiona o scraper na conta** — sem esse 1º run manual a API
   responde `HTTP 400 "Customer is not active"`. Espere o snapshot ficar `Ready`.
4. **Account settings → Users and API keys → API keys** → copie o token (ou gere um).
5. **Settings → Secrets and variables → Actions**:
   - *secret* `BRIGHTDATA_API_TOKEN` = o token
   - *variable* `BRIGHTDATA_JOBS_DATASET` = `gd_lpfll7v5hcqtkxl6l`
   - *variable* `BRIGHTDATA_POSTS_DATASET` — **deixe em branco por enquanto** (posts
     dobram o consumo de créditos; ligue depois se sobrar folga no mês).
6. Primeira carga: **Actions → "Atualizar vagas" → Run workflow →
   `linkedin = backfill`** (puxa ~30 dias, uma vez — teto de 320 créditos).
7. Depois o LinkedIn é puxado **1×/semana** (1ª rodada de segunda). Como faz mais de 24h
   desde a última, o coletor abre a janela pra "Past week" sozinho (`catchup`) e faz
   upsert dessa janela.

**Consumo (1 crédito = 1 registro):** um teste sem limite voltou **1.282 registros de 2
inputs** — por isso cada rodada é limitada por `limit_per_input` + `limit_multiple_results`
no `/trigger` (ver `WINDOWS` em `collector/linkedin-brightdata.js`). Config atual: 4 grupos
de palavra-chave × 2 localizações ("São Paulo, Brasil" — o raio de ~40 km cobre Osasco/
Guarulhos/Barueri/Taboão — + "Brasil" remoto) = 8 inputs. Com pull **1×/semana** (janela
"Past week", teto 700/rodada) o consumo fica ~**2.800/mês** no teto, folgado dentro dos
5.000 grátis. Estourar o teto só faz o coletor voltar a no-op, sem cobrança.

> Na 1ª rodada com token, o log mostra `campos do Bright Data: {...}`. O mapeamento em
> `normalizeJob` já cobre os campos atuais (`job_title`, `company_name`, `job_location`,
> `job_summary`, `job_posted_date`); se algum vier vazio, ajuste lá.

## 6. Rodar a primeira vez

1. **Actions → "Coletar fontes (largura total)" → Run workflow** — raspa as 7 fontes → `parts/`.
2. **Actions → "Atualizar vagas" → Run workflow** — junta os `parts/`, classifica e publica.

Em poucos minutos o site está no ar. Pegue a URL em **Settings → Pages** e mande pra quem quiser.

Depois roda sozinho. Brasília é UTC−3 o ano todo.

| BRT | Workflow | O que faz |
|---|---|---|
| 07/10/13/16/19/22 (de 3 em 3h) | **Atualizar vagas** | raspa as 7 fontes nativas (job por fonte, paralelo) → junta com retenção 90d → classifica as novas com o Gemini → escreve `data/*.json`, commita e publica. LinkedIn (Bright Data) só na 1ª rodada de **segunda**. |
| 04:00 | **Descobrir fontes novas** | Gemini + Google Search caça sites/escritórios novos (independente) |

**Layout ≠ dados.** Mudança de front-end (HTML/CSS/JS/ícone) dispara o **Publicar site**
(`publicar-site.yml`) — só sobe `site/public/` pro Pages, sem build nem scrape, em ~30s.
**Reprocessar fontes** é manual, pra re-rodar uma fonte específica na hora.

### Carga pesada inicial (1ª vez)

1. **Actions → "Atualizar vagas" → Run workflow → `linkedin = backfill`** — raspa as 7
   fontes + puxa ~30 dias do LinkedIn via Bright Data (uma vez).

Depois é só deixar o agendamento rodar: cada dia traz a janela nova, o `id` estável de
cada vaga faz upsert (nunca duplica) e a retenção de 90 dias segura o que sai das listas.

---

## Depois: como manter

| Quero… | Onde |
|---|---|
| adicionar/remover termo de busca | `lib/searchTerms.js` |
| adicionar/remover cidade | `lib/cities.js` (+ opção em `site/public/index.html`) |
| adicionar uma fonte nova | `npm run probe -- <url>`, depois `collector/sources/NOME.js` (ver README) |
| ver fontes candidatas | issue "🔎 Fila de fontes candidatas" ou `data/candidates.md` |
| mexer no visual | `site/public/{index.html,app.js,styles.css}` |
| trocar o modelo da IA | *variable* `GEMINI_MODEL` / `DISCOVER_GEMINI_MODEL` |
| forçar recoleta de uma fonte | Actions → "Reprocessar fontes" → `sources = <id>` |
| ajustar cadência de coleta | crons em `.github/workflows/{collect,deploy}.yml` |

## Rodar/testar na sua máquina

```bash
npm install
npm run build:local     # cache local, sem rede, sem IA
npm run serve           # http://localhost:3000
node site/build.js      # build de verdade (raspa a rede)
```
