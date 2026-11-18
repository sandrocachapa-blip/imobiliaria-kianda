// Dados da gestão interna (apenas utilizadores da equipa com sessão iniciada)
import { handler, json, fail, readBody, sql, loadAll, getDoc, upsertDocs, deleteDocs, addLogs, staffSession, COLS } from './_lib.js';

const ADMIN_ONLY = new Set(['equipa']);

export default handler(async (req, res) => {
  const me = staffSession(req);
  if (!me) return fail(res, 401, 'Sessão expirada. Inicie sessão novamente.');
  const u = await getDoc('equipa', me.uid);
  if (!u || !u.ativo) return fail(res, 401, 'Utilizador inativo.');

  if (req.method === 'GET') {
    const S = await loadAll();
    const lg = await sql`select d, u, a from logs order by id desc limit 800`;
    S.log = lg.map(x => ({ d: new Date(x.d).toISOString(), u: x.u, a: x.a }));
    return json(res, 200, { ok: true, S, me: { id: u.id, nome: u.nome, funcao: u.funcao, email: u.email, mfa: !!u.mfa } });
  }
  if (req.method !== 'POST') return fail(res, 405, 'Método não permitido');
  const b = readBody(req);
  const ups = Array.isArray(b.upserts) ? b.upserts : [], dels = Array.isArray(b.deletes) ? b.deletes : [];
  if (ups.length + dels.length > 2000) return fail(res, 413, 'Demasiadas alterações num só pedido.');
  for (const x of [...ups, ...dels]) {
    if (!COLS.includes(x.col) || typeof x.id !== 'string' || !x.id) return fail(res, 400, 'Alteração inválida.');
    if (ADMIN_ONLY.has(x.col) && u.funcao !== 'admin') return fail(res, 403, 'Apenas o administrador pode alterar a equipa.');
  }
  for (const x of ups) {
    if (!x.data || typeof x.data !== 'object' || x.data.id !== x.id) return fail(res, 400, 'Documento inválido.');
  }
  if (b.cfg && u.funcao !== 'admin') return fail(res, 403, 'Apenas o administrador pode alterar as configurações.');
  // nunca deixar a equipa sem administrador ativo
  if (ups.some(x => x.col === 'equipa') || dels.some(x => x.col === 'equipa')) {
    const eq = (await sql`select data from docs where col='equipa'`).map(r => r.data);
    const m = new Map(eq.map(e => [e.id, e]));
    ups.filter(x => x.col === 'equipa').forEach(x => m.set(x.id, x.data));
    dels.filter(x => x.col === 'equipa').forEach(x => m.delete(x.id));
    if (![...m.values()].some(e => e.ativo && e.funcao === 'admin')) return fail(res, 400, 'Tem de existir pelo menos um administrador ativo.');
  }
  await upsertDocs(ups.map(x => ({ col: x.col, id: x.id, data: x.data })), u.nome);
  await deleteDocs(dels.map(x => ({ col: x.col, id: x.id })));
  if (b.cfg && typeof b.cfg === 'object') await sql`insert into cfg(k,v) values('cfg',${JSON.stringify(b.cfg)}::jsonb) on conflict(k) do update set v=excluded.v`;
  if (Array.isArray(b.logs)) await addLogs(u.nome, b.logs);
  return json(res, 200, { ok: true });
});
