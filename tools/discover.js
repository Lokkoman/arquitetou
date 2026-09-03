#!/usr/bin/env node
// Descoberta AUTOMÁTICA de fontes novas — roda todo dia no GitHub Actions.
//
// 1. (se tiver GEMINI_API_KEY) pergunta ao Gemini, com Google Search:
//      - job boards / sites de vaga no Brasil que ainda não cobrimos
//      - escritórios/incorporadoras de arquitetura em QUALQUER cidade do Brasil
//        com página de carreiras que postam vaga REMOTA/híbrida
// 2. testa cada candidato com tools/probe.js (acessível? tem dados? bloqueado? SPA?)
// 3. grava data/candidates.json + data/candidates.md — FILA DE REVISÃO, não publica nada
//
// Também testa qualquer URL colocada à mão em data/discover-seeds.txt (1 por linha).
// Sem a chave, ainda roda o passo 2/3 sobre o que já existe + os seeds.

const fs = require('fs');
const path = require('path');
const { probe, fetchText } = require('./probe');
const { stripHtml } = require('../lib/keywords');

const ROOT = path.join(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'data', 'candidates.json');
const OUT_MD = path.join(ROOT, 'data', 'candidates.md');
const FIRMS = path.join(ROOT, 'data', 'firms.json');
const SEEDS = path.join(ROOT, 'data', 'discover-seeds.txt');
const REPROBE_AFTER_DAYS = 7;
const FIRM_STALE_DAYS = 30; // firma descoberta sem vaga de arquitetura por tanto tempo -> stale

// Descoberta por IA usa GEMINI_API_KEY (grátis, com Google Search). "gemini-flash-latest"
// é alias auto-atualizado do Google (ver nota em lib/classify.js) — fixar via a var
// DISCOVER_GEMINI_MODEL se precisar de uma versão específica.
const GEMINI_MODEL = process.env.DISCOVER_GEMINI_MODEL || 'gemini-flash-latest';
const MODEL = GEMINI_MODEL;
const HAS_KEY = Boolean(process.env.GEMINI_API_KEY);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function knownCoverage() {
  const scrapers = ['Gupy', 'Vagas.com', 'InfoJobs', 'BNE', 'LinkedIn (nativo + Bright Data)'];
  const deeplinks = ['Indeed', 'Catho'];
  const firms = (readJson(path.join(ROOT, 'data', 'firms.json'), { firms: [] }).firms || []).map((f) => f.name);
  return { scrapers, deeplinks, firms };
}

function loadSeeds() {
  try {
    return fs
      .readFileSync(SEEDS, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

const SYSTEM = `Você ajuda a manter um agregador de vagas de ARQUITETURA E URBANISMO no Brasil
(inclui licenciamento/regularização feito por arquiteto, projetista/CAD, BIM, paisagismo, interiores).

Faça TRÊS buscas na web e junte os resultados:
  (a) escritórios de arquitetura / incorporadoras / construtoras em SÃO PAULO (capital) com
      página de carreiras própria;
  (b) escritórios de arquitetura em OSASCO, GUARULHOS, BARUERI ou TABOÃO DA SERRA;
  (c) escritórios / consultorias em QUALQUER lugar do Brasil que anunciam vaga REMOTA ou
      híbrida de arquitetura, projetista, BIM ou licenciamento.
Também procure job boards brasileiros (gerais ou de nicho) que ainda não cobrimos.

Devolva SOMENTE um array JSON (sem texto fora dele):
[
  {
    "type": "job-board" | "firm",
    "name": "...",
    "url": "https://... (a PÁGINA DE VAGAS / trabalhe-conosco, não a home)",
    "uf": "SP" | "RJ" | "nacional" | ...,
    "remote": true | false,
    "method": "ats-link" | "form" | "email" | null,  (como se candidata, se der pra saber)
    "why": "1 frase: por que é relevante e por que não está coberto"
  }
]

Regras:
- NÃO repita fontes já cobertas (lista fornecida pelo usuário).
- "firm" só se tiver página de carreiras PRÓPRIA. Se você viu no snippet uma vaga de
  arquitetura/projetista/BIM aberta agora, diga na frase do "why".
- Máximo 20 itens, priorize os mais promissores. Se não achar nada novo, devolva [].`;

async function askGemini(system, userMsg) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userMsg }] }],
      tools: [{ google_search: {} }], // grounding (grátis: ~1.500/dia)
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
}

async function askForCandidates() {
  if (!HAS_KEY) {
    return { items: [], note: 'Sem GEMINI_API_KEY — descoberta por IA pulada; só revalidei o que já existe.' };
  }
  const cov = knownCoverage();
  const userMsg = `Já cobrimos:
- Scrapers: ${cov.scrapers.join(', ')}
- Links diretos: ${cov.deeplinks.join(', ')}
- Escritórios no diretório: ${cov.firms.join('; ') || '(nenhum)'}

Ache job boards e escritórios NOVOS conforme as regras.`;

  let text;
  try {
    text = await askGemini(SYSTEM, userMsg);
  } catch (err) {
    return { items: [], note: `Gemini falhou: ${err.message}` };
  }
  text = String(text || '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) return { items: [], note: 'IA não devolveu JSON — nada adicionado nesta rodada.' };
  let items = [];
  try {
    items = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { items: [], note: `falha ao ler JSON da IA: ${err.message}` };
  }
  return { items: Array.isArray(items) ? items : [], note: null };
}

// Etapa 2: baixa a página de carreiras — tem vaga de arquitetura agora? cidade-alvo
// ou remota? método de inscrição?
const ARCH_HINT_RE = /\barquitet|\burban[íi]st|\bprojetist|\bcadist|\bpaisagist|licenciamento|regulariza[çc][ãa]o|\bbim\b|autocad|archicad|sketchup|\brevit\b|maquete|habite-se|alvar[áa]/i;
const JOB_WORD_RE = /vaga|oportunidade|posi[çc][ãa]o|\bposition\b|carreir|trabalhe conosco|junte-se|estamos contratando|\bhiring\b|banco de talentos/i;
const NEG_RE = /arquitet(?:o|ura) de (?:software|solu[çc][õo]es|dados|nuvem|sistemas)|desenvolvedor|full ?stack|\bdevops\b|projetista (?:el[ée]tric|mec[âa]nic|hidr[áa]ulic)/i;
const LOC_OK_RE = /s[ãa]o paulo|\bosasco\b|guarulhos|barueri|tabo[ãa]o|remoto|home ?office|h[íi]brido|100%\s*remot|anywhere|trabalho remoto/i;

function inferMethod(url, html) {
  if (/\.gupy\.io|\.abler\.com\.br|jobs\.recrutei|myworkdayjobs|greenhouse\.io|lever\.co|trabestrabalheconosco|trabalheconosco\.vagas\.com\.br|\.solides\.com|\.kenoby\.com|\.99jobs\.com/i.test(url + html)) return 'ats-link';
  if (/mailto:[^"'\s>]+@[^"'\s>]+/i.test(html)) return 'email';
  if (/<form[\s\S]{0,4000}?(curr[íi]culo|trabalhe conosco|candidat|nome completo|anexar)/i.test(html)) return 'form';
  return 'form';
}

async function verifyFirm(url) {
  const r = await fetchText(url, 15000);
  if (!r.ok) return { ok: false, reason: r.error || `HTTP ${r.status}` };
  const html = r.body || '';
  const text = stripHtml(html).slice(0, 20000);
  const hasArch = ARCH_HINT_RE.test(text) && JOB_WORD_RE.test(text) && !NEG_RE.test(text);
  const locOk = LOC_OK_RE.test(text) || LOC_OK_RE.test(url);
  return { ok: true, hasArch, locOk, method: inferMethod(r.finalUrl || url, html), finalUrl: r.finalUrl || url };
}

// Etapa 3: promove as verificadas pro data/firms.json + manutenção.
function readFirms() {
  const j = readJson(FIRMS, { firms: [] });
  return Array.isArray(j.firms) ? j.firms : [];
}

async function promoteAndMaintain(candidates) {
  const firms = readFirms();
  const byUrl = new Map(firms.map((f) => [f.careersUrl, f]));
  const now = new Date().toISOString();
  const log = [];

  // (a) promover candidatos 'firm' que passam na verificação
  for (const c of candidates) {
    if (c.type !== 'firm' || c.adopted) continue;
    if (c.probe && ['inacessivel', 'bloqueado'].includes(c.probe.verdict)) continue;
    let v;
    try {
      v = await verifyFirm(c.url);
    } catch (err) {
      v = { ok: false, reason: err.message };
    }
    c.verify = { at: now, ...v };
    if (!v.ok || !v.hasArch || !v.locOk) continue;

    const isGupy = /\.gupy\.io/i.test(c.url);
    const entry = byUrl.get(c.url) || byUrl.get(v.finalUrl);
    if (entry) {
      entry.lastArchSeenAt = now;
      entry.status = isGupy ? 'redundant' : 'active';
    } else {
      const f = {
        name: c.name,
        city: c.uf === 'SP' ? 'São Paulo' : c.remote ? 'Brasil (remoto)' : c.uf || 'Brasil',
        applicationMethod: isGupy ? 'ats-link' : v.method,
        careersUrl: c.url,
        discovered: true,
        addedAt: now,
        lastArchSeenAt: now,
        status: isGupy ? 'redundant' : 'active',
        why: c.why || '',
      };
      firms.push(f);
      byUrl.set(c.url, f);
      log.push(`+ ${f.name} (${f.applicationMethod}) ${f.status}`);
    }
  }

  // (b) manutenção: re-verifica as descobertas; sem vaga de arquitetura há FIRM_STALE_DAYS
  //     -> status 'stale' (o site esconde; o registro fica).
  const staleCut = Date.now() - FIRM_STALE_DAYS * 864e5;
  for (const f of firms) {
    if (!f.discovered || f.status === 'redundant') continue;
    // re-checa no máx. 1x/dia por firma
    let v;
    try {
      v = await verifyFirm(f.careersUrl);
    } catch {
      v = { ok: false };
    }
    if (v.ok && v.hasArch && v.locOk) {
      f.lastArchSeenAt = now;
      if (f.status === 'stale') {
        f.status = 'active';
        log.push(`~ ${f.name} voltou a ter vaga`);
      }
    } else if (f.lastArchSeenAt && Date.parse(f.lastArchSeenAt) < staleCut && f.status !== 'stale') {
      f.status = 'stale';
      log.push(`- ${f.name} sem vaga de arquitetura há ${FIRM_STALE_DAYS}d -> stale`);
    }
  }

  fs.writeFileSync(FIRMS, JSON.stringify({ firms }, null, 2));
  return log;
}

function mdTable(candidates) {
  const rows = candidates
    .slice()
    .sort((a, b) => (a.adopted === b.adopted ? 0 : a.adopted ? 1 : -1))
    .map((c) => {
      const v = c.probe ? c.probe.verdict : '—';
      const flags = [c.adopted ? '✅ já usado' : '', c.remote ? '🏠 remoto' : '', c.robotsProtected ? '🚫 robots' : '']
        .filter(Boolean)
        .join(' ');
      return `| ${c.type} | [${c.name}](${c.url}) | ${c.uf || '?'} | **${v}** | ${flags} | ${(c.why || '').replace(/\|/g, '/')} |`;
    });
  return ['| tipo | fonte | uf | probe | flags | por quê |', '|---|---|---|---|---|---|', ...rows].join('\n');
}

async function main() {
  const prev = readJson(OUT_JSON, { candidates: [] });
  const byUrl = new Map((prev.candidates || []).map((c) => [c.url, c]));

  const { items, note } = await askForCandidates();
  console.log(`[discover] IA sugeriu ${items.length} candidato(s)${note ? ` — ${note}` : ''}`);

  for (const it of items) {
    if (!it || !it.url) continue;
    const existing = byUrl.get(it.url) || {};
    byUrl.set(it.url, {
      ...existing,
      type: it.type || existing.type || 'job-board',
      name: it.name || existing.name || it.url,
      url: it.url,
      uf: it.uf || existing.uf || null,
      remote: it.remote ?? existing.remote ?? false,
      method: it.method || existing.method || null,
      why: it.why || existing.why || '',
      firstSeen: existing.firstSeen || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      adopted: existing.adopted || false,
    });
  }

  for (const url of loadSeeds()) {
    if (!byUrl.has(url)) {
      byUrl.set(url, { type: 'job-board', name: url, url, uf: null, remote: false, why: 'seed manual', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), adopted: false });
    }
  }

  // Reprobe: candidatos novos ou sem probe recente (e ainda não adotados)
  const staleMs = REPROBE_AFTER_DAYS * 864e5;
  let probed = 0;
  for (const c of byUrl.values()) {
    if (c.adopted) continue;
    const old = c.probe && Date.now() - Date.parse(c.probe.checkedAt) < staleMs;
    if (old) continue;
    try {
      c.probe = await probe(c.url);
      c.robotsProtected = !!(c.probe.robots && (c.probe.robots.protected || c.probe.robots.disallowAll));
      probed += 1;
    } catch (err) {
      c.probe = { verdict: 'inacessivel', notes: [err.message], checkedAt: new Date().toISOString() };
    }
  }
  console.log(`[discover] ${probed} candidato(s) testados com o probe`);

  const candidates = [...byUrl.values()].sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  const generatedAt = new Date().toISOString();

  // Etapa 2+3: verifica firmas e promove as que têm vaga de arquitetura AGORA (+ manutenção).
  let firmLog = [];
  try {
    firmLog = await promoteAndMaintain(candidates);
    for (const l of firmLog) console.log(`[discover] firma: ${l}`);
  } catch (err) {
    console.error(`[discover] promote/maintain falhou: ${err.message}`);
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt, note: note || null, candidates }, null, 2));

  const pending = candidates.filter((c) => !c.adopted);
  const promising = pending.filter((c) => c.probe && ['estruturado', 'html'].includes(c.probe.verdict));
  const verified = candidates.filter((c) => c.type === 'firm' && c.verify && c.verify.hasArch && c.verify.locOk);
  const md = `# Candidatos de fontes — ${generatedAt.slice(0, 10)}

${note ? `> ${note}\n\n` : ''}**${pending.length}** candidato(s) na fila · **${promising.length}** raspáveis (probe = estruturado/html) · **${verified.length}** firmas com vaga de arquitetura confirmada.

${firmLog.length ? `**Mudanças no diretório de escritórios (data/firms.json):**\n${firmLog.map((l) => `- ${l}`).join('\n')}\n` : ''}
Firma verificada com \`status: active\` já entra no site sozinha. Job board raspável: criar
\`collector/sources/NOME.js\` e marcar \`"adopted": true\` no \`data/candidates.json\`.

${mdTable(candidates)}
`;
  fs.writeFileSync(OUT_MD, md);
  console.log(`[discover] escrito data/candidates.json (${candidates.length}) e data/candidates.md`);
}

main().catch((err) => {
  console.error('[discover] ERRO FATAL:', err);
  process.exit(1);
});
