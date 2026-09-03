// Site estático: lê os JSON de public/data/ e faz filtragem, ordenação e score de
// compatibilidade no navegador. Sem servidor.

const SOURCE_LABELS = {
  'gupy-portal': 'Gupy',
  'vagas-com': 'Vagas.com',
  infojobs: 'InfoJobs',
  bne: 'BNE',
  linkedin: 'LinkedIn (vagas)',
  catho: 'Catho',
  empregos: 'Empregos.com.br',
  'linkedin-api': 'LinkedIn (vagas)',
  'linkedin-post': 'LinkedIn (posts)',
};

// Preenchido em loadSegments() a partir de data/segments.json.
let CATEGORY_LABELS = { arquitetura: 'Arquitetura', urbanismo: 'Urbanismo', licenciamento: 'Licenciamento', cad: 'CAD/BIM' };
let SEGMENT_ORDER = [];

const WORKPLACE_LABELS = { remote: 'Remoto', hybrid: 'Híbrido', 'on-site': 'Presencial' };

// Cor estável por segmento (hue distribuído; funciona claro/escuro).
function segColor(key) {
  const i = Math.max(0, SEGMENT_ORDER.indexOf(key));
  const hue = Math.round((i * 360) / Math.max(1, SEGMENT_ORDER.length || 12));
  return `hsl(${hue} 45% ${matchMedia('(prefers-color-scheme: dark)').matches ? '68%' : '38%'})`;
}

// Todos os segmentos que a vaga toca; cai pra [category] em dados antigos.
function jobSegs(j) {
  return Array.isArray(j.segments) && j.segments.length ? j.segments : [j.category || 'arquitetura'];
}

async function loadSegments() {
  const data = await fetchJson('data/segments.json').catch(() => ({ segments: [] }));
  const segs = Array.isArray(data.segments) ? data.segments : [];
  if (!segs.length) return;
  SEGMENT_ORDER = segs.map((s) => s.key);
  CATEGORY_LABELS = Object.fromEntries(segs.map((s) => [s.key, s.label]));
  const sel = el('fCategory');
  sel.innerHTML = '<option value="todas">Todos</option>' + segs.map((s) => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('');
}

// data/facets.json -> filtro "Programa".
async function loadFacets() {
  const data = await fetchJson('data/facets.json').catch(() => null);
  const list = data && Array.isArray(data.tools) ? data.tools : [];
  const sel = el('fTool');
  if (!sel || !list.length) return;
  sel.innerHTML =
    '<option value="todas">Todos</option>' +
    list.map((x) => `<option value="${escapeHtml(x.label)}">${escapeHtml(x.label)}</option>`).join('');
  const wrap = sel.closest('.filter-group');
  if (wrap) wrap.hidden = false;
}

// LinkedIn tem 2 coletores de vagas (nativo + Bright Data) que pro usuário são uma
// fonte só. Os posts do feed (linkedin-post) ficam separados.
function canonicalSource(id) {
  return id === 'linkedin-api' ? 'linkedin' : id;
}

// Nome curto e consistente de cada fonte.
function sourceLabel(id, fallback) {
  return SOURCE_LABELS[canonicalSource(id)] || fallback || id;
}
const NEW_MS = 48 * 60 * 60 * 1000;

const el = (id) => document.getElementById(id);

let ALL_JOBS = [];
let PROFILE_TOKENS = new Set();

// ---------- utilidades de texto / score ------------------------------------

function tokenize(s) {
  return (
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[a-z0-9]{3,}/g) || []
  );
}

const STOPWORDS = new Set(
  'para com das dos den the and you sua seu nas nos por que uma que são ltda vaga vagas sobre nossa nosso mais como area sera será ter tem experiencia atividades requisitos conhecimento ensino superior area atuacao empresa cliente clientes trabalho profissional'.split(
    ' '
  )
);

function setProfileFromText(text) {
  PROFILE_TOKENS = new Set(tokenize(text).filter((t) => !STOPWORDS.has(t)));
}

function scoreJob(job) {
  if (!PROFILE_TOKENS.size) return null;
  const tools = (job.ai && Array.isArray(job.ai.tools) ? job.ai.tools : []);
  const jobTokens = new Set([
    ...tokenize(job.title),
    ...tokenize(job.matchedKeyword),
    ...tokenize(job.ai && job.ai.summary),
    ...tools.flatMap(tokenize),
    ...tokenize(String(job.description || '').slice(0, 700)),
  ]);
  if (!jobTokens.size) return 0;
  let hits = 0;
  for (const t of jobTokens) if (PROFILE_TOKENS.has(t)) hits += 1;
  const toolHits = tools.filter((t) => tokenize(t).some((x) => PROFILE_TOKENS.has(x))).length;
  const base = hits / Math.max(14, jobTokens.size);
  return Math.max(0, Math.min(100, Math.round(base * 100 + toolHits * 7)));
}

// ---------- carregamento --------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function daysAgo(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function isNew(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() - t < NEW_MS;
}

// ---------- filtros ------------------------------------------------------

function currentFilters() {
  return {
    workplace: el('fWorkplace').value,
    city: el('fCity').value,
    category: el('fCategory').value,
    source: el('fSource').value,
    tool: el('fTool') ? el('fTool').value : 'todas',
    maxDays: el('fDays').value,
    q: el('fQuery').value.trim().toLowerCase(),
    sort: el('fSort').value,
  };
}

function jobSourceIds(j) {
  const ids = Array.isArray(j.sources) && j.sources.length ? j.sources : [j.sourceId];
  return [...new Set(ids.map(canonicalSource))];
}

function matchesFilters(j, f, { ignore } = {}) {
  if (ignore !== 'city' && f.city && f.city !== 'todas' && j.cityKey !== f.city) return false;
  if (ignore !== 'category' && f.category && f.category !== 'todas' && !jobSegs(j).includes(f.category)) return false;
  if (ignore !== 'source' && f.source && f.source !== 'todas' && !jobSourceIds(j).includes(f.source)) return false;
  if (ignore !== 'tool' && f.tool && f.tool !== 'todas' && !(j.tools || []).includes(f.tool)) return false;
  if (ignore !== 'workplace' && f.workplace && f.workplace !== 'todas') {
    const wp = j.workplaceType || 'nao_informado';
    if (f.workplace === 'nao_informado' ? !!j.workplaceType : wp !== f.workplace) return false;
  }
  if (ignore !== 'maxDays' && f.maxDays) {
    const max = Number(f.maxDays);
    const d = daysAgo(j.postedAt);
    if (Number.isFinite(max) && d !== null && d > max) return false;
  }
  if (f.q) {
    const hay = `${j.title} ${j.company} ${(j.ai && j.ai.summary) || ''}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

function applyFilters(jobs, f) {
  const list = jobs.filter((j) => matchesFilters(j, f));
  if (f.sort === 'match' && PROFILE_TOKENS.size) {
    list.sort((a, b) => (b._score || 0) - (a._score || 0) || tstamp(b) - tstamp(a));
  } else {
    list.sort((a, b) => tstamp(b) - tstamp(a));
  }
  return list;
}

function tstamp(j) {
  return j.postedAt ? Date.parse(j.postedAt) || 0 : 0;
}

// Atualiza os "(n)" de cada opção de um <select>, contando os demais filtros.
function refreshCounts() {
  const f = currentFilters();
  const defs = [
    ['fWorkplace', 'workplace', (j) => [j.workplaceType || 'nao_informado']],
    ['fCity', 'city', (j) => [j.cityKey]],
    ['fCategory', 'category', (j) => jobSegs(j)], // multi-tag: conta em cada segmento
    ['fSource', 'source', (j) => jobSourceIds(j)],
    ['fTool', 'tool', (j) => j.tools || []],
  ];
  for (const [id, key, keyFn] of defs) {
    if (!el(id)) continue;
    const pool = ALL_JOBS.filter((j) => matchesFilters(j, f, { ignore: key }));
    const counts = {};
    for (const j of pool) for (const k of keyFn(j)) counts[k] = (counts[k] || 0) + 1;
    for (const opt of el(id).options) {
      const base = opt.textContent.replace(/\s*\(\d+\)\s*$/, '');
      if (opt.value === 'todas' || opt.value === '') {
        opt.textContent = `${base} (${pool.length})`;
      } else {
        opt.textContent = `${base} (${counts[opt.value] || 0})`;
      }
    }
  }
}

// ---------- render -----------------------------------------------------

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtRelativeDate(iso) {
  if (!iso) return 'Data não informada';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Data não informada';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'hoje';
  if (days === 1) return 'ontem';
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  return `há ${months} ${months === 1 ? 'mês' : 'meses'}`;
}

function scoreClass(s) {
  if (s >= 60) return 'score-high';
  if (s >= 30) return 'score-mid';
  return 'score-low';
}

function renderJobs(jobs) {
  const list = el('jobsList');
  const empty = el('emptyState');
  el('resultsCount').textContent = `${jobs.length} vaga${jobs.length === 1 ? '' : 's'}`;

  list.innerHTML = '';
  if (jobs.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const job of jobs) {
    const ai = job.ai || null;
    const summary = (ai && ai.summary) || job.descriptionSnippet || '';
    // programas: job.tools + o que a IA achou, sem repetir.
    const aiTools = ai && Array.isArray(ai.tools) ? ai.tools : [];
    const tools = [...new Set([...(job.tools || []), ...aiTools])].slice(0, 8);
    const rawLinks = Array.isArray(job.links) && job.links.length ? job.links : [{ source: job.source, sourceId: job.sourceId, url: job.url }];
    // 1 link por fonte "canônica" (linkedin nativo + Bright Data = LinkedIn).
    const links = [];
    const linkSeen = new Set();
    for (const l of rawLinks) {
      const c = canonicalSource(l.sourceId);
      if (l.url && !linkSeen.has(c)) {
        linkSeen.add(c);
        links.push({ ...l, sourceId: c });
      }
    }
    const srcIds = links.map((l) => l.sourceId);
    const score = job._score;
    const card = document.createElement('article');
    card.className = 'job-card';
    card.innerHTML = `
      <div class="job-card-top">
        <div class="job-card-headline">
          <h3 class="job-title">${escapeHtml(job.title)}</h3>
          <p class="job-company">${escapeHtml(job.company)}</p>
        </div>
        <div class="job-card-side">
          ${typeof score === 'number' ? `<span class="score-badge ${scoreClass(score)}" title="Compatibilidade estimada com seu perfil">${score}%</span>` : ''}
          <span class="job-date">${isNew(job.postedAt) ? '<span class="badge badge-new">novo</span> ' : ''}${fmtRelativeDate(job.postedAt)}</span>
        </div>
      </div>
      <div class="job-meta">
        ${srcIds.map((id) => `<span class="badge badge-source">${escapeHtml(sourceLabel(id, id))}</span>`).join('')}
        ${job.postType === 'feed-post' ? '<span class="badge">📣 post</span>' : ''}
        ${jobSegs(job).slice(0, 2).map((s) => `<span class="badge badge-cat" style="color:${segColor(s)};border-color:${segColor(s)}">${escapeHtml(CATEGORY_LABELS[s] || s)}</span>`).join('')}${jobSegs(job).length > 2 ? `<span class="badge badge-cat" title="${escapeHtml(jobSegs(job).slice(2).map((s) => CATEGORY_LABELS[s] || s).join(', '))}">+${jobSegs(job).length - 2}</span>` : ''}
        <span class="badge">${escapeHtml(job.cityLabel || 'Local não informado')}</span>
        ${job.workplaceType ? `<span class="badge">${WORKPLACE_LABELS[job.workplaceType] || job.workplaceType}</span>` : ''}
        ${ai && ai.salary ? `<span class="badge badge-salary">💰 ${escapeHtml(ai.salary)}</span>` : ''}
      </div>
      ${tools.length ? `<div class="job-tools">${tools.map((t) => `<span class="tool-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      ${summary ? `<p class="job-desc">${escapeHtml(summary)}</p>` : ''}
      <div class="job-actions">
        ${links.map((l, i) => `<a class="btn ${i === 0 ? 'btn-primary' : 'btn-secondary'}" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${links.length > 1 ? `Ver em ${escapeHtml(sourceLabel(l.sourceId, l.source))}` : 'Ver vaga / Inscrever-se'}</a>`).join('')}
      </div>
    `;
    frag.appendChild(card);
  }
  list.appendChild(frag);
}

function renderCurrent() {
  const f = currentFilters();
  if (PROFILE_TOKENS.size) for (const j of ALL_JOBS) j._score = scoreJob(j);
  else for (const j of ALL_JOBS) delete j._score;
  refreshCounts();
  renderJobs(applyFilters(ALL_JOBS, f));
}

async function loadJobs() {
  const data = await fetchJson('data/jobs.json');
  ALL_JOBS = Array.isArray(data.jobs) ? data.jobs : [];
  if (data.updatedAt) {
    el('updatedAt').textContent = `Atualizado ${fmtRelativeDate(data.updatedAt)}`;
    el('updatedAt').title = new Date(data.updatedAt).toLocaleString('pt-BR');
  }
  renderCurrent();
}

async function loadSourceStatus() {
  const [status, health] = await Promise.all([
    fetchJson('data/sources.json').catch(() => ({ sources: {} })),
    fetchJson('data/health.json').catch(() => null),
  ]);
  const container = el('sourceStatus');
  const notesContainer = el('sourceNotes');
  container.innerHTML = '';
  notesContainer.innerHTML = '';
  const sources = status.sources || {};

  // Diagnóstico da última coleta (health.json) — só aparece se algo saiu do normal.
  if (health && Array.isArray(health.alerts) && health.alerts.length) {
    const box = document.createElement('p');
    box.className = 'source-note source-note-warn';
    const items = health.alerts
      .map((a) => {
        const [id, rest] = String(a).split(/:\s(.+)/);
        return `<li><strong>${escapeHtml(sourceLabel(id, id))}</strong>: ${escapeHtml(rest || '')}</li>`;
      })
      .join('');
    box.innerHTML = `<strong>⚠️ Diagnóstico da última atualização:</strong><ul>${items}</ul>` +
      `<span class="muted">Fontes com problema são re-tentadas automaticamente; o que já estava listado continua no ar (janela de 90 dias).</span>`;
    notesContainer.appendChild(box);
  }
  const sourceSelect = el('fSource');
  const existingValues = new Set(Array.from(sourceSelect.options).map((o) => o.value));

  // Agrupa por fonte canônica (LinkedIn nativo + Bright Data = uma "LinkedIn (vagas)" só)
  // e ordena alfabeticamente pelo nome exibido.
  const groups = new Map();
  Object.entries(sources).forEach(([id, s]) => {
    const canon = canonicalSource(id);
    const g = groups.get(canon) || { canon, jobsFound: 0, errorCount: 0, aborted: false, oks: [], experimentals: [], notes: [], viaExtension: false };
    g.jobsFound += s.jobsFound || 0;
    g.errorCount += s.errorCount != null ? s.errorCount : Array.isArray(s.errors) ? s.errors.length : 0;
    g.aborted = g.aborted || !!s.aborted;
    g.oks.push(s.ok !== false);
    g.experimentals.push(!!s.experimental);
    g.viaExtension = g.viaExtension || !!s.viaExtension;
    if (s.note) g.notes.push(s.note);
    groups.set(canon, g);
  });

  const rows = [...groups.values()]
    .map((g) => ({
      canon: g.canon,
      label: sourceLabel(g.canon, g.canon),
      jobsFound: g.jobsFound,
      errorCount: g.errorCount,
      aborted: g.aborted,
      ok: g.oks.every(Boolean),
      // ⚠️ só quando toda contribuição da fonte é frágil.
      experimental: g.experimentals.length > 0 && g.experimentals.every(Boolean),
      viaExtension: g.viaExtension,
      note: g.notes[0] || '',
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));

  rows.forEach((r) => {
    const unit = r.canon === 'linkedin-post' ? 'post' : 'vaga';
    const chip = document.createElement('span');
    chip.className = `source-chip${r.ok ? '' : ' dot-error'}${r.experimental ? ' dot-experimental' : ''}${r.viaExtension ? ' dot-extension' : ''}`;
    chip.title = [
      r.note,
      r.aborted ? 'a coleta parou no meio (disjuntor) — trouxe parte das vagas' : '',
      r.errorCount ? `${r.errorCount} aviso(s) de coleta nesta rodada` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const tail = !r.ok
      ? ' <span class="src-err">(falhou)</span>'
      : r.aborted
      ? ' <span class="src-warn">· parcial</span>'
      : r.errorCount
      ? ` <span class="src-warn">· ${r.errorCount} aviso${r.errorCount === 1 ? '' : 's'}</span>`
      : '';
    chip.innerHTML = `<span class="dot"></span> ${escapeHtml(r.label)}${r.experimental ? ' ⚠️' : ''}: ${r.jobsFound} ${unit}${r.jobsFound === 1 ? '' : 's'}${tail}`;
    container.appendChild(chip);

    if (!existingValues.has(r.canon)) {
      const opt = document.createElement('option');
      opt.value = r.canon;
      opt.textContent = r.label;
      sourceSelect.appendChild(opt);
      existingValues.add(r.canon);
    }

    if (r.note) {
      const note = document.createElement('p');
      note.className = 'source-note';
      note.innerHTML = `<strong>${escapeHtml(r.label)}:</strong> ${escapeHtml(r.note)}`;
      notesContainer.appendChild(note);
    }
  });

  if (status.ai && status.ai.note) {
    const note = document.createElement('p');
    note.className = 'source-note';
    note.innerHTML = `<strong>Classificação por IA:</strong> ${escapeHtml(status.ai.note)}`;
    notesContainer.appendChild(note);
  }
}

async function loadDeeplinks() {
  const { entries } = await fetchJson('data/deeplinks.json').catch(() => ({ entries: [] }));
  const grid = el('deeplinksGrid');
  grid.innerHTML = '';

  const bySourceCity = new Map();
  for (const entry of entries) {
    const key = `${entry.sourceId}-${entry.cityKey}`;
    if (!bySourceCity.has(key)) bySourceCity.set(key, []);
    bySourceCity.get(key).push(entry);
  }

  for (const [, group] of bySourceCity) {
    const first = group[0];
    const card = document.createElement('div');
    card.className = 'deeplink-card';
    const links = group
      .map((e) => `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.recencyLabel || 'Ver busca')}</a>`)
      .join(' · ');
    card.innerHTML = `<h4>${escapeHtml(first.source)} — ${escapeHtml(first.cityLabel)}</h4><div>${links}</div>${
      first.note ? `<p class="section-note" style="margin:4px 0 0;font-size:0.75rem;">${escapeHtml(first.note)}</p>` : ''
    }`;
    grid.appendChild(card);
  }
}

async function loadFirms() {
  const data = await fetchJson('data/firms.json').catch(() => ({ firms: [] }));
  el('firmsNote').textContent = data.note || '';
  const grid = el('firmsGrid');
  grid.innerHTML = '';

  const methodLabels = { 'ats-link': 'Vagas online', email: 'Candidatura por e-mail', form: 'Formulário próprio', listing: 'Lista de vagas' };

  // Esconde firmas descobertas "stale" ou "redundant". Curadas à mão sempre aparecem.
  const visible = (data.firms || []).filter((f) => !f.status || f.status === 'active');
  for (const firm of visible) {
    const card = document.createElement('div');
    card.className = `firm-card${firm.highlight ? ' highlight' : ''}`;
    card.innerHTML = `
      <h4>${escapeHtml(firm.name)}${firm.discovered ? ' <span class="firm-auto" title="Encontrada automaticamente">•</span>' : ''}</h4>
      <p class="firm-city">${escapeHtml(firm.city)}${firm.platform ? ` · ${escapeHtml(firm.platform)}` : ''}</p>
      <p class="firm-notes">${escapeHtml(firm.notes || firm.why || '')}</p>
      <div class="firm-links">
        <a href="${escapeHtml(firm.careersUrl)}" target="_blank" rel="noopener noreferrer">${methodLabels[firm.applicationMethod] || 'Carreiras'} →</a>
        ${firm.contactEmail ? `<a href="mailto:${escapeHtml(firm.contactEmail)}">${escapeHtml(firm.contactEmail)}</a>` : ''}
      </div>
    `;
    grid.appendChild(card);
  }
}

// ---------- perfil / compatibilidade ----------------------------------

const PROFILE_KEY = 'vagas-arq-perfil';

function loadProfile() {
  let saved = '';
  try {
    saved = localStorage.getItem(PROFILE_KEY) || '';
  } catch {
    saved = '';
  }
  if (saved) {
    el('profileText').value = saved;
    setProfileFromText(saved);
    el('fSort').value = 'match';
    el('profileToggle').textContent = '🎯 Perfil ativo — editar';
    el('profileToggle').classList.add('active');
  }
}

function saveProfile() {
  const text = el('profileText').value.trim();
  try {
    if (text) localStorage.setItem(PROFILE_KEY, text);
    else localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* modo privado: segue só em memória */
  }
  setProfileFromText(text);
  el('profileToggle').textContent = text ? '🎯 Perfil ativo — editar' : '🎯 Ordenar pelo meu perfil';
  el('profileToggle').classList.toggle('active', !!text);
  if (text) el('fSort').value = 'match';
  renderCurrent();
}

function clearProfile() {
  el('profileText').value = '';
  saveProfile();
}

// ---------- filtros extras ----------------------------------------

function clearFilters() {
  ['fWorkplace', 'fCity', 'fCategory', 'fSource', 'fTool'].forEach((id) => {
    if (el(id)) el(id).value = 'todas';
  });
  el('fDays').value = '30';
  el('fQuery').value = '';
  renderCurrent();
}

// ---------- init ------------------------------------------------------

function setupControls() {
  ['fWorkplace', 'fCity', 'fCategory', 'fSource', 'fTool', 'fDays', 'fSort'].forEach((id) => {
    if (el(id)) el(id).addEventListener('change', renderCurrent);
  });
  let debounceTimer;
  el('fQuery').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderCurrent, 200);
  });

  el('clearFilters').addEventListener('click', clearFilters);

  el('profileToggle').addEventListener('click', () => {
    const panel = el('profilePanel');
    const open = panel.hidden;
    panel.hidden = !open;
    el('profileToggle').setAttribute('aria-expanded', String(open));
  });
  el('profileSave').addEventListener('click', saveProfile);
  el('profileClear').addEventListener('click', clearProfile);

  const dlToggle = el('deeplinksToggle');
  dlToggle.addEventListener('click', () => {
    const body = el('deeplinksBody');
    const open = body.hidden;
    body.hidden = !open;
    dlToggle.setAttribute('aria-expanded', String(open));
  });
}

(async function init() {
  setupControls();
  loadProfile();
  try {
    await Promise.all([loadSegments(), loadFacets()]); // popula os filtros antes de renderizar
    await Promise.all([loadJobs(), loadSourceStatus(), loadDeeplinks(), loadFirms()]);
    renderCurrent(); // recontabiliza os filtros cujas opções entram depois
  } catch (err) {
    console.error(err);
    el('resultsCount').textContent = 'Erro ao carregar os dados. Recarregue a página.';
  }
})();
