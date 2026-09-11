// ═══════════════════════════════════════════════════════════
// PrintoForms — Cloudflare Worker backend (replaces Code.gs)
// Bindings required (set in Cloudflare dashboard):
//   D1 database  -> env.DB   (binding name must be "DB")
// Secrets required (wrangler secret put / dashboard "Variables"):
//   ADMIN_PASSWORD          e.g. admin@printo2026
//   GOOGLE_SA_EMAIL         service-account email
//   GOOGLE_SA_PRIVATE_KEY   full PEM private key (with \n newlines)
//   DRIVE_ROOT_FOLDER_ID    Drive folder ID the service account can write to
// ═══════════════════════════════════════════════════════════

const ALLOW_PUBLIC_EDIT = true;

// ── CORS ────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonOut(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    let req = {};
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url);
        const raw = url.searchParams.get('data');
        if (raw) req = JSON.parse(raw);
      } else {
        const raw = await request.text();
        if (raw) req = JSON.parse(raw);
      }
    } catch (e) {
      return jsonOut({ success: false, error: 'Bad request payload' });
    }

    const action = req.action || '';
    let result;
    try {
      switch (action) {
        case 'verifyAdmin':          result = verifyAdmin(req, env); break;
        case 'getForms':             result = await getForms(env); break;
        case 'getForm':              result = await getForm(env, req.slug); break;
        case 'createForm':           result = await createForm(env, req); break;
        case 'updateForm':           result = await updateForm(env, req); break;
        case 'deleteForm':           result = await deleteForm(env, req.slug, req.password); break;
        case 'toggleLock':           result = await toggleLock(env, req.slug, req.locked, req.password); break;
        case 'getFormStats':         result = await getFormStats(env, req.slug); break;
        case 'getSubmissions':       result = await getSubmissions(env, req.slug, req.deviceId, req.offset, req.limit); break;
        case 'getManagerSubmissions':result = await getManagerSubmissions(env, req.slug, req.managerPassword, req.offset, req.limit); break;
        case 'searchSubmissions':    result = await searchSubmissions(env, req.slug, req.query, req.deviceId); break;
        case 'submitRecord':         result = await submitRecord(env, req.slug, req.values, req.deviceId); break;
        case 'updateRecord':         result = await updateRecord(env, req.slug, req.row, req.values, req.password, req.deviceId); break;
        case 'deleteRecord':         result = await deleteRecord(env, req.slug, req.row, req.password, req.deviceId); break;
        case 'uploadFile':           result = await proxyUploadFile(env, req); break;
        case 'getSheetUrl':          result = { success: true, url: '' }; break; // no spreadsheet anymore
        case 'exportCsv':            return await exportCsv(env, req.slug, req.password); // returns Response directly
        case 'getPublicDuplicates':  result = await getPublicDuplicates(env, req.slug, req.deviceId); break;
        case 'getDupCount':          result = await getDupCount(env, req.slug); break;
        case 'getFieldCounts':       result = await getFieldCounts(env, req.slug); break;
        case 'checkSubmitDuplicate': result = await checkSubmitDuplicate(env, req.slug, req.values); break;
        default: result = { success: false, error: 'Unknown action: ' + action };
      }
    } catch (err) {
      result = { success: false, error: String(err && err.message || err) };
    }
    return jsonOut(result);
  },
};

// ─────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────
function verifyAdmin(req, env) {
  return { success: req.password === env.ADMIN_PASSWORD };
}

async function getManagerPassword(env, slug) {
  const row = await env.DB.prepare('SELECT manager_password FROM forms WHERE slug = ?').bind(slug).first();
  return row ? row.manager_password : null;
}

// ─────────────────────────────────────────────────────────
// FORMS
// ─────────────────────────────────────────────────────────
function rowToForm(row) {
  let fields = [];
  try { fields = JSON.parse(row.fields_json || '[]'); } catch (e) {}
  return {
    slug: row.slug, title: row.title,
    def: {
      description: row.description, fields,
      renameFieldId: row.rename_field_id, logoText: row.logo_text,
      accentColor: row.accent_color, hideBranding: !!row.hide_branding,
      publicMode: !!row.public_mode,
    },
    locked: !!row.locked, count: row.submission_count, createdAt: row.created_at,
  };
}

async function getForms(env) {
  const { results } = await env.DB.prepare('SELECT * FROM forms ORDER BY created_at DESC').all();
  return { success: true, forms: (results || []).map(rowToForm) };
}

async function getForm(env, slug) {
  if (!slug) return { success: false, error: 'No slug provided' };
  const row = await env.DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(slug).first();
  if (!row) return { success: false, error: 'Form not found: ' + slug };
  const f = rowToForm(row);
  return {
    success: true, slug: f.slug, title: f.title, def: f.def, locked: f.locked,
    hasManagerPassword: !!(row.manager_password && row.manager_password.length > 0),
  };
}

async function createForm(env, req) {
  if (req.password !== env.ADMIN_PASSWORD) return { success: false, error: 'Invalid password' };
  const slug = (req.slug || '').toLowerCase().trim();
  if (!slug || !/^[a-z0-9-]+$/.test(slug))
    return { success: false, error: 'Invalid slug — use only lowercase letters, numbers, hyphens' };
  const exists = await env.DB.prepare('SELECT 1 FROM forms WHERE slug = ?').bind(slug).first();
  if (exists) return { success: false, error: 'A form with this URL slug already exists' };

  await env.DB.prepare(`
    INSERT INTO forms (slug, title, description, fields_json, rename_field_id, logo_text,
      accent_color, hide_branding, public_mode, manager_password, locked, submission_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,0,0,?)
  `).bind(
    slug, req.title || slug, req.description || '', JSON.stringify(req.fields || []),
    req.renameFieldId || '', req.logoText || '', req.accentColor || '#2563eb',
    req.hideBranding ? 1 : 0, req.managerPassword || '', new Date().toISOString()
  ).run();

  return { success: true, slug };
}

async function updateForm(env, req) {
  if (req.password !== env.ADMIN_PASSWORD) return { success: false, error: 'Invalid password' };
  const row = await env.DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(req.slug).first();
  if (!row) return { success: false, error: 'Form not found' };

  const next = {
    title: req.title !== undefined ? req.title : row.title,
    description: req.description !== undefined ? req.description : row.description,
    fields_json: req.fields !== undefined ? JSON.stringify(req.fields) : row.fields_json,
    rename_field_id: req.renameFieldId !== undefined ? req.renameFieldId : row.rename_field_id,
    logo_text: req.logoText !== undefined ? req.logoText : row.logo_text,
    accent_color: req.accentColor !== undefined ? req.accentColor : row.accent_color,
    hide_branding: req.hideBranding !== undefined ? (req.hideBranding ? 1 : 0) : row.hide_branding,
    public_mode: req.publicMode !== undefined ? (req.publicMode ? 1 : 0) : row.public_mode,
    manager_password: req.managerPassword !== undefined ? String(req.managerPassword || '') : row.manager_password,
  };

  await env.DB.prepare(`
    UPDATE forms SET title=?, description=?, fields_json=?, rename_field_id=?, logo_text=?,
      accent_color=?, hide_branding=?, public_mode=?, manager_password=? WHERE slug=?
  `).bind(next.title, next.description, next.fields_json, next.rename_field_id, next.logo_text,
    next.accent_color, next.hide_branding, next.public_mode, next.manager_password, req.slug).run();

  return { success: true };
}

async function deleteForm(env, slug, password) {
  if (password !== env.ADMIN_PASSWORD) return { success: false, error: 'Invalid password' };
  const row = await env.DB.prepare('SELECT slug FROM forms WHERE slug = ?').bind(slug).first();
  if (!row) return { success: false, error: 'Form not found' };
  // Item 9: deleting a form deletes all its submissions too.
  await env.DB.prepare('DELETE FROM submissions WHERE slug = ?').bind(slug).run();
  await env.DB.prepare('DELETE FROM forms WHERE slug = ?').bind(slug).run();
  return { success: true };
}

async function toggleLock(env, slug, locked, password) {
  if (password !== env.ADMIN_PASSWORD) return { success: false, error: 'Invalid password' };
  const res = await env.DB.prepare('UPDATE forms SET locked = ? WHERE slug = ?')
    .bind(locked === true || locked === 'true' ? 1 : 0, slug).run();
  if (!res.meta.changes) return { success: false, error: 'Form not found' };
  return { success: true };
}

async function getFormStats(env, slug) {
  if (!slug) return { success: false, error: 'No slug' };
  const row = await env.DB.prepare('SELECT submission_count FROM forms WHERE slug = ?').bind(slug).first();
  return { success: true, total: row ? row.submission_count : 0 };
}

// ─────────────────────────────────────────────────────────
// SUBMISSIONS
// ─────────────────────────────────────────────────────────
function dupKeyFieldsOf(defFields) {
  return defFields
    .filter(f => !['LIST', 'MULTIPLE_CHOICE', 'CHECKBOX', 'FILE_UPLOAD'].some(t => (f.type || '').includes(t)))
    .slice(0, 4);
}
function dupNorm(val, fieldType) {
  if (!val) return '';
  const v = String(val).trim().replace(/\s+/g, ' ').toLowerCase();
  if (fieldType && fieldType.includes('DATE') && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-'); return d + '/' + m + '/' + y;
  }
  return v;
}
function computeDupKey(defFields, valuesObj) {
  const keyFields = dupKeyFieldsOf(defFields);
  if (!keyFields.length) return '';
  const key = keyFields.map(f => dupNorm(valuesObj ? valuesObj[f.id] : '', f.type)).join('|');
  return key.replace(/\|/g, '').trim() ? key : '';
}

function recordFromRow(row, defFields, isOwn) {
  let values = {};
  try { values = JSON.parse(row.values_json || '{}'); } catch (e) {}
  const answers = defFields.map(f => (values[f.id] !== undefined && values[f.id] !== null) ? String(values[f.id]) : '');
  return { row: row.id, timestamp: new Date(row.created_at).getTime() || 0, answers, isOwn };
}

async function getFormFields(env, slug) {
  const row = await env.DB.prepare('SELECT fields_json, public_mode FROM forms WHERE slug = ?').bind(slug).first();
  if (!row) return { fields: [], publicMode: false };
  let fields = [];
  try { fields = JSON.parse(row.fields_json || '[]'); } catch (e) {}
  return { fields, publicMode: !!row.public_mode };
}

async function getSubmissions(env, slug, deviceId, offset, limit) {
  offset = Math.max(0, parseInt(offset, 10) || 0);
  limit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const formRow = await env.DB.prepare('SELECT submission_count, fields_json, public_mode FROM forms WHERE slug = ?').bind(slug).first();
  if (!formRow) return { success: true, records: [], headers: [], total: 0, ownCount: 0, hasMore: false };

  let fields = [];
  try { fields = JSON.parse(formRow.fields_json || '[]'); } catch (e) {}
  const headers = fields.map(f => f.title);
  const total = formRow.submission_count;

  if (formRow.public_mode) {
    const { results } = await env.DB.prepare(
      'SELECT * FROM submissions WHERE slug = ? ORDER BY id DESC LIMIT ? OFFSET ?'
    ).bind(slug, limit + 1, offset).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const records = page.map(r => recordFromRow(r, fields, !!(deviceId && r.device_id === deviceId)));
    let ownCount = 0;
    if (deviceId) {
      const c = await env.DB.prepare('SELECT COUNT(*) as n FROM submissions WHERE slug=? AND device_id=?').bind(slug, deviceId).first();
      ownCount = c ? c.n : 0;
    }
    return { success: true, records, headers, total, ownCount, hasMore };
  }

  // Private mode: caller only ever sees their own rows
  if (!deviceId) return { success: true, records: [], headers, total, ownCount: 0, hasMore: false };
  const { results } = await env.DB.prepare(
    'SELECT * FROM submissions WHERE slug = ? AND device_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).bind(slug, deviceId, limit + 1, offset).all();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const ownCountRow = await env.DB.prepare('SELECT COUNT(*) as n FROM submissions WHERE slug=? AND device_id=?').bind(slug, deviceId).first();
  const records = page.map(r => recordFromRow(r, fields, true));
  return { success: true, records, headers, total, ownCount: ownCountRow ? ownCountRow.n : 0, hasMore };
}

async function getManagerSubmissions(env, slug, managerPassword, offset, limit) {
  if (!slug) return { success: false, error: 'No slug' };
  if (!managerPassword) return { success: false, error: 'WRONG_PASSWORD' };

  const isAdmin = managerPassword === (await getEnvAdminPassword(env));
  if (!isAdmin) {
    const stored = await getManagerPassword(env, slug);
    if (stored === null) return { success: false, error: 'Form not found' };
    if (!stored || stored !== managerPassword) return { success: false, error: 'WRONG_PASSWORD' };
  }

  offset = Math.max(0, parseInt(offset, 10) || 0);
  limit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const formRow = await env.DB.prepare('SELECT submission_count, fields_json FROM forms WHERE slug = ?').bind(slug).first();
  if (!formRow) return { success: true, records: [], headers: [], total: 0, hasMore: false, isManagerMode: true };
  let fields = [];
  try { fields = JSON.parse(formRow.fields_json || '[]'); } catch (e) {}
  const headers = fields.map(f => f.title);
  const total = formRow.submission_count;

  const { results } = await env.DB.prepare(
    'SELECT * FROM submissions WHERE slug = ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).bind(slug, limit + 1, offset).all();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const records = page.map(r => ({ ...recordFromRow(r, fields, true), isManagerEntry: true }));
  return { success: true, records, headers, total, hasMore, isManagerMode: true };
}

// verifyAdmin() reads env directly; small helper so getManagerSubmissions reads consistently
async function getEnvAdminPassword(env) { return env.ADMIN_PASSWORD; }

async function searchSubmissions(env, slug, query, deviceId) {
  if (!slug || !query) return { success: true, records: [], headers: [] };
  const { fields } = await getFormFields(env, slug);
  const headers = fields.map(f => f.title);
  const q = String(query).toLowerCase().trim();

  let stmt, results;
  if (deviceId) {
    ({ results } = await env.DB.prepare('SELECT * FROM submissions WHERE slug=? AND device_id=? ORDER BY id DESC').bind(slug, deviceId).all());
  } else {
    ({ results } = await env.DB.prepare('SELECT * FROM submissions WHERE slug=? ORDER BY id DESC').bind(slug).all());
  }

  const records = [];
  for (const row of (results || [])) {
    const rec = recordFromRow(row, fields, !!deviceId);
    if (rec.answers.some(a => a.toLowerCase().includes(q))) records.push(rec);
  }
  return { success: true, records, headers };
}

async function submitRecord(env, slug, valuesObj, deviceId) {
  const formRow = await env.DB.prepare('SELECT locked, fields_json FROM forms WHERE slug=?').bind(slug).first();
  if (!formRow) return { success: false, error: 'Form not found' };
  if (formRow.locked) return { success: false, error: 'This form is currently closed for submissions.' };

  let fields = [];
  try { fields = JSON.parse(formRow.fields_json || '[]'); } catch (e) {}
  const dupKey = computeDupKey(fields, valuesObj);
  const now = new Date().toISOString();

  const res = await env.DB.prepare(
    'INSERT INTO submissions (slug, device_id, values_json, dup_key, created_at) VALUES (?,?,?,?,?)'
  ).bind(slug, deviceId || '', JSON.stringify(valuesObj || {}), dupKey, now).run();

  const newId = res.meta.last_row_id;
  await env.DB.prepare('UPDATE forms SET submission_count = submission_count + 1 WHERE slug = ?').bind(slug).run();
  const totalRow = await env.DB.prepare('SELECT submission_count FROM forms WHERE slug=?').bind(slug).first();

  return { success: true, row: newId, total: totalRow ? totalRow.submission_count : 0 };
}

async function updateRecord(env, slug, row, valuesObj, password, deviceId) {
  const isAdmin = password === env.ADMIN_PASSWORD;
  let isManager = false;
  if (!isAdmin && password) {
    const stored = await getManagerPassword(env, slug);
    isManager = !!(stored && stored === password);
  }

  if (!isAdmin && !isManager) {
    const formRow = await env.DB.prepare('SELECT locked, public_mode FROM forms WHERE slug=?').bind(slug).first();
    const isPublicMode = !!(formRow && formRow.public_mode);
    if (!isPublicMode && ALLOW_PUBLIC_EDIT) {
      const sub = await env.DB.prepare('SELECT device_id FROM submissions WHERE id=? AND slug=?').bind(row, slug).first();
      if (!sub || !deviceId || sub.device_id !== deviceId) return { success: false, error: 'You can only edit your own entries.' };
    } else if (!isPublicMode && !ALLOW_PUBLIC_EDIT) {
      return { success: false, error: 'Invalid password' };
    }
    if (formRow && formRow.locked) return { success: false, error: 'Editing is currently disabled for this form.' };
  }

  const sub = await env.DB.prepare('SELECT values_json FROM submissions WHERE id=? AND slug=?').bind(row, slug).first();
  if (!sub) return { success: false, error: 'Record not found' };
  let values = {};
  try { values = JSON.parse(sub.values_json || '{}'); } catch (e) {}
  if (valuesObj && typeof valuesObj === 'object') {
    for (const [k, v] of Object.entries(valuesObj)) values[k] = v || '';
  }
  await env.DB.prepare('UPDATE submissions SET values_json=? WHERE id=? AND slug=?')
    .bind(JSON.stringify(values), row, slug).run();

  return { success: true };
}

async function deleteRecord(env, slug, row, password, deviceId) {
  const isAdmin = password === env.ADMIN_PASSWORD;
  let isManager = false;
  if (!isAdmin && password) {
    const stored = await getManagerPassword(env, slug);
    isManager = !!(stored && stored === password);
  }

  if (!isAdmin && !isManager) {
    const formRow = await env.DB.prepare('SELECT public_mode FROM forms WHERE slug=?').bind(slug).first();
    const isPublicMode = !!(formRow && formRow.public_mode);
    if (!isPublicMode && ALLOW_PUBLIC_EDIT) {
      const sub = await env.DB.prepare('SELECT device_id FROM submissions WHERE id=? AND slug=?').bind(row, slug).first();
      if (!sub || !deviceId || sub.device_id !== deviceId) return { success: false, error: 'You can only delete your own entries.' };
    } else if (!isPublicMode && !ALLOW_PUBLIC_EDIT) {
      return { success: false, error: 'Invalid password' };
    }
  }

  const res = await env.DB.prepare('DELETE FROM submissions WHERE id=? AND slug=?').bind(row, slug).run();
  if (!res.meta.changes) return { success: false, error: 'Record not found' };

  await env.DB.prepare('UPDATE forms SET submission_count = MAX(0, submission_count - 1) WHERE slug = ?').bind(slug).run();
  const totalRow = await env.DB.prepare('SELECT submission_count FROM forms WHERE slug=?').bind(slug).first();
  return { success: true, total: totalRow ? totalRow.submission_count : 0 };
}

// ─────────────────────────────────────────────────────────
// DUPLICATES / FIELD COUNTS
// ─────────────────────────────────────────────────────────
async function getPublicDuplicates(env, slug, deviceId) {
  const { results } = await env.DB.prepare(
    `SELECT dup_key, id, device_id FROM submissions WHERE slug=? AND dup_key != '' ORDER BY dup_key`
  ).bind(slug).all();
  const byKey = {};
  for (const r of results || []) (byKey[r.dup_key] ||= []).push(r);
  const groups = [];
  let totalDups = 0;
  for (const k in byKey) {
    if (byKey[k].length > 1) {
      groups.push(byKey[k].map(item => ({ row: item.id, isOwn: !!(deviceId && item.device_id === deviceId) })));
      totalDups += byKey[k].length;
    }
  }
  return { success: true, groups, totalDups };
}

async function getDupCount(env, slug) {
  const { results } = await env.DB.prepare(
    `SELECT dup_key, COUNT(*) as n FROM submissions WHERE slug=? AND dup_key != '' GROUP BY dup_key HAVING n > 1`
  ).bind(slug).all();
  let groupCount = 0, totalDups = 0;
  for (const r of results || []) { groupCount++; totalDups += r.n; }
  return { success: true, groupCount, totalDups };
}

async function checkSubmitDuplicate(env, slug, valuesObj) {
  const { fields } = await getFormFields(env, slug);
  const dupKey = computeDupKey(fields, valuesObj);
  if (!dupKey) return { success: true, matches: [] };
  const { results } = await env.DB.prepare('SELECT * FROM submissions WHERE slug=? AND dup_key=?').bind(slug, dupKey).all();
  const matches = (results || []).map(r => recordFromRow(r, fields, false));
  return { success: true, matches };
}

async function getFieldCounts(env, slug) {
  if (!slug) return { success: false, error: 'No slug' };
  const { fields } = await getFormFields(env, slug);
  const choiceFields = fields.filter(f => {
    const t = (f.type || '').toUpperCase();
    return t.includes('LIST') || t.includes('MULTIPLE_CHOICE') || t.includes('CHECKBOX');
  });
  if (!choiceFields.length) return { success: true, counts: {} };

  const { results } = await env.DB.prepare('SELECT values_json FROM submissions WHERE slug=?').bind(slug).all();
  const counts = {};
  choiceFields.forEach(f => counts[f.id] = {});
  for (const row of (results || [])) {
    let values = {};
    try { values = JSON.parse(row.values_json || '{}'); } catch (e) { continue; }
    choiceFields.forEach(f => {
      const val = values[f.id];
      if (val === undefined || val === null || val === '') return;
      const v = String(val).trim();
      if (!v) return;
      const vals = v.includes(',') ? v.split(',').map(s => s.trim()).filter(Boolean) : [v];
      vals.forEach(sv => { counts[f.id][sv] = (counts[f.id][sv] || 0) + 1; });
    });
  }
  return { success: true, counts };
}

// ─────────────────────────────────────────────────────────
// CSV EXPORT (replaces "open the spreadsheet")
// GET only, returns a raw CSV Response, requires admin password
// ?data={"action":"exportCsv","slug":"...","password":"..."}
// ─────────────────────────────────────────────────────────
async function exportCsv(env, slug, password) {
  if (password !== env.ADMIN_PASSWORD) return jsonOut({ success: false, error: 'Invalid password' });
  const { fields } = await getFormFields(env, slug);
  const { results } = await env.DB.prepare('SELECT * FROM submissions WHERE slug=? ORDER BY id ASC').bind(slug).all();
  const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const header = ['Timestamp', ...fields.map(f => f.title)].map(esc).join(',');
  const lines = (results || []).map(row => {
    let values = {};
    try { values = JSON.parse(row.values_json || '{}'); } catch (e) {}
    return [row.created_at, ...fields.map(f => values[f.id] ?? '')].map(esc).join(',');
  });
  const csv = [header, ...lines].join('\r\n');
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${slug}.csv"`, ...CORS },
  });
}

// ─────────────────────────────────────────────────────────
// UPLOAD PROXY — forwards to the original Apps Script deployment,
// which runs as your real Google account (has real Drive quota).
// Set env.GAS_UPLOAD_URL to that deployment's /exec URL.
// ─────────────────────────────────────────────────────────
async function proxyUploadFile(env, req) {
  if (!env.GAS_UPLOAD_URL) return { success: false, error: 'GAS_UPLOAD_URL secret not set' };
  try {
    const res = await fetch(env.GAS_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return await res.json();
  } catch (e) {
    return { success: false, error: 'Upload proxy failed: ' + String(e && e.message || e) };
  }
}

// ─────────────────────────────────────────────────────────
// GOOGLE DRIVE — service-account auth + upload (kept for future
// use if you switch to OAuth-based direct upload later; not
// called while proxyUploadFile is active above)
// ─────────────────────────────────────────────────────────
let _tokenCache = { token: null, exp: 0 };

function base64url(bytes) {
  let bin = '';
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToBinary(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getDriveAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache.token && _tokenCache.exp - 60 > now) return _tokenCache.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.GOOGLE_SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const enc = new TextEncoder();
  const signingInput = base64url(enc.encode(JSON.stringify(header))) + '.' + base64url(enc.encode(JSON.stringify(claim)));

  const privateKeyPem = env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n');
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBinary(privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput));
  const jwt = signingInput + '.' + base64url(sig);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Drive auth failed: ' + JSON.stringify(data));
  _tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

async function ensureDriveFolder(env, slug) {
  const row = await env.DB.prepare('SELECT drive_folder_id FROM forms WHERE slug=?').bind(slug).first();
  if (row && row.drive_folder_id) return row.drive_folder_id;

  const token = await getDriveAccessToken(env);
  const q = encodeURIComponent(`'${env.DRIVE_ROOT_FOLDER_ID}' in parents and name='${slug}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const searchData = await searchRes.json();
  let folderId = searchData.files && searchData.files[0] && searchData.files[0].id;

  if (!folderId) {
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: slug, mimeType: 'application/vnd.google-apps.folder', parents: [env.DRIVE_ROOT_FOLDER_ID] }),
    });
    const createData = await createRes.json();
    folderId = createData.id;
  }

  if (row) {
    await env.DB.prepare('UPDATE forms SET drive_folder_id=? WHERE slug=?').bind(folderId, slug).run();
  }
  return folderId;
}

async function uploadFile(env, data) {
  const { dataUrl, filename, slug, renameValue } = data;
  if (!dataUrl) return { success: false, error: 'No file data provided' };
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return { success: false, error: 'Invalid base64 data URL' };

  const mime = match[1];
  const b64 = match[2];
  const origName = filename || 'upload';
  const ext = origName.includes('.') ? origName.split('.').pop().toLowerCase() : 'bin';

  let finalName = origName;
  if (renameValue && String(renameValue).trim()) {
    const safe = String(renameValue).trim().replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, '_').substring(0, 80);
    finalName = safe + '.' + ext;
  }

  const token = await getDriveAccessToken(env);
  const folderId = await ensureDriveFolder(env, slug || 'misc');

  // Multipart upload: metadata + raw base64 bytes decoded to binary
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const boundary = 'printoforms_' + Date.now();
  const metadata = JSON.stringify({ name: finalName, parents: [folderId] });
  const enc = new TextEncoder();
  const parts = [
    enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    enc.encode(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes,
    enc.encode(`\r\n--${boundary}--`),
  ];
  const bodyLen = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(bodyLen);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.length; }

  const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const uploadData = await uploadRes.json();
  if (!uploadData.id) return { success: false, error: 'Drive upload failed: ' + JSON.stringify(uploadData) };
  const fileId = uploadData.id;

  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  return {
    success: true,
    url: 'https://drive.google.com/uc?export=view&id=' + fileId,
    viewUrl: 'https://drive.google.com/file/d/' + fileId + '/view',
    filename: finalName,
    fileId,
  };
}
