// Área reservada: cada cliente vê apenas o que lhe diz respeito
import { handler, json, fail, readBody, sql, loadAll, getDoc, upsertDocs, addLogs, clientSession, publicProp, publicTeam, publicCfg, isPublicProp, clean, uid, today } from './_lib.js';

export default handler(async (req, res) => {
  const s = clientSession(req);
  if (!s) return fail(res, 401, 'Sessão expirada. Entre novamente na área reservada.');
  const c = await getDoc('clientes', s.cid);
  if (!c) return fail(res, 401, 'Cliente não encontrado.');

  if (req.method === 'GET') {
    const A = await loadAll();
    const own = A.props.filter(p => p.proprietarioId === c.id);
    const ownIds = new Set(own.map(p => p.id));
    const arr = A.arrend.filter(a => a.inquilinoId === c.id || a.proprietarioId === c.id);
    const arrProps = new Set(arr.map(a => a.propId));
    const propIds = new Set([...ownIds, ...arrProps]);
    const anon = x => x.clienteId === c.id ? x : { ...x, clienteId: '' };
    const visitas = A.visitas.filter(v => v.clienteId === c.id || ownIds.has(v.propId)).map(anon);
    const propostas = A.propostas.filter(x => x.clienteId === c.id || ownIds.has(x.propId)).map(x => ({ id: x.id, propId: x.propId, clienteId: x.clienteId === c.id ? c.id : '', valor: x.valor, moeda: x.moeda, estado: x.estado, reservaAte: x.reservaAte, criado: x.criado, fechadoEm: x.fechadoEm, historico: (x.historico || []).map(h => ({ d: h.d, autor: h.autor, valor: h.valor, nota: h.nota })), docs: x.clienteId === c.id ? (x.docs || []).map(d => ({ id: d.id, nome: d.nome, ok: d.ok })) : [], split: [], chaves: {} }));
    // imóveis: catálogo público + os do próprio cliente (proprietário ou arrendatário)
    const pub = A.props.filter(isPublicProp).map(publicProp);
    const mine = A.props.filter(p => propIds.has(p.id)).map(p => ({ ...p, docs: (p.docs || []).filter(d => !d.privado) }));
    const props = [...mine, ...pub.filter(p => !propIds.has(p.id))];
    // outras pessoas: só o nome (ex.: arrendatário dos imóveis em gestão)
    const others = new Set(arr.flatMap(a => [a.inquilinoId, a.proprietarioId]).filter(id => id !== c.id));
    const clientes = [c, ...A.clientes.filter(x => others.has(x.id)).map(x => ({ id: x.id, nome: x.nome, tipos: x.tipos, tel: '', email: '', pref: {}, notas: [], tarefas: [], apresentados: [], favs: [] }))];
    const S = {
      props, clientes, visitas, propostas,
      arrend: arr.map(a => a.proprietarioId === c.id ? a : { ...a, comGestao: 0 }),
      manut: A.manut.filter(m => propIds.has(m.propId)),
      despesas: A.despesas.filter(e => ownIds.has(e.propId) && e.imputar === 'proprietario'),
      custos: [], fornecedores: A.fornecedores.map(f => ({ id: f.id, nome: f.nome, area: f.area, tel: '' })),
      equipa: publicTeam(A.equipa), cfg: publicCfg(A.cfg), log: []
    };
    return json(res, 200, { ok: true, S, client: { id: c.id, nome: c.nome } });
  }
  if (req.method !== 'POST') return fail(res, 405, 'Método não permitido');
  const b = readBody(req);
  if (b.action === 'favs') {
    c.favs = (Array.isArray(b.favs) ? b.favs : []).map(x => clean(x, 60)).filter(Boolean).slice(0, 100);
    await upsertDocs([{ col: 'clientes', id: c.id, data: c }], 'Cliente: ' + c.nome);
    return json(res, 200, { ok: true });
  }
  if (b.action === 'manut') {
    const a = await getDoc('arrend', clean(b.arrId, 60));
    if (!a || a.inquilinoId !== c.id) return fail(res, 403, 'Contrato não encontrado.');
    const desc = clean(b.desc, 1000);
    if (!desc) return fail(res, 400, 'Descreva o problema.');
    const id = uid('m');
    await upsertDocs([{ col: 'manut', id, data: { id, propId: a.propId, arrId: a.id, d: today(), desc, origem: 'inquilino', fornecedorId: '', estado: 'aberto', custo: null, moeda: a.moeda, notas: '' } }], 'Cliente: ' + c.nome);
    const p = await getDoc('props', a.propId);
    await addLogs('Cliente: ' + c.nome, `Pedido de manutenção do arrendatário — ${p ? p.ref : a.propId}`);
    return json(res, 200, { ok: true });
  }
  return fail(res, 400, 'Pedido inválido.');
});
