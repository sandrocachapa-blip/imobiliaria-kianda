// Utilitários partilhados pelas funções /api (Vercel Node.js)
import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export const sql = globalThis.__SQL__ || neon(process.env.DATABASE_URL);
const SECRET = process.env.AUTH_SECRET || '';
export const COLS = ['equipa', 'clientes', 'props', 'visitas', 'propostas', 'arrend', 'despesas', 'custos', 'manut', 'fornecedores'];

/* ---------- respostas ---------- */
export function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
export const fail = (res, code, msg) => json(res, code, { ok: false, error: msg });
export function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { return {}; } }
  return {};
}
export function handler(fn) {
  return async (req, res) => {
    try {
      if (!SECRET || SECRET.length < 32) return fail(res, 500, 'Servidor sem AUTH_SECRET configurado.');
      await ensureSchema();
      await fn(req, res);
    } catch (e) {
      console.error(e);
      fail(res, 500, 'Erro interno do servidor.');
    }
  };
}

/* ---------- sessões (token assinado em cookie HttpOnly) ---------- */
export function sign(payload, ttlSec) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
export function verify(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [b, m] = tok.split('.');
  if (!b || !m) return null;
  const mac = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (mac.length !== m.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(m))) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch { return null; }
}
export function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return o;
}
export function setCookie(res, name, val, maxAge) {
  const prev = res.getHeader('Set-Cookie');
  const c = `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
export function staffSession(req) { const p = verify(cookies(req).kst); return p && p.t === 'staff' ? p : null; }
export function clientSession(req) { const p = verify(cookies(req).kcl); return p && p.t === 'cli' ? p : null; }

/* ---------- palavras-passe e códigos ---------- */
export function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
export function checkPw(pw, stored) {
  if (!stored || !pw) return false;
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const x = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
  const y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function randomCode(len = 8) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(len);
  return Array.from(b, x => A[x % A.length]).join('');
}
export const digits = t => String(t || '').replace(/\D/g, '');
export const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);

/* ---------- TOTP (autenticação de dois fatores, compatível com Google/Microsoft Authenticator) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  s = String(s).replace(/=+$/, '').toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totpAt(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6;
  return String(code).padStart(6, '0');
}
export function totpCheck(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const c = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some(d => totpAt(secret, c + d) === String(code));
}
export const newTotpSecret = () => b32encode(crypto.randomBytes(20));

/* ---------- base de dados ---------- */
let schemaP = null;
export function ensureSchema() {
  if (!schemaP) schemaP = (async () => {
    await sql`create table if not exists docs(col text not null, id text not null, data jsonb not null, updated_at timestamptz not null default now(), updated_by text, primary key(col,id))`;
    await sql`create table if not exists cfg(k text primary key, v jsonb not null)`;
    await sql`create table if not exists auth(uid text primary key, pass_hash text, invite_hash text, invite_exp timestamptz, totp_secret text, totp_pending text, failed int not null default 0, locked_until timestamptz)`;
    await sql`create table if not exists cli_auth(cid text primary key, code_hash text, code_exp timestamptz, failed int not null default 0, locked_until timestamptz)`;
    await sql`create table if not exists logs(id bigserial primary key, d timestamptz not null default now(), u text, a text)`;
    await sql`create index if not exists logs_d on logs(d desc)`;
    await seedIfEmpty();
  })().catch(e => { schemaP = null; throw e; });
  return schemaP;
}
async function seedIfEmpty() {
  const r = await sql`select count(*)::int as n from docs`;
  if (r[0].n > 0) return;
  const SEED = require('./_seed.json');
  const rows = [];
  for (const col of COLS) for (const d of (SEED[col] || [])) rows.push({ col, id: d.id, data: d });
  await sql`insert into docs(col,id,data,updated_by) select x->>'col', x->>'id', x->'data', 'Sistema' from jsonb_array_elements(${JSON.stringify(rows)}::jsonb) x on conflict do nothing`;
  await sql`insert into cfg(k,v) values('cfg', ${JSON.stringify(SEED.cfg || {})}::jsonb) on conflict do nothing`;
  await sql`insert into logs(u,a) values('Sistema','Base de dados criada com os dados iniciais')`;
}
export async function loadAll() {
  const r = await sql`select col, data from docs`;
  const S = {}; for (const c of COLS) S[c] = [];
  for (const x of r) if (S[x.col]) S[x.col].push(x.data);
  const c = await sql`select v from cfg where k='cfg'`;
  S.cfg = c[0]?.v || {};
  return S;
}
export async function loadCol(col) { return (await sql`select data from docs where col=${col}`).map(x => x.data); }
export async function getDoc(col, id) { const r = await sql`select data from docs where col=${col} and id=${id}`; return r[0]?.data || null; }
export async function upsertDocs(rows, by) {
  if (!rows.length) return;
  await sql`insert into docs(col,id,data,updated_by) select x->>'col', x->>'id', x->'data', ${by} from jsonb_array_elements(${JSON.stringify(rows)}::jsonb) x
    on conflict (col,id) do update set data=excluded.data, updated_at=now(), updated_by=excluded.updated_by`;
}
export async function deleteDocs(rows) {
  if (!rows.length) return;
  await sql`delete from docs d using jsonb_array_elements(${JSON.stringify(rows)}::jsonb) x where d.col=x->>'col' and d.id=x->>'id'`;
}
export async function addLogs(u, list) {
  const a = (Array.isArray(list) ? list : [list]).map(x => clean(x, 1000)).filter(Boolean).slice(0, 200);
  if (!a.length) return;
  await sql`insert into logs(u,a) select ${u}, v from jsonb_array_elements_text(${JSON.stringify(a)}::jsonb) v`;
}
export const uid = p => p + Date.now().toString(36).slice(-4) + crypto.randomBytes(3).toString('hex');
export const today = () => new Date(Date.now() + 3600e3).toISOString().slice(0, 10); // hora de Luanda (UTC+1)

/* ---------- vistas públicas (sem dados privados) ---------- */
export function publicProp(p) {
  const { docs, proprietarioId, morada, ...rest } = p;
  return { ...rest, morada: p.moradaPublica ? morada : '', docs: [] };
}
export const publicTeam = eq => eq.filter(u => u.ativo).map(u => ({ id: u.id, nome: u.nome, tel: u.tel, funcao: u.funcao === 'corretor' ? 'corretor' : u.funcao === 'admin' ? 'admin' : 'outro', ativo: true }));
export const publicCfg = c => ({ empresa: c.empresa, whatsapp: c.whatsapp, email: c.email, cambio: c.cambio || {}, comVenda: c.comVenda, comArr: c.comArr });
export const isPublicProp = p => p.publicado && ['disponivel', 'reservado'].includes(p.estado) && p.finalidade !== 'procura';
