/* =====================================================================
   MODO SERVIDOR (Vercel + Neon): substitui o armazenamento local por API
   ===================================================================== */
(function () {
  if (!window.KIANDA_API) return;
  let MODE = 'public', SNAP = null, PENDING_LOGS = [], SYNC_T = null, SYNCING = false;
  const SYNC_COLS = ['equipa', 'clientes', 'props', 'visitas', 'propostas', 'arrend', 'despesas', 'custos', 'manut', 'fornecedores'];
  window.apiMode = () => MODE;

  async function api(path, body) {
    let r, j = {};
    try {
      r = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
      try { j = await r.json(); } catch (e) { j = {}; }
      if (!r.ok && !j.error) j.error = 'Erro do servidor (' + r.status + ')';
      j.status = r.status;
    } catch (e) { j = { ok: false, error: 'Sem ligação à internet ou ao servidor.', status: 0 }; }
    return j;
  }
  window.api = api;
  const loadFavs = () => { try { return JSON.parse(localStorage.getItem('kianda_favs') || '[]'); } catch (e) { return []; } };
  const saveFavs = () => { try { localStorage.setItem('kianda_favs', JSON.stringify(S.favsAnon || [])); } catch (e) { } };
  function blankS() { return { versao: 4, equipa: [], clientes: [], props: [], visitas: [], propostas: [], arrend: [], despesas: [], custos: [], manut: [], fornecedores: [], cfg: { empresa: 'Kianda Imobiliária', whatsapp: '', email: '', cambio: { USD: 920, EUR: 1000 }, comVenda: 5, comArr: 100 }, favsAnon: loadFavs(), log: [] }; }
  function snapOf() { const o = {}; SYNC_COLS.forEach(c => { o[c] = {}; (S[c] || []).forEach(d => { if (d && d.id) o[c][d.id] = JSON.stringify(d); }); }); o.cfg = JSON.stringify(S.cfg || {}); return o; }
  async function loadPublic() { const j = await api('/api/public'); if (!j.ok) { toast(j.error || 'Não foi possível carregar os imóveis.'); return false; } S = blankS(); S.props = j.props; S.equipa = j.equipa; S.visitas = j.busy; S.cfg = { ...S.cfg, ...j.cfg }; MODE = 'public'; SNAP = null; return true; }
  async function loadStaff() { const j = await api('/api/data'); if (!j.ok) return false; S = { ...blankS(), ...j.S, favsAnon: loadFavs() }; SNAP = snapOf(); MODE = 'staff'; V.int.user = j.me.id; window.ME = j.me; return true; }
  async function loadClient() { const j = await api('/api/client'); if (!j.ok) return false; S = { ...blankS(), ...j.S }; MODE = 'client'; V.res.cli = j.client.id; return true; }
  window.loadPublic = loadPublic; window.loadStaff = loadStaff; window.loadClient = loadClient;

  /* ---------- gravação ---------- */
  function setSync(t, cls) { const el = document.getElementById('syncst'); if (el) { el.textContent = t; el.style.color = cls === 'bad' ? 'var(--bad)' : ''; } }
  function diff() {
    const cur = snapOf(), ups = [], dels = [];
    SYNC_COLS.forEach(c => { const a = SNAP[c] || {}, b = cur[c]; for (const id in b) if (a[id] !== b[id]) ups.push({ col: c, id, data: JSON.parse(b[id]) }); for (const id in a) if (!(id in b)) dels.push({ col: c, id }); });
    return { cur, ups, dels, cfgCh: cur.cfg !== SNAP.cfg };
  }
  const hasPending = () => MODE === 'staff' && SNAP && (PENDING_LOGS.length || SYNCING || (() => { const d = diff(); return d.ups.length || d.dels.length || d.cfgCh; })());
  function scheduleSync() { if (MODE !== 'staff' || !SNAP) return; clearTimeout(SYNC_T); SYNC_T = setTimeout(syncNow, 350); setSync('● por guardar'); }
  async function syncNow() {
    if (SYNCING) { scheduleSync(); return; }
    const { cur, ups, dels, cfgCh } = diff(); const logs = PENDING_LOGS.splice(0);
    if (!ups.length && !dels.length && !cfgCh && !logs.length) { setSync('✓ guardado'); return; }
    SYNCING = true; setSync('A guardar…');
    const j = await api('/api/data', { upserts: ups, deletes: dels, cfg: cfgCh ? S.cfg : undefined, logs });
    SYNCING = false;
    if (j.ok) { ups.forEach(x => { SNAP[x.col][x.id] = cur[x.col][x.id]; }); dels.forEach(x => { delete SNAP[x.col][x.id]; }); if (cfgCh) SNAP.cfg = cur.cfg; setSync('✓ guardado'); return; }
    if (j.status === 401) { toast('A sessão terminou. Inicie sessão novamente — as últimas alterações não foram guardadas.'); V.int.user = null; await loadPublic(); render(); return; }
    if (j.status === 400 || j.status === 403 || j.status === 413) { toast('Alteração recusada: ' + j.error); await loadStaff(); render(); return; }
    PENDING_LOGS.unshift(...logs); setSync('⚠ erro ao guardar — a tentar de novo', 'bad'); toast('Não foi possível guardar (' + j.error + '). Vai tentar de novo automaticamente.'); setTimeout(scheduleSync, 5000);
  }
  window.save = function () { if (MODE === 'staff') scheduleSync(); else if (MODE === 'public') saveFavs(); };
  window.log = function (a) { S.log = S.log || []; S.log.unshift({ d: new Date().toISOString(), u: actor(), a }); if (S.log.length > 800) S.log.length = 800; if (MODE === 'staff') PENDING_LOGS.push(a); save(); };
  window.addEventListener('beforeunload', e => { if (hasPending()) { e.preventDefault(); e.returnValue = ''; } });
  // atualização periódica dos dados partilhados (quando não há nada por guardar e ninguém está a escrever)
  setInterval(async () => {
    if (MODE !== 'staff' || document.visibilityState !== 'visible' || $('.mbg') || hasPending()) return;
    const ae = document.activeElement; if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
    if (await loadStaff() && !$('.mbg')) render();
  }, 60000);

  /* ---------- login da equipa ---------- */
  window.loginScreen = function () {
    const L = V.int.login || {};
    let body;
    if (L.step === 'mfa') body = `<p class="mut">Introduza o código de 6 dígitos da aplicação de autenticação (Google ou Microsoft Authenticator).</p><input id="lgCode" inputmode="numeric" maxlength="6" placeholder="000000" onkeydown="if(event.key==='Enter')apiLogin()"><button class="btn gold" onclick="apiLogin()">Verificar</button><button class="btn ghost" onclick="V.int.login={};render()">Voltar</button>`;
    else if (L.step === 'first') body = `<p class="mut sm">Primeiro acesso: use o código que recebeu do administrador e escolha a sua palavra-passe (mínimo 8 caracteres).</p><div><label>E-mail</label><input id="lgEmail" type="email" value="${esc(L.email || '')}"></div><div><label>Código de acesso</label><input id="lgInv" autocomplete="one-time-code" style="text-transform:uppercase"></div><div><label>Nova palavra-passe</label><input id="lgPw1" type="password" autocomplete="new-password"></div><div><label>Repetir palavra-passe</label><input id="lgPw2" type="password" autocomplete="new-password" onkeydown="if(event.key==='Enter')apiFirst()"></div><button class="btn gold" onclick="apiFirst()">Definir palavra-passe e entrar</button><button class="btn ghost" onclick="V.int.login={};render()">Voltar</button>`;
    else body = `<div><label>E-mail</label><input id="lgEmail" type="email" autocomplete="username" value="${esc(L.email || '')}"></div><div><label>Palavra-passe</label><input id="lgPass" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')apiLogin()"></div><button class="btn gold" onclick="apiLogin()">Entrar</button><p class="sm" style="text-align:center;margin:4px 0 0"><a onclick="V.int.login={step:'first',email:($('#lgEmail')||{}).value||''};render()">Primeiro acesso / tenho um código</a></p>`;
    return `<div class="login"><div class="card"><div class="bigic">${logoIcon()}</div><p style="text-align:center;margin:0 0 14px"><span class="eyebrow">Área interna</span></p><div class="grid">${body}</div><p style="margin-top:18px;text-align:center"><a onclick="go('portal','home')">← Voltar ao portal</a></p></div></div>`;
  };
  window.apiLogin = async function () {
    const L = V.int.login || {};
    if (L.step !== 'mfa') { L.email = $('#lgEmail').value.trim(); L.password = $('#lgPass').value; }
    const j = await api('/api/auth', { action: 'login', email: L.email, password: L.password, code: L.step === 'mfa' ? $('#lgCode').value.trim() : undefined });
    if (j.need2fa) { V.int.login = { ...L, step: 'mfa' }; render(); setTimeout(() => { const e = $('#lgCode'); e && e.focus(); }, 30); return; }
    if (!j.ok) { toast(j.error); return; }
    V.int.login = {}; await afterStaffLogin();
  };
  window.apiFirst = async function () {
    const email = $('#lgEmail').value.trim(), code = $('#lgInv').value.trim(), p1 = $('#lgPw1').value, p2 = $('#lgPw2').value;
    if (p1.length < 8) { toast('A palavra-passe deve ter pelo menos 8 caracteres.'); return; }
    if (p1 !== p2) { toast('As palavras-passe não coincidem.'); return; }
    const j = await api('/api/auth', { action: 'first', email, code, password: p1 });
    if (!j.ok) { toast(j.error); return; }
    V.int.login = {}; toast('Palavra-passe definida. Bem-vindo!'); await afterStaffLogin();
  };
  async function afterStaffLogin() { if (!(await loadStaff())) { toast('Não foi possível carregar os dados.'); return; } V.int.page = 'painel'; V.int.mine = true; V.view = 'interno'; render(); }
  window.logout = async function () { await syncNow(); await api('/api/auth', { action: 'logout' }); V.int.user = null; V.int.login = {}; window.ME = null; await loadPublic(); V.view = 'portal'; V.pub.page = 'home'; render(); };

  /* ---------- equipa: acessos, 2FA, palavra-passe ---------- */
  let AUTH = null;
  async function loadAuthStatus() { const j = await api('/api/auth', { action: 'auth_status' }); if (j.ok) { AUTH = {}; j.rows.forEach(r => AUTH[r.uid] = r); if (V.int.page === 'equipa') render(); } }
  window.accessTag = function (id) {
    if (!AUTH) { if (AUTH === null) { AUTH = false; loadAuthStatus(); } return '<span class="mut sm">…</span>'; }
    const r = AUTH[id] || {};
    return r.pw ? tag('Palavra-passe definida', 'ok') : r.invite ? tag('Convite pendente', 'warn') : tag('Sem acesso', 'bad');
  };
  window.userAccessBox = function (id) {
    const u = U(id); const r = (AUTH || {})[id] || {};
    return `<div class="note" style="margin-top:12px"><b>Acesso à área interna</b><br>${r.pw ? 'Palavra-passe definida.' : 'Ainda não definiu palavra-passe.'} ${u.mfa ? '2FA ativo.' : '2FA inativo.'}<div class="row" style="margin-top:8px"><button class="btn sm" onclick="userInvite('${id}',false)">${r.pw ? 'Gerar novo código' : 'Gerar código de acesso'}</button>${r.pw ? `<button class="btn sm danger" onclick="userInvite('${id}',true)">Repor palavra-passe</button>` : ''}${u.mfa && id !== V.int.user ? `<button class="btn sm" onclick="adminMfaOff('${id}')">Desativar 2FA</button>` : ''}</div></div>`;
  };
  window.userInvite = async function (id, reset) {
    const j = await api('/api/auth', { action: 'invite', uid: id, reset });
    if (!j.ok) { toast(j.error); return; }
    const u = U(id); const txt = `Olá ${u.nome.split(' ')[0]}, o seu acesso à área interna da ${S.cfg.empresa}:\n${location.origin}/#interno\nE-mail: ${u.email}\nCódigo de primeiro acesso: ${j.code}\n(válido 7 dias — em “Primeiro acesso”, escolha a sua palavra-passe)`;
    AUTH = null;
    modal('Código de acesso', `<p>Código para <b>${esc(u.nome)}</b> (válido 7 dias, só funciona uma vez):</p><div style="font-family:ui-monospace,monospace;font-size:28px;letter-spacing:.2em;text-align:center;padding:14px;background:var(--panel2);border-radius:12px">${j.code}</div><p class="mut sm">O código não fica visível depois de fechar esta janela. Envie-o diretamente ao utilizador.</p><textarea class="code" style="height:110px" onclick="this.select()">${esc(txt)}</textarea>`, `${u.tel ? `<a class="btn wa" href="${waLink(u.tel, txt)}" target="_blank" rel="noopener">Enviar por WhatsApp</a>` : ''}<button class="btn" onclick="copyText(${JSON.stringify(txt).replace(/"/g, '&quot;')})">Copiar</button><button class="btn gold" onclick="closeModal();render()">Fechar</button>`, 'narrow');
    loadAuthStatus();
  };
  window.adminMfaOff = async function (id) { const j = await api('/api/auth', { action: 'mfa_disable', uid: id }); if (!j.ok) { toast(j.error); return; } await loadStaff(); closeModal(); render(); toast('2FA desativado'); };
  window.pgConta = function () {
    const u = window.ME || me();
    return `<div class="grid g2"><div class="card" id="fpw"><h3>Alterar palavra-passe</h3><div class="grid"><div><label>Palavra-passe atual</label><input name="old" type="password" autocomplete="current-password"></div><div><label>Nova palavra-passe (mín. 8)</label><input name="p1" type="password" autocomplete="new-password"></div><div><label>Repetir nova palavra-passe</label><input name="p2" type="password" autocomplete="new-password"></div><button class="btn gold" onclick="changePw()">Alterar</button></div></div>
    <div class="card"><h3>Autenticação de dois fatores (2FA)</h3><p class="mut sm">Com o 2FA ativo, além da palavra-passe é pedido um código de 6 dígitos gerado no telemóvel (Google Authenticator, Microsoft Authenticator ou semelhante).</p>${me().mfa ? `<p>${tag('Ativo', 'ok')}</p><div class="row"><input id="mfaPw" type="password" placeholder="Palavra-passe para desativar" style="max-width:260px"><button class="btn danger" onclick="mfaOff()">Desativar</button></div>` : `<div id="mfaBox"><button class="btn gold" onclick="mfaSetup()">Ativar 2FA</button></div>`}</div></div>`;
  };
  window.changePw = async function () { const d = fd2('#fpw'); if (d.p1 !== d.p2) { toast('As palavras-passe não coincidem.'); return; } const j = await api('/api/auth', { action: 'password', old: d.old, password: d.p1 }); if (!j.ok) { toast(j.error); return; } toast('Palavra-passe alterada'); render(); };
  window.mfaSetup = async function () {
    const j = await api('/api/auth', { action: 'mfa_setup' }); if (!j.ok) { toast(j.error); return; }
    $('#mfaBox').innerHTML = `<p class="sm">1. Na aplicação de autenticação, adicione uma conta lendo este código QR (ou introduza a chave manualmente).</p><div id="qr" style="background:#fff;padding:10px;display:inline-block;border-radius:12px"></div><p class="sm mut" style="word-break:break-all">Chave: <b>${j.secret}</b></p><p class="sm">2. Introduza o código de 6 dígitos que aparece na aplicação:</p><div class="row"><input id="mfaCode" inputmode="numeric" maxlength="6" placeholder="000000" style="max-width:140px"><button class="btn gold" onclick="mfaConfirm()">Confirmar</button></div>`;
    const draw = () => { try { new QRCode(document.getElementById('qr'), { text: j.uri, width: 180, height: 180 }); } catch (e) { $('#qr').innerHTML = '<span class="sm">Use a chave acima.</span>'; } };
    if (window.QRCode) draw(); else { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; sc.onload = draw; sc.onerror = draw; document.head.appendChild(sc); }
  };
  window.mfaConfirm = async function () { const j = await api('/api/auth', { action: 'mfa_confirm', code: $('#mfaCode').value.trim() }); if (!j.ok) { toast(j.error); return; } await loadStaff(); render(); toast('2FA ativado'); };
  window.mfaOff = async function () { const j = await api('/api/auth', { action: 'mfa_disable', password: $('#mfaPw').value }); if (!j.ok) { toast(j.error); return; } await loadStaff(); render(); toast('2FA desativado'); };
  window.pgBackupAPI = function () {
    return `<div class="grid g2"><div class="card"><h3>Exportar dados</h3><p class="mut sm">Os dados ficam guardados na base de dados Neon (com cópias e recuperação de pontos no tempo do próprio Neon). Pode também exportar uma cópia completa em JSON.</p><button class="btn gold" onclick="showText('Cópia de segurança',JSON.stringify({...S,log:undefined,favsAnon:undefined}));log('Cópia de segurança exportada')">Exportar dados</button></div>
    <div class="card"><h3>Onde estão os dados</h3><ul class="sm"><li>Base de dados: Neon Postgres (partilhada por toda a equipa).</li><li>Fotografias carregadas: Vercel Blob.</li><li>Sessões seguras com cookie HttpOnly; palavras-passe cifradas (scrypt); bloqueio de 15 min após 5 tentativas falhadas.</li></ul></div></div>`;
  };
  /* ---------- clientes: acesso à área reservada ---------- */
  window.clientInvite = async function (cid) {
    const j = await api('/api/auth', { action: 'client_invite', cid }); if (!j.ok) { toast(j.error); return; }
    const c = C(cid); const login = c.email || c.tel;
    const txt = `Olá ${c.nome.split(' ')[0]}, pode acompanhar os seus imóveis, visitas e propostas na área reservada da ${S.cfg.empresa}:\n${location.origin}/#reservada\nUtilizador: ${login}\nCódigo de acesso: ${j.code}\n(válido 30 dias)`;
    modal('Acesso à área reservada', `<p>Código de acesso de <b>${esc(c.nome)}</b> (válido 30 dias):</p><div style="font-family:ui-monospace,monospace;font-size:28px;letter-spacing:.2em;text-align:center;padding:14px;background:var(--panel2);border-radius:12px">${j.code}</div><p class="mut sm">O cliente entra com o e-mail ou o telefone e este código. Gerar um novo código anula o anterior.</p><textarea class="code" style="height:120px" onclick="this.select()">${esc(txt)}</textarea>`, `${c.tel ? `<a class="btn wa" href="${waLink(c.tel, txt)}" target="_blank" rel="noopener">Enviar por WhatsApp</a>` : ''}<button class="btn" onclick="copyText(${JSON.stringify(txt).replace(/"/g, '&quot;')})">Copiar</button><button class="btn gold" onclick="viewCli('${cid}')">Voltar</button>`, 'narrow');
  };
  /* ---------- área reservada ---------- */
  window.resLogin = function () {
    return pubHeader() + `<div class="login" style="min-height:70vh"><div class="card"><div class="bigic">${logoIcon()}</div><p style="text-align:center;margin:0 0 6px"><span class="eyebrow">Área reservada</span></p><h2 style="text-align:center">Aceda à sua conta</h2>
    <div class="grid"><div><label>E-mail ou telefone</label><input id="rsLogin" autocomplete="username"></div><div><label>Código de acesso</label><input id="rsCode" inputmode="numeric" autocomplete="one-time-code" onkeydown="if(event.key==='Enter')apiResLogin()"></div><button class="btn gold" onclick="apiResLogin()">Entrar</button>
    <p class="note">O código de acesso é enviado pelo seu corretor. Se ainda não o tem, contacte-nos por WhatsApp: <a href="${waLink(S.cfg.whatsapp, 'Olá, gostaria de receber o código de acesso à área reservada.')}" target="_blank" rel="noopener">${esc(S.cfg.whatsapp)}</a></p></div></div></div>` + pubFooter();
  };
  window.apiResLogin = async function () {
    const j = await api('/api/auth', { action: 'client_login', login: $('#rsLogin').value.trim(), code: $('#rsCode').value.trim() });
    if (!j.ok) { toast(j.error); return; }
    if (!(await loadClient())) { toast('Não foi possível carregar os seus dados.'); return; }
    V.res.tab = ''; render();
  };
  window.resLogout = async function () { await api('/api/auth', { action: 'client_logout' }); V.res.cli = null; V.res.tab = ''; await loadPublic(); render(); };
  window.tenantReq = async function (aid) {
    const d = fd2('#fmt_' + aid); if (!d.desc) { toast('Descreva o problema'); return; }
    const j = await api('/api/client', { action: 'manut', arrId: aid, desc: d.desc }); if (!j.ok) { toast(j.error); return; }
    await loadClient(); render(); toast('Pedido enviado. A equipa de gestão vai contactá-lo.');
  };
  const _toggleFav = window.toggleFav;
  window.toggleFav = function (id) {
    if (MODE === 'client') { const c = C(V.res.cli); c.favs = c.favs || []; const i = c.favs.indexOf(id); if (i >= 0) c.favs.splice(i, 1); else { c.favs.push(id); toast('Adicionado aos favoritos'); } api('/api/client', { action: 'favs', favs: c.favs }); refreshPub(); return; }
    _toggleFav(id);
  };
  window.favList = function () { return MODE === 'client' && V.res.cli ? (C(V.res.cli).favs || (C(V.res.cli).favs = [])) : (S.favsAnon || (S.favsAnon = [])); };

  /* ---------- portal: pedidos dos visitantes ---------- */
  async function refreshAfterPublicPost() { if (MODE === 'staff') await loadStaff(); else if (MODE === 'public') await loadPublic(); }
  window.submitContact = async function (id, tipo) {
    const d = fd2('#cform'); if (!d.nome || !d.tel) { toast('Indique o nome e o telefone.'); return; }
    if (tipo === 'visita') { if (!d.data || !d.hora) { toast('Escolha a data e a hora da visita.'); return; } if (slotPast(d.data, d.hora)) { toast('Escolha uma data e hora futuras.'); return; } }
    const j = await api('/api/public', { action: tipo === 'visita' ? 'visita' : 'info', propId: id, ...d });
    if (!j.ok) { toast(j.error); if (j.status === 409) { await refreshAfterPublicPost(); checkPub(); } return; }
    closeModal(); toast(tipo === 'visita' ? `Pedido de visita registado. ${j.corretor} vai confirmar consigo.` : `Pedido registado. ${j.corretor} vai contactá-lo.`);
    refreshAfterPublicPost();
  };
  window.submitProcuro = async function () {
    const d = fd2('#fprocuro'); if (!d.nome || !d.tel) { toast('Indique o nome e o telefone.'); return; }
    const j = await api('/api/public', { action: 'procuro', ...d }); if (!j.ok) { toast(j.error); return; }
    const M = matches({ pref: { finalidade: d.finalidade, tipo: d.tipo, tipologia: d.tipologia, zonas: d.zonas || d.provincia, orcMax: d.orcMax, moeda: d.moeda } }).slice(0, 4);
    $('#procuroRes').innerHTML = `<div class="alert ok" style="margin-top:16px">Pedido registado. ${esc(j.corretor)} vai contactá-lo em breve.</div>${M.length ? `<h2 style="margin-top:20px">Já temos estes imóveis compatíveis</h2><div class="plist">${M.map(m => propCard(m.p)).join('')}</div>` : ''}`; toast('Pedido enviado');
  };
  window.submitVender = async function () {
    const d = fd2('#fvender'); if (!d.nome || !d.tel) { toast('Indique o nome e o telefone.'); return; }
    const j = await api('/api/public', { action: 'vender', ...d }); if (!j.ok) { toast(j.error); return; }
    $('#venderRes').innerHTML = `<div class="alert ok" style="margin-top:16px">Obrigado, ${esc(d.nome.split(' ')[0])}. O seu imóvel ficou registado com a referência <b>${esc(j.ref)}</b>. ${esc(j.corretor)} vai contactá-lo para marcar a avaliação.</div>`; toast('Pedido enviado');
  };

  /* ---------- fotografias → Vercel Blob ---------- */
  async function uploadAll(datas, folder) {
    const out = [];
    for (let i = 0; i < datas.length; i++) {
      toast(`A enviar fotografia ${i + 1} de ${datas.length}…`);
      const j = await api('/api/upload', { data: datas[i], folder });
      if (!j.ok) { toast('Falhou o envio: ' + j.error); break; }
      out.push(j.url);
    }
    return out;
  }
  window.addImgFiles = function (k, files) {
    const h = phHolder(k); h.imgs = h.imgs || []; const room = 20 - h.imgs.length; if (room <= 0) { toast('Máximo de 20 fotografias por imóvel'); return; }
    readFiles([...files].slice(0, room), async out => { const urls = await uploadAll(out, 'imoveis'); urls.forEach(u => h.imgs.push(u)); if (urls.length) { phRefresh(k, `${urls.length} fotografia(s) adicionada(s)`); toast(`${urls.length} fotografia(s) adicionada(s)`); } }, 1600, .82);
  };
  window.chvImgs = function (id, inp) {
    readFiles(inp.files, async out => { const urls = await uploadAll(out, 'vistorias'); const x = S.propostas.find(y => y.id === id); x.chaves.fotos = [...(x.chaves.fotos || []), ...urls].slice(0, 12); log(`Fotografias de vistoria adicionadas — ${P(x.propId).ref}`); viewProposta(id); }, 1280, .75);
  };
  window.resetDemo = function () { toast('Indisponível na versão em servidor.'); };

  /* ---------- arranque ---------- */
  async function boot() {
    S = blankS();
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === 'interno') V.view = 'interno'; else if (h === 'reservada') V.view = 'reservada';
    $('#app').innerHTML = '<div class="login"><div class="card" style="text-align:center"><div class="bigic">' + logoIcon() + '</div><p class="mut">A carregar…</p></div></div>';
    const meR = await api('/api/auth', { action: 'me' });
    if (meR.user) await loadStaff();
    else { const cm = await api('/api/auth', { action: 'client_me' }); if (!(cm.client && await loadClient())) await loadPublic(); }
    render();
    if (h.startsWith('imovel-')) { const p = S.props.find(x => x.ref === h.slice(7)); if (p) openProp(p.id); }
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (DP) closeDP(); else closeModal(); } });
  boot();
})();
