const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const STATUS_FILE = path.join(DATA_DIR, 'sources-status.json');
const SOURCES_FILE = path.join(DATA_DIR, 'sources.json');

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    console.error(`Erro lendo ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function loadSources() {
  return readJsonSafe(SOURCES_FILE, { genericBoards: [], firms: [] });
}

function loadJobs() {
  return readJsonSafe(JOBS_FILE, { updatedAt: null, jobs: [] });
}

function saveJobs(jobs) {
  writeJsonAtomic(JOBS_FILE, { updatedAt: new Date().toISOString(), jobs });
}

function loadStatus() {
  return readJsonSafe(STATUS_FILE, { lastRun: null, sources: {} });
}

function saveStatus(status) {
  writeJsonAtomic(STATUS_FILE, { ...status, lastRun: new Date().toISOString() });
}

module.exports = {
  DATA_DIR,
  loadSources,
  loadJobs,
  saveJobs,
  loadStatus,
  saveStatus,
};
