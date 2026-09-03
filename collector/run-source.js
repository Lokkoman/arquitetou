#!/usr/bin/env node
// Roda UMA fonte e grava site/public/data/parts/<id>.json. Cada job do collect.yml
// chama isto pra uma fonte; o build.js junta os parts depois.
//
//   node collector/run-source.js <id>

const fs = require('fs');
const path = require('path');

const gupy = require('./sources/gupy');
const vagasCom = require('./sources/vagasCom');
const infoJobs = require('./sources/infoJobs');
const bne = require('./sources/bne');
const linkedin = require('./sources/linkedin');
const catho = require('./sources/catho');
const empregos = require('./sources/empregos');

const SOURCES = {
  [gupy.id]: gupy,
  [vagasCom.id]: vagasCom,
  [infoJobs.id]: infoJobs,
  [bne.id]: bne,
  [linkedin.id]: linkedin,
  [catho.id]: catho,
  [empregos.id]: empregos,
};

async function main() {
  const id = process.argv[2];
  const src = SOURCES[id];
  if (!src) {
    console.error(`fonte desconhecida: "${id}". opções: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'site', 'public', 'data', 'parts');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${id}.json`);

  const t0 = Date.now();
  console.log(`[run-source] ${id} — início`);
  let result;
  try {
    result = await src.collect({ onProgress: () => {} });
  } catch (err) {
    console.error(`[run-source] ${id} FALHOU: ${err.message}`);
    // Não sobrescreve o part anterior com vazio.
    process.exit(1);
  }

  const errs = result.errors || [];
  const part = {
    sourceId: id,
    name: src.name,
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    queriesRun: result.queried || null,
    // "ok" = trouxe vaga. Erro isolado ou disjuntor abortando no meio viram
    // errorCount/aborted (aviso suave no site), não "falhou".
    ok: (result.jobs || []).length > 0,
    aborted: !!result.aborted,
    errorCount: errs.length,
    errors: errs,
    jobs: result.jobs || [],
  };

  // Veredito da rodada (compara com o histórico em site/public/data/history.jsonl).
  let verdict = 'ok';
  try {
    const { assessHealth } = require('../tools/health');
    const h = assessHealth(
      { [id]: { jobsFound: part.jobs.length, errors: part.errors, queriesRun: part.queriesRun, durationMs: part.durationMs, lastRunAt: part.collectedAt } },
      { write: false }
    );
    verdict = (h.sources[id] && h.sources[id].verdict) || 'ok';
    part.verdict = verdict;
    if (h.sources[id] && h.sources[id].reasons.length) part.diagnosis = h.sources[id].reasons.join('; ');
  } catch (err) {
    console.error(`[run-source] health indisponível: ${err.message}`);
  }

  // 0 vagas: não sobrescreve o part anterior (a retenção de 90d + o part já commitado
  // seguram os dados). Não é falha dura — só um aviso — pra uma fonte magra (ex.:
  // Vagas.com) não derrubar o workflow toda rodada.
  if (part.jobs.length === 0) {
    console.log(`::warning title=coleta ${id}::0 vaga(s) nesta rodada — mantido o part anterior`);
    process.exit(0);
  }

  fs.writeFileSync(outFile, JSON.stringify(part, null, 2));
  console.log(
    `[run-source] ${id} — ${part.jobs.length} vaga(s), ${part.errors.length} erro(s), ${(part.durationMs / 1000).toFixed(0)}s, veredito=${verdict}` +
      (part.diagnosis ? ` (${part.diagnosis})` : '') +
      ` -> ${path.relative(path.join(__dirname, '..'), outFile)}`
  );
  if (['failed', 'degraded', 'low'].includes(verdict)) {
    console.log(`::warning title=coleta ${id}::${verdict.toUpperCase()} — ${part.diagnosis || 'ver health.json'}`);
  }
}

main();
