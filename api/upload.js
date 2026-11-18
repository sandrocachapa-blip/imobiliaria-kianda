// Envio de fotografias para o Vercel Blob (apenas equipa interna)
import { put } from '@vercel/blob';
import { handler, json, fail, readBody, getDoc, staffSession, uid } from './_lib.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default handler(async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'Método não permitido');
  const me = staffSession(req);
  if (!me) return fail(res, 401, 'Sessão expirada. Inicie sessão novamente.');
  const u = await getDoc('equipa', me.uid);
  if (!u || !u.ativo) return fail(res, 401, 'Utilizador inativo.');
  if (!process.env.BLOB_READ_WRITE_TOKEN) return fail(res, 500, 'Armazenamento de fotografias não configurado.');
  const b = readBody(req);
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
  if (!m) return fail(res, 400, 'Imagem inválida.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3.5 * 1024 * 1024) return fail(res, 413, 'Imagem demasiado grande.');
  const folder = String(b.folder || 'imoveis').replace(/[^a-z0-9-]/gi, '').slice(0, 30) || 'imoveis';
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const blob = await put(`${folder}/${uid('f')}.${ext}`, buf, { access: 'public', contentType: 'image/' + m[1], addRandomSuffix: false });
  return json(res, 200, { ok: true, url: blob.url });
});
