# Kianda Imobiliária — Portal e Gestão

Aplicação para uma imobiliária em Angola: portal público de imóveis, gestão interna (CRM, visitas, propostas e negócios, arrendamentos, finanças, equipa e segurança) e área reservada para clientes.

## Arquitetura
- **Frontend:** `index.html` (página única, gerada a partir de `src/app.html` + `src/api-mode.js`).
- **Servidor:** funções Node.js do Vercel em `api/`
  - `api/public.js` — catálogo público (sem moradas privadas, documentos nem proprietários) e pedidos do site (informação, visitas com verificação de horário, “Procuro um imóvel”, “Quero vender ou arrendar”).
  - `api/auth.js` — login da equipa (palavra-passe scrypt, 2FA TOTP opcional, bloqueio de 15 min após 5 tentativas), primeiro acesso por código, códigos de acesso dos clientes.
  - `api/data.js` — leitura e gravação dos dados da gestão interna (só equipa; a equipa só pode ser alterada pelo administrador).
  - `api/client.js` — área reservada (cada cliente vê apenas os seus dados).
  - `api/upload.js` — fotografias para o Vercel Blob.
- **Base de dados:** Neon Postgres (tabelas `docs`, `cfg`, `auth`, `cli_auth`, `logs`, criadas automaticamente). Na primeira utilização é carregado `api/_seed.json`.
- **Fotografias:** as iniciais estão em `assets/fotos/real/`; as novas vão para o Vercel Blob.

## Variáveis de ambiente (Vercel)
| Nome | Descrição |
|---|---|
| `DATABASE_URL` | Ligação ao Neon (pooled) |
| `AUTH_SECRET` | Segredo aleatório (≥ 32 caracteres) para assinar as sessões |
| `SETUP_CODE` | Código do primeiro acesso do administrador |
| `BLOB_READ_WRITE_TOKEN` | Criado automaticamente ao ligar o Vercel Blob ao projeto |

## Primeiro acesso
1. Abra `/#interno` → “Primeiro acesso / tenho um código”.
2. E-mail `admin@kianda.ao` + o `SETUP_CODE` → escolha a palavra-passe.
3. Em Equipa & Segurança altere o e-mail do administrador e gere códigos de acesso para a restante equipa.

## Atualizar o frontend
```
npm i --no-save jsdom
node tools/build.mjs src/app.html
```
