const gupyPortal = require('./sources/gupy');
const vagasCom = require('./sources/vagasCom');
const infoJobs = require('./sources/infoJobs');
const bne = require('./sources/bne');
const linkedin = require('./sources/linkedin');
const catho = require('./sources/catho');
const empregos = require('./sources/empregos');
const { loadJobs, saveJobs, loadStatus, saveStatus } = require('./db');

const COLLECTORS = [gupyPortal, vagasCom, infoJobs, bne, linkedin, catho, empregos];

async function refreshAll({ onProgress, skip = [] } = {}) {
  const startedAt = new Date().toISOString();
  const sourcesStatus = {};
  const allJobs = new Map();

  for (const collector of COLLECTORS) {
    if (skip.includes(collector.id)) continue;
    const t0 = Date.now();
    try {
      const { jobs, errors, queried } = await collector.collect();
      for (const job of jobs) {
        if (!allJobs.has(job.id)) allJobs.set(job.id, job);
      }
      sourcesStatus[collector.id] = {
        name: collector.name,
        ok: true,
        jobsFound: jobs.length,
        queriesRun: queried,
        errors,
        durationMs: Date.now() - t0,
        lastRunAt: new Date().toISOString(),
        note: collector.note || null,
        experimental: collector.sourceType === 'scraped-experimental' || jobs.some((j) => j.sourceType === 'scraped-experimental'),
      };
    } catch (err) {
      sourcesStatus[collector.id] = {
        name: collector.name,
        ok: false,
        jobsFound: 0,
        errors: [err.message],
        durationMs: Date.now() - t0,
        lastRunAt: new Date().toISOString(),
        note: collector.note || null,
        experimental: collector.id === 'linkedin',
      };
    }
    if (onProgress) onProgress(collector.id, sourcesStatus[collector.id]);
  }

  // Preserva vagas de execuções anteriores que ainda estejam dentro da janela de
  // relevância (90 dias), para o app não "esquecer" vagas caso uma fonte falhe
  // temporariamente numa atualização.
  const previous = loadJobs();
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const job of previous.jobs || []) {
    if (allJobs.has(job.id)) continue;
    const postedMs = job.postedAt ? new Date(job.postedAt).getTime() : 0;
    if (postedMs >= cutoff) allJobs.set(job.id, job);
  }

  const jobs = Array.from(allJobs.values()).sort((a, b) => {
    const da = a.postedAt ? new Date(a.postedAt).getTime() : 0;
    const db_ = b.postedAt ? new Date(b.postedAt).getTime() : 0;
    return db_ - da;
  });

  saveJobs(jobs);
  saveStatus({ sources: sourcesStatus, startedAt, finishedAt: new Date().toISOString() });

  return { jobs, sourcesStatus };
}

module.exports = { refreshAll, COLLECTORS };
