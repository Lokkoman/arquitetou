// Diagnóstico de coleta — identifica fonte que FALHOU, CAIU de volume ou está degradada.
//
// Gera dois arquivos em site/public/data/ (ambos versionados, lidos pelo front e pelo
// workflow de reprocessamento):
//
//   health.json     retrato da última rodada: veredito por fonte + lista `needsReprocess`
//   history.jsonl   1 linha por fonte por rodada (janela deslizante) — vira a "linha de
//                   base" (mediana) contra a qual a rodada seguinte é comparada
//
// Vereditos por fonte:
//   ok        volume normal, poucos erros
//   low       rodou sem erro, mas voltou bem abaixo da mediana histórica (possível
//             bloqueio "silencioso": HTTP 200 com página vazia/reduzida)
//   degraded  erro numa fração relevante das consultas (>= 25%) OU queda + erros
//   failed    0 vagas, ou erro em quase todas as consultas (>= 80%)
//   unknown   primeira vez que vemos a fonte (sem base p/ comparar)
//
// Nada aqui derruba o build: é só sinal. O reprocessamento é disparado à parte
// (.github/workflows/reprocess.yml lê `needsReprocess`).

const fs = require('fs');
const path = require('path');

const PUBLIC_DATA = path.join(__dirname, '..', 'site', 'public', 'data');
const HISTORY_FILE = path.join(PUBLIC_DATA, 'history.jsonl');
const HEALTH_FILE = path.join(PUBLIC_DATA, 'health.json');

const KEEP_PER_SOURCE = 40; // linhas de histórico mantidas por fonte
const BASELINE_N = 10; // rodadas usadas p/ a mediana
const DROP_THRESHOLD = 0.5; // queda >= 50% vs mediana => "low"
const DEGRADED_ERR_RATE = 0.25;
const FAILED_ERR_RATE = 0.8;
// Fonte de baixo volume (mediana < N): variação percentual não diz nada (6 -> 1 é
// "83% de queda" mas é só ruído). Nessas, só alerta se zerar de vez (verdict "failed").
const LOW_VOLUME_FLOOR = 15;

function readHistory() {
  try {
    return fs
      .readFileSync(HISTORY_FILE, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function median(nums) {
  const s = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function dominantError(sampleErrors) {
  const counts = {};
  for (const e of sampleErrors || []) {
    const k = (String(e).match(
      /HTTP \d{3}|ETIMEDOUT|ENOTFOUND|ECONNRESET|abort|timeout|429|500|503|403|authwall|bloqueio silencioso|truncando|disjuntor/i
    ) || ['outro'])[0];
    counts[k] = (counts[k] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function assessOne(id, cur, history) {
  const past = history.filter((h) => h.sourceId === id).slice(-BASELINE_N);
  const baselineMedian = median(past.map((h) => h.jobsFound));
  const queries = cur.queriesRun || 0;
  const rawRate = queries ? cur.errorCount / queries : cur.errorCount > 0 ? 1 : 0;
  const errorRate = Math.min(1, rawRate); // consultas com retry podem passar de 100%
  const drop = baselineMedian ? 1 - cur.jobsFound / baselineMedian : 0;
  const pct = Math.round(errorRate * 100);

  const reasons = [];
  let verdict = 'ok';

  if (cur.jobsFound === 0) {
    verdict = 'failed';
    reasons.push('0 vagas coletadas');
  } else if (errorRate >= FAILED_ERR_RATE) {
    verdict = 'failed';
    reasons.push(`erro em ${pct}% das consultas`);
  } else if (errorRate >= DEGRADED_ERR_RATE) {
    verdict = 'degraded';
    reasons.push(`erro em ${pct}% das consultas`);
  }

  if (baselineMedian != null) {
    if (drop >= DROP_THRESHOLD && baselineMedian >= LOW_VOLUME_FLOOR) {
      if (verdict === 'ok') verdict = 'low';
      reasons.push(`${Math.round(drop * 100)}% abaixo da mediana (${baselineMedian})`);
    } else if (drop >= DROP_THRESHOLD) {
      // queda grande em fonte pequena: registra, mas não vira alerta nem reprocesso
      reasons.push(`${Math.round(drop * 100)}% abaixo da mediana (${baselineMedian}) — fonte de baixo volume, sem alerta`);
    }
  } else if (verdict === 'ok') {
    verdict = 'unknown';
    reasons.push('sem histórico p/ comparar');
  }

  return {
    verdict,
    reasons,
    jobsFound: cur.jobsFound,
    baselineMedian,
    errorCount: cur.errorCount,
    queriesRun: queries || null,
    errorRate: Number(errorRate.toFixed(3)),
    dominantError: dominantError(cur.sampleErrors),
    durationMs: cur.durationMs || null,
    lastRunAt: cur.lastRunAt || null,
  };
}

// sourcesStatus: objeto { [id]: { jobsFound, errors, queriesRun, durationMs, lastRunAt } }
// ou { sources: {...} }. write:false => só devolve o retrato, não toca em disco (usado
// pelo run-source.js p/ uma fonte só).
function assessHealth(sourcesStatus, { write = true } = {}) {
  const map = sourcesStatus && sourcesStatus.sources ? sourcesStatus.sources : sourcesStatus || {};
  const history = readHistory();
  const ts = new Date().toISOString();

  const sources = {};
  const newLines = [];
  for (const [id, s] of Object.entries(map)) {
    if (!s) continue;
    const errs = s.errors || [];
    const cur = {
      jobsFound: s.jobsFound || 0,
      errorCount: errs.length,
      queriesRun: s.queriesRun || 0,
      durationMs: s.durationMs || null,
      lastRunAt: s.lastRunAt || ts,
      sampleErrors: errs.slice(0, 30),
    };
    const a = assessOne(id, cur, history);
    sources[id] = a;
    newLines.push({
      ts,
      sourceId: id,
      jobsFound: cur.jobsFound,
      errorCount: cur.errorCount,
      queriesRun: cur.queriesRun || null,
      durationMs: cur.durationMs,
      verdict: a.verdict,
    });
  }

  const bad = Object.entries(sources).filter(([, a]) => a.verdict !== 'ok' && a.verdict !== 'unknown');
  const alerts = bad.map(([id, a]) => `${id}: ${a.verdict.toUpperCase()} — ${a.reasons.join('; ')}`);
  const needsReprocess = bad
    .filter(([, a]) => ['failed', 'degraded', 'low'].includes(a.verdict))
    .map(([id]) => id);

  const health = { generatedAt: ts, ok: alerts.length === 0, alerts, needsReprocess, sources };

  if (write) {
    // Histórico: só as últimas KEEP_PER_SOURCE linhas por fonte, ordenado por tempo.
    const merged = [...history, ...newLines];
    const byId = {};
    for (const h of merged) (byId[h.sourceId] = byId[h.sourceId] || []).push(h);
    const trimmed = Object.values(byId)
      .flatMap((arr) => arr.slice(-KEEP_PER_SOURCE))
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    fs.mkdirSync(PUBLIC_DATA, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, trimmed.map((h) => JSON.stringify(h)).join('\n') + '\n');
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2));
  }

  return health;
}

module.exports = { assessHealth, readHistory };
