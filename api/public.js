// Portal público: catálogo (sem dados privados) e pedidos dos visitantes
import { handler, json, fail, readBody, sql, loadCol, getDoc, upsertDocs, addLogs, publicProp, publicTeam, publicCfg, isPublicProp, digits, clean, uid, today } from './_lib.js';

const VIS_DUR = 60;
const hm = h => { const [a, b] = String(h || '0:0').split(':').map(Number); return (a || 0) * 60 + (b || 0); };

export default handler(async (req, res) => {
  if (req.method === 'GET') {
    const [props, equipa, visitas, cfgR] = await Promise.all([loadCol('props'), loadCol('equipa'), loadCol('visitas'), sql`select v from cfg where k='cfg'`]);
    const T = today();
    const busy = visitas.filter(v => v.estado !== 'cancelada' && v.data >= T).map(v => ({ id: 'b' + v.id, propId: v.propId, corretorId: v.corretorId, data: v.data, hora: v.hora, estado: 'agendada' }));
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, { ok: true, props: props.filter(isPublicProp).map(publicProp), equipa: publicTeam(equipa), busy, cfg: publicCfg(cfgR[0]?.v || {}) });
  }
  if (req.method !== 'POST') return fail(res, 405, 'Método não permitido');
  const b = readBody(req);
  if (b.website) return json(res, 200, { ok: true }); // campo-armadilha para robôs
  const nome = clean(b.nome, 120), tel = clean(b.tel, 40), email = clean(b.email, 160);
  if (!nome || digits(tel).length < 9) return fail(res, 400, 'Indique o nome e um telefone válido.');
  const action = b.action;
  const equipa = await loadCol('equipa');
  const clientes = await loadCol('clientes');
  const changes = [];
  const autoCorretor = () => {
    const cs = equipa.filter(u => u.ativo && u.funcao === 'corretor');
    if (!cs.length) return (equipa.find(u => u.funcao === 'admin') || equipa[0] || {}).id || '';
    const n = u => clientes.filter(c => c.corretorId === u.id && !['concluido', 'perdido'].includes(c.etapa)).length;
    return cs.sort((a, c) => n(a) - n(c))[0].id;
  };
  const lead = ({ tipos, pref, nota, corretorId, origem = 'site' }) => {
    const t = digits(tel);
    let c = clientes.find(x => digits(x.tel) === t);
    if (!c) {
      c = { id: uid('c'), nome, tel, email, nif: '', tipos: tipos || ['comprador'], origem, corretorId: corretorId || autoCorretor(), etapa: 'novo', pref: pref || {}, notas: [], tarefas: [], apresentados: [], favs: [], proxContacto: today(), criado: today() };
      clientes.push(c);
    } else {
      (tipos || []).forEach(x => { if (!c.tipos.includes(x)) c.tipos.push(x); });
      if (pref && !Object.keys(c.pref || {}).length) c.pref = pref;
      if (c.etapa === 'perdido') c.etapa = 'novo';
      if (!c.email && email) c.email = email;
    }
    c.notas = c.notas || []; c.tarefas = c.tarefas || [];
    if (nota) c.notas.unshift({ d: new Date(Date.now() + 3600e3).toISOString().slice(0, 16), t: nota, u: 'Portal' });
    c.tarefas.push({ id: uid('t'), d: today(), t: 'Responder ao contacto: ' + (nota || 'novo lead').slice(0, 80), feito: false });
    changes.push({ col: 'clientes', id: c.id, data: c });
    return c;
  };
  const nomeCor = id => (equipa.find(u => u.id === id) || {}).nome || 'A nossa equipa';

  if (action === 'info' || action === 'visita') {
    const p = await getDoc('props', clean(b.propId, 60));
    if (!p || !isPublicProp(p)) return fail(res, 404, 'Imóvel não encontrado.');
    let visita = null;
    if (action === 'visita') {
      const data = clean(b.data, 10), hora = clean(b.hora, 5);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}$/.test(hora)) return fail(res, 400, 'Escolha a data e a hora da visita.');
      const T = today();
      if (data < T) return fail(res, 400, 'Escolha uma data futura.');
      const vis = await loadCol('visitas');
      const conf = vis.some(x => x.estado !== 'cancelada' && x.data === data && Math.abs(hm(x.hora) - hm(hora)) < VIS_DUR && (x.corretorId === p.corretorId || x.propId === p.id));
      if (conf) return fail(res, 409, 'Esse horário já está ocupado. Escolha outro horário disponível.');
      visita = { data, hora };
    }
    const msg = clean(b.msg, 1000);
    const c = lead({ tipos: [p.finalidade === 'arrendamento' ? 'arrendatario' : 'comprador'], corretorId: p.corretorId, nota: (action === 'visita' ? 'Pedido de visita' : 'Pedido de informação') + ' — ' + p.ref + ': ' + msg, pref: { finalidade: p.finalidade, tipo: p.tipo, zonas: p.bairro, tipologia: p.tipologia, moeda: p.moeda } });
    const vid = uid('v');
    if (visita) changes.push({ col: 'visitas', id: vid, data: { id: vid, propId: p.id, clienteId: c.id, corretorId: p.corretorId, data: visita.data, hora: visita.hora, estado: 'pedido', lembrete: false, notas: msg } });
    await upsertDocs(changes, 'Portal público');
    await addLogs('Portal público', `${action === 'visita' ? 'Pedido de visita' : 'Pedido de informação'} (site) — ${p.ref} por ${c.nome}`);
    return json(res, 200, { ok: true, corretor: nomeCor(p.corretorId) });
  }
  if (action === 'procuro') {
    const pref = { finalidade: b.finalidade === 'arrendamento' ? 'arrendamento' : 'venda', tipo: clean(b.tipo, 20), tipologia: clean(b.tipologia, 10), zonas: clean(b.zonas || b.provincia, 200), orcMax: Number(b.orcMax) || null, moeda: ['AKZ', 'USD', 'EUR'].includes(b.moeda) ? b.moeda : 'AKZ', prazo: clean(b.prazo, 40) };
    const c = lead({ tipos: [pref.finalidade === 'arrendamento' ? 'arrendatario' : 'comprador'], pref, nota: 'Formulário “Procuro um imóvel”' + (b.obs ? ': ' + clean(b.obs, 800) : '') });
    c.pref = pref;
    await upsertDocs(changes, 'Portal público');
    await addLogs('Portal público', 'Novo pedido “Procuro um imóvel” — ' + c.nome);
    return json(res, 200, { ok: true, corretor: nomeCor(c.corretorId) });
  }
  if (action === 'vender') {
    const fin = b.finalidade === 'arrendamento' ? 'arrendamento' : 'venda';
    const c = lead({ tipos: ['proprietario'], nota: `Formulário “Quero ${fin === 'venda' ? 'vender' : 'arrendar'}”${b.gestao === 'sim' ? ' — pede gestão mensal do arrendamento' : ''}` });
    const props = await loadCol('props');
    const ref = 'IMO-' + String(Math.max(0, ...props.map(p => +String(p.ref || '').replace(/\D/g, '') || 0)) + 1).padStart(4, '0');
    const TIPOS = { apartamento: 'Apartamento', moradia: 'Moradia', terreno: 'Terreno', escritorio: 'Escritório', loja: 'Loja', armazem: 'Armazém' };
    const tipo = TIPOS[b.tipo] ? b.tipo : 'apartamento';
    const p = { id: uid('p'), ref, titulo: `${TIPOS[tipo]} ${clean(b.tipologia, 10)} ${b.bairro ? 'em ' + clean(b.bairro, 60) : ''}`.replace(/\s+/g, ' ').trim(), desc: clean(b.desc, 2000), tipo, finalidade: fin, estado: 'em_preparacao', publicado: false, provincia: clean(b.provincia, 40) || 'Luanda', municipio: clean(b.municipio, 60), bairro: clean(b.bairro, 60), morada: '', moradaPublica: false, lat: null, lng: null, preco: Number(b.preco) || 0, moeda: ['AKZ', 'USD', 'EUR'].includes(b.moeda) ? b.moeda : 'AKZ', condicoes: '', caucao: '', encargos: '', tipologia: clean(b.tipologia, 10), area: Number(b.area) || null, areaTerreno: null, quartos: null, wc: null, estac: null, caract: [], video: '', tour: '', planta: false, imgs: [], proprietarioId: c.id, corretorId: c.corretorId, docs: [], criado: today(), vendidoEm: '' };
    c.tarefas.push({ id: uid('t'), d: today(), t: 'Marcar visita de avaliação — ' + ref, feito: false });
    changes.push({ col: 'props', id: p.id, data: p });
    await upsertDocs(changes, 'Portal público');
    await addLogs('Portal público', `Novo imóvel captado pelo site (${ref}) — ${c.nome}`);
    return json(res, 200, { ok: true, ref, corretor: nomeCor(c.corretorId) });
  }
  return fail(res, 400, 'Pedido inválido.');
});
