// Enriquece cada vaga com o Gemini: relevância, senioridade, modalidade, ferramentas,
// faixa salarial e um resumo. Desambigua "arquitetura de software/dados" do que é
// arquitetura de verdade e extrai campos que só existem como texto solto.
//
// Best-effort: sem GEMINI_API_KEY devolve as vagas intactas; erro numa leva deixa
// aquelas vagas sem `ai`; vaga já com `ai` não reprocessa (cache no repo).
//
// Modelo: GEMINI_MODEL ou "gemini-flash-lite-latest" (o "*-latest" é alias auto-atualizado
// do Google). O free tier limita req/min e req/dia: no máximo CLASSIFY_MAX_PER_RUN vagas
// novas por rodada, e a passada para após 3 estouros de cota seguidos.

const { stripHtml } = require('./keywords');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const MODEL = GEMINI_MODEL;
const HAS_KEY = Boolean(process.env.GEMINI_API_KEY);
// 12 vagas/chamada: menos requisições, e cabe folgado na resposta.
const BATCH_SIZE = Number(process.env.CLASSIFY_BATCH_SIZE) || 12;
// Teto de vagas NOVAS classificadas por rodada. ~200/dia deixa margem pro discover.yml.
const MAX_PER_RUN = Number(process.env.CLASSIFY_MAX_PER_RUN) || 200;
const DESC_CHARS = 1200;

// Uma chamada ao Gemini: (system, texto do usuário) -> texto da resposta.
async function llmComplete(system, userText, { maxTokens = 2048 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

const SYSTEM = `Você classifica vagas de emprego para um agregador focado em ARQUITETURA E URBANISMO no Brasil.

O que INTERESSA: arquiteto(a) e urbanista, projetista de arquitetura, paisagismo, BIM/Revit/ArchiCAD/SketchUp/AutoCAD aplicado a edificações, maquete, e a especialidade de regularização/legalização/licenciamento/aprovação de projetos de imóveis e obras (habite-se, AVCB, alvará de construção, due diligence imobiliária, georreferenciamento, usucapião, parcelamento do solo, REURB, estudo de impacto de vizinhança).

O que NÃO interessa (responda "nao"): arquitetura de software/soluções/dados/nuvem/sistemas, TI em geral, DevOps, SAP/Oracle/ERP, legalização/regularização de EMPRESAS (contábil/societário), licenciamento de software/marca/veículos, engenharia mecânica/de produto (SolidWorks).

Para cada vaga da lista, devolva um objeto JSON com:
- "i": o índice recebido (número)
- "relevante": "sim" | "nao" | "talvez"
- "motivo": frase curta explicando a classificação
- "senioridade": "estagio" | "junior" | "pleno" | "senior" | "coordenacao" | "nao_informado"
- "modalidade": "remoto" | "hibrido" | "presencial" | "nao_informado"
- "ferramentas": array de strings (ex.: ["Revit","AutoCAD","aprovação de projetos"]); [] se não citar nenhuma
- "salario": string curta com a faixa (ex.: "R$ 4.000–6.000") ou null se não informado
- "resumo": UMA frase (máx. ~160 caracteres) descrevendo a vaga

Responda APENAS com um array JSON, sem texto fora dele, sem cercas de código.`;

function jobToPromptItem(job, i) {
  const desc = stripHtml(job.description || job.descriptionSnippet || '').slice(0, DESC_CHARS);
  return {
    i,
    titulo: job.title || '',
    empresa: job.company || '',
    local: job.location || job.cityLabel || '',
    descricao: desc,
  };
}

function parseModelJson(text) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('sem array JSON na resposta');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const MODALITY_TO_WORKPLACE = { remoto: 'remote', hibrido: 'hybrid', presencial: 'on-site' };
const VALID_SENIORITY = new Set(['estagio', 'junior', 'pleno', 'senior', 'coordenacao', 'nao_informado']);

function applyEnrichment(job, ai) {
  const tools = Array.isArray(ai.ferramentas)
    ? ai.ferramentas.filter((t) => typeof t === 'string' && t.trim()).slice(0, 8)
    : [];
  job.ai = {
    relevant: ai.relevante === 'sim' || ai.relevante === 'nao' || ai.relevante === 'talvez' ? ai.relevante : 'talvez',
    reason: typeof ai.motivo === 'string' ? ai.motivo.slice(0, 240) : '',
    seniority: VALID_SENIORITY.has(ai.senioridade) ? ai.senioridade : 'nao_informado',
    modality: MODALITY_TO_WORKPLACE[ai.modalidade] || null,
    tools,
    salary: typeof ai.salario === 'string' && ai.salario.trim() ? ai.salario.trim() : null,
    summary: typeof ai.resumo === 'string' ? ai.resumo.slice(0, 200) : '',
    model: MODEL,
    at: new Date().toISOString(),
  };
  // A IA preenche o que o regex não conseguiu, sem sobrescrever fonte estruturada.
  if (job.seniority === 'nao_informado' && job.ai.seniority !== 'nao_informado') {
    job.seniority = job.ai.seniority;
  }
  if (!job.workplaceType && job.ai.modality) {
    job.workplaceType = job.ai.modality;
  }
  return job;
}

async function classifyBatch(batch) {
  const items = batch.map((job, k) => jobToPromptItem(job, k));
  const text = await llmComplete(SYSTEM, JSON.stringify(items, null, 2), { maxTokens: 4096 });
  const parsed = parseModelJson(text);
  const byIndex = new Map(parsed.map((o) => [o.i, o]));
  for (let k = 0; k < batch.length; k += 1) {
    const ai = byIndex.get(k);
    if (ai) applyEnrichment(batch[k], ai);
  }
}

/**
 * Enriquece as vagas in-place (adiciona `job.ai`) e retorna
 * { jobs, enriched, dropped, skipped, ok, note }. `jobs` já vem sem as que a IA marcou
 * como irrelevantes; vagas sem `ai` são sempre mantidas.
 */
async function enrichJobs(jobs, { onProgress } = {}) {
  if (!HAS_KEY) {
    return {
      jobs,
      enriched: 0,
      dropped: 0,
      skipped: 0,
      ok: true,
      note: 'Sem GEMINI_API_KEY — vagas mantidas sem enriquecimento.',
    };
  }

  const allPending = jobs.filter((j) => !j.ai);
  // Só as N mais recentes nesta rodada; o resto pega `ai` nas próximas.
  const pending = allPending
    .slice()
    .sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || ''))
    .slice(0, MAX_PER_RUN);
  const deferred = allPending.length - pending.length;
  let enriched = 0;
  let failed = 0;
  let quotaHit = false;

  // Gemini free tier limita req/min -> pausa entre levas.
  const gap = 4500;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let strikes = 0; // estouros de cota seguidos
  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const batch = pending.slice(start, start + BATCH_SIZE);
    try {
      await classifyBatch(batch);
      enriched += batch.filter((j) => j.ai).length;
      strikes = 0;
    } catch (err) {
      failed += batch.length;
      console.error(`[classify] leva ${start / BATCH_SIZE + 1} falhou: ${err.message}`);
      if (/HTTP 429|rate|quota|RESOURCE_EXHAUSTED/i.test(err.message)) {
        quotaHit = true;
        strikes += 1;
        if (strikes >= 3) {
          console.error(`[classify] 3 estouros de cota seguidos — parando (${pending.length - start - batch.length} vaga(s) ficam pra próxima rodada)`);
          failed += pending.length - start - batch.length;
          break;
        }
        console.error('[classify] rate limit — pausando 30s');
        await sleep(30000);
      }
    }
    if (onProgress) onProgress(Math.min(start + BATCH_SIZE, pending.length), pending.length);
    if (gap && start + BATCH_SIZE < pending.length) await sleep(gap);
  }

  const kept = jobs.filter((j) => !(j.ai && j.ai.relevant === 'nao'));
  const dropped = jobs.length - kept.length;

  const notes = [];
  if (failed) notes.push(`${failed} vaga(s) sem classificação nesta rodada${quotaHit ? ' (cota do Gemini)' : ''}`);
  if (deferred) notes.push(`${deferred} adiada(s) pelo teto de ${MAX_PER_RUN}/rodada`);

  return {
    jobs: kept,
    enriched,
    dropped,
    skipped: jobs.length - allPending.length,
    ok: failed === 0,
    note: notes.length ? notes.join('; ') + ' — serão classificadas nas próximas rodadas.' : null,
  };
}

module.exports = { enrichJobs, MODEL };
