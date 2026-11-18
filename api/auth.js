// Autenticação: equipa interna (palavra-passe + 2FA opcional) e clientes da área reservada (código de acesso)
import { handler, json, fail, readBody, sql, loadCol, getDoc, upsertDocs, addLogs, sign, setCookie, staffSession, clientSession, hashPw, checkPw, randomCode, totpCheck, newTotpSecret, digits, clean } from './_lib.js';

const STAFF_TTL = 12 * 3600, CLI_TTL = 30 * 24 * 3600;
const pubUser = u => ({ id: u.id, nome: u.nome, funcao: u.funcao, email: u.email, mfa: !!u.mfa });

async function authRow(uid) { return (await sql`select * from auth where uid=${uid}`)[0] || null; }
async function locked(row) { return row && row.locked_until && new Date(row.locked_until) > new Date(); }
async function failAttempt(table, key, id) {
  if (table === 'auth') await sql`insert into auth(uid,failed) values(${id},1) on conflict(uid) do update set failed=auth.failed+1, locked_until=case when auth.failed+1>=5 then now()+interval '15 minutes' else auth.locked_until end`;
  else await sql`insert into cli_auth(cid,failed) values(${id},1) on conflict(cid) do update set failed=cli_auth.failed+1, locked_until=case when cli_auth.failed+1>=5 then now()+interval '15 minutes' else cli_auth.locked_until end`;
}

export default handler(async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Método não permitido');
  const b = readBody(req);
  const a = b.action;
  const me = staffSession(req);

  /* ----- equipa interna ----- */
  if (a === 'me') {
    if (!me) return json(res, 200, { ok: true, user: null });
    const u = await getDoc('equipa', me.uid);
    if (!u || !u.ativo) return json(res, 200, { ok: true, user: null });
    return json(res, 200, { ok: true, user: pubUser(u) });
  }
  if (a === 'login') {
    const email = clean(b.email, 160).toLowerCase();
    const eq = await loadCol('equipa');
    const u = eq.find(x => String(x.email || '').toLowerCase() === email && x.ativo);
    if (!u) return fail(res, 401, 'E-mail ou palavra-passe incorretos.');
    const row = await authRow(u.id);
    if (await locked(row)) return fail(res, 429, 'Demasiadas tentativas. Tente novamente dentro de 15 minutos.');
    if (!row || !row.pass_hash) return fail(res, 401, 'Este utilizador ainda não definiu palavra-passe. Use “Primeiro acesso” com o código que recebeu.');
    if (!checkPw(b.password, row.pass_hash)) { await failAttempt('auth', 'uid', u.id); return fail(res, 401, 'E-mail ou palavra-passe incorretos.'); }
    if (row.totp_secret) {
      if (!b.code) return json(res, 200, { ok: false, need2fa: true });
      if (!totpCheck(row.totp_secret, b.code)) { await failAttempt('auth', 'uid', u.id); return fail(res, 401, 'Código de verificação incorreto.'); }
    }
    await sql`update auth set failed=0, locked_until=null where uid=${u.id}`;
    setCookie(res, 'kst', sign({ t: 'staff', uid: u.id }, STAFF_TTL), STAFF_TTL);
    await addLogs(u.nome, 'Início de sessão');
    return json(res, 200, { ok: true, user: pubUser(u) });
  }
  if (a === 'logout') {
    if (me) { const u = await getDoc('equipa', me.uid); if (u) await addLogs(u.nome, 'Sessão terminada'); }
    setCookie(res, 'kst', '', 0);
    return json(res, 200, { ok: true });
  }
  if (a === 'first') { // primeiro acesso com código de convite (ou código de configuração inicial do administrador)
    const email = clean(b.email, 160).toLowerCase(), code = clean(b.code, 64).toUpperCase(), pw = String(b.password || '');
    if (pw.length < 8) return fail(res, 400, 'A palavra-passe deve ter pelo menos 8 caracteres.');
    const eq = await loadCol('equipa');
    const u = eq.find(x => String(x.email || '').toLowerCase() === email && x.ativo);
    if (!u) return fail(res, 401, 'E-mail ou código inválidos.');
    const row = await authRow(u.id);
    if (await locked(row)) return fail(res, 429, 'Demasiadas tentativas. Tente novamente dentro de 15 minutos.');
    const setup = process.env.SETUP_CODE && u.funcao === 'admin' && !(row && row.pass_hash) && code === String(process.env.SETUP_CODE).toUpperCase();
    const invite = row && row.invite_hash && (!row.invite_exp || new Date(row.invite_exp) > new Date()) && checkPw(code, row.invite_hash);
    if (!setup && !invite) { await failAttempt('auth', 'uid', u.id); return fail(res, 401, 'E-mail ou código inválidos.'); }
    await sql`insert into auth(uid,pass_hash) values(${u.id},${hashPw(pw)}) on conflict(uid) do update set pass_hash=excluded.pass_hash, invite_hash=null, invite_exp=null, failed=0, locked_until=null`;
    setCookie(res, 'kst', sign({ t: 'staff', uid: u.id }, STAFF_TTL), STAFF_TTL);
    await addLogs(u.nome, 'Palavra-passe definida no primeiro acesso');
    return json(res, 200, { ok: true, user: pubUser(u) });
  }
  if (!['client_login', 'client_logout', 'client_me'].includes(a) && !me) return fail(res, 401, 'Sessão expirada. Inicie sessão novamente.');
  const meU = me ? await getDoc('equipa', me.uid) : null;
  if (me && (!meU || !meU.ativo)) return fail(res, 401, 'Utilizador inativo.');

  if (a === 'password') {
    const row = await authRow(me.uid);
    if (!checkPw(b.old, row?.pass_hash)) return fail(res, 401, 'A palavra-passe atual está incorreta.');
    if (String(b.password || '').length < 8) return fail(res, 400, 'A nova palavra-passe deve ter pelo menos 8 caracteres.');
    await sql`update auth set pass_hash=${hashPw(b.password)} where uid=${me.uid}`;
    await addLogs(meU.nome, 'Palavra-passe alterada');
    return json(res, 200, { ok: true });
  }
  if (a === 'invite') { // administrador gera código de acesso (válido 7 dias) para um utilizador
    if (meU.funcao !== 'admin') return fail(res, 403, 'Apenas o administrador pode gerar códigos de acesso.');
    const u = await getDoc('equipa', clean(b.uid, 60));
    if (!u) return fail(res, 404, 'Utilizador não encontrado.');
    const code = randomCode(8);
    await sql`insert into auth(uid,invite_hash,invite_exp) values(${u.id},${hashPw(code)},now()+interval '7 days') on conflict(uid) do update set invite_hash=excluded.invite_hash, invite_exp=excluded.invite_exp`;
    if (b.reset) await sql`update auth set pass_hash=null, totp_secret=null where uid=${u.id}`;
    if (b.reset && u.mfa) { u.mfa = false; await upsertDocs([{ col: 'equipa', id: u.id, data: u }], meU.nome); }
    await addLogs(meU.nome, `Código de acesso gerado para ${u.nome}${b.reset ? ' (palavra-passe reposta)' : ''}`);
    return json(res, 200, { ok: true, code });
  }
  if (a === 'mfa_setup') {
    const secret = newTotpSecret();
    await sql`insert into auth(uid,totp_pending) values(${me.uid},${secret}) on conflict(uid) do update set totp_pending=excluded.totp_pending`;
    const issuer = 'Kianda Imobiliária';
    const uri = `otpauth://totp/${encodeURIComponent(issuer + ':' + meU.email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
    return json(res, 200, { ok: true, secret, uri });
  }
  if (a === 'mfa_confirm') {
    const row = await authRow(me.uid);
    if (!row?.totp_pending || !totpCheck(row.totp_pending, b.code)) return fail(res, 400, 'Código incorreto. Confirme a hora do telemóvel e tente de novo.');
    await sql`update auth set totp_secret=totp_pending, totp_pending=null where uid=${me.uid}`;
    meU.mfa = true; await upsertDocs([{ col: 'equipa', id: meU.id, data: meU }], meU.nome);
    await addLogs(meU.nome, 'Autenticação de dois fatores ativada');
    return json(res, 200, { ok: true });
  }
  if (a === 'mfa_disable') {
    const target = b.uid && meU.funcao === 'admin' ? clean(b.uid, 60) : me.uid;
    if (target === me.uid) { const row = await authRow(me.uid); if (!checkPw(b.password, row?.pass_hash)) return fail(res, 401, 'Palavra-passe incorreta.'); }
    await sql`update auth set totp_secret=null, totp_pending=null where uid=${target}`;
    const u = await getDoc('equipa', target); if (u) { u.mfa = false; await upsertDocs([{ col: 'equipa', id: u.id, data: u }], meU.nome); }
    await addLogs(meU.nome, `Autenticação de dois fatores desativada — ${u ? u.nome : target}`);
    return json(res, 200, { ok: true });
  }
  if (a === 'auth_status') { // estado de acesso de cada utilizador (só administrador)
    if (meU.funcao !== 'admin') return fail(res, 403, 'Sem permissão.');
    const rows = await sql`select uid, (pass_hash is not null) as pw, (totp_secret is not null) as mfa, (invite_hash is not null and (invite_exp is null or invite_exp>now())) as invite from auth`;
    return json(res, 200, { ok: true, rows });
  }
  if (a === 'client_invite') { // equipa gera código de acesso à área reservada (válido 30 dias)
    const c = await getDoc('clientes', clean(b.cid, 60));
    if (!c) return fail(res, 404, 'Cliente não encontrado.');
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await sql`insert into cli_auth(cid,code_hash,code_exp) values(${c.id},${hashPw(code)},now()+interval '30 days') on conflict(cid) do update set code_hash=excluded.code_hash, code_exp=excluded.code_exp, failed=0, locked_until=null`;
    await addLogs(meU.nome, `Código de acesso à área reservada gerado para ${c.nome}`);
    return json(res, 200, { ok: true, code });
  }

  /* ----- clientes (área reservada) ----- */
  if (a === 'client_me') {
    const s = clientSession(req);
    if (!s) return json(res, 200, { ok: true, client: null });
    const c = await getDoc('clientes', s.cid);
    return json(res, 200, { ok: true, client: c ? { id: c.id, nome: c.nome } : null });
  }
  if (a === 'client_login') {
    const login = clean(b.login, 160).toLowerCase(), code = clean(b.code, 12);
    const cls = await loadCol('clientes');
    const d = digits(login);
    const c = cls.find(x => (login.includes('@') && String(x.email || '').toLowerCase() === login) || (d.length >= 9 && digits(x.tel).endsWith(d.slice(-9))));
    if (!c) return fail(res, 401, 'Dados de acesso incorretos.');
    const row = (await sql`select * from cli_auth where cid=${c.id}`)[0];
    if (row && row.locked_until && new Date(row.locked_until) > new Date()) return fail(res, 429, 'Demasiadas tentativas. Tente novamente dentro de 15 minutos.');
    if (!row || !row.code_hash || (row.code_exp && new Date(row.code_exp) < new Date()) || !checkPw(code, row.code_hash)) { await failAttempt('cli_auth', 'cid', c.id); return fail(res, 401, 'Dados de acesso incorretos. Peça um novo código ao seu corretor.'); }
    await sql`update cli_auth set failed=0, locked_until=null where cid=${c.id}`;
    setCookie(res, 'kcl', sign({ t: 'cli', cid: c.id }, CLI_TTL), CLI_TTL);
    await addLogs('Cliente: ' + c.nome, 'Entrada na área reservada');
    return json(res, 200, { ok: true, client: { id: c.id, nome: c.nome } });
  }
  if (a === 'client_logout') { setCookie(res, 'kcl', '', 0); return json(res, 200, { ok: true }); }
  return fail(res, 400, 'Pedido inválido.');
});
