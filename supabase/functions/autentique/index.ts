// Ponte entre o app de contrato e a Autentique.
// A chave AUTENTIQUE_TOKEN fica só nos secrets do Supabase; o navegador nunca a vê.
// Ações:
//   criar      — cria o documento na Autentique para um contrato vindo de proposta e devolve o link de assinatura
//   status     — consulta se o cliente já assinou (e grava no banco)
//   admin_pdf  — devolve o link do PDF assinado (só para o dono logado)
import { createClient } from "jsr:@supabase/supabase-js@2";

const AUT = "https://api.autentique.com.br/v2/graphql";
const TOKEN = Deno.env.get("AUTENTIQUE_TOKEN") ?? "";
const URL_ = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const r = await fetch(AUT, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error((j.errors || []).map((e: { message: string }) => e.message).join("; ") || `Autentique HTTP ${r.status}`);
  return j.data;
}

// assinatura do cliente dentro do documento (o criador do documento pode aparecer na lista também)
const clientSig = (sigs: any[], email: string) =>
  sigs.find((s) => (s.email || s.user?.email || "").toLowerCase() === email.toLowerCase()) || sigs.find((s) => s.action?.name === "SIGN");

async function linkFor(docId: string, email: string) {
  const d = await gql(`query($id: UUID!) { document(id: $id) { signatures { public_id email user { email } action { name } link { short_link } signed { created_at } rejected { created_at } } } }`, { id: docId });
  const s = clientSig(d.document.signatures, email);
  if (!s) throw new Error("Signatário não encontrado no documento");
  if (s.link?.short_link) return { sig: s, link: s.link.short_link };
  const l = await gql(`mutation($id: UUID!) { createLinkToSignature(public_id: $id) { short_link } }`, { id: s.public_id });
  return { sig: s, link: l.createLinkToSignature.short_link };
}

async function proposta(contratoId: string) {
  const { data } = await db.from("propostas").select("cliente_email,config,status").eq("contrato_id", contratoId).single();
  return data;
}

async function criar(body: any) {
  const { data: row } = await db.from("contratos_web")
    .select("id,contrato_id,origem,cliente_nome,created_at,autentique_doc_id,autentique_status")
    .eq("id", body.id).single();
  if (!row || row.origem !== "proposta") return json({ error: "Contrato inválido" }, 400);
  if (Date.now() - new Date(row.created_at).getTime() > 2 * 3600e3) return json({ error: "Contrato expirado, recomece" }, 400);
  const prop = await proposta(row.contrato_id);
  if (!prop || prop.status === "cancelada") return json({ error: "Proposta indisponível" }, 400);
  const email = prop.cliente_email;

  // já existe documento para esta proposta? reaproveita (não gasta outro documento do mês)
  const { data: prev } = await db.from("contratos_web").select("id,autentique_doc_id,autentique_status")
    .eq("contrato_id", row.contrato_id).not("autentique_doc_id", "is", null).order("created_at", { ascending: false }).limit(1);
  if (prev?.length) {
    const p = prev[0];
    if (p.autentique_status === "assinado") return json({ id: p.id, status: "assinado" });
    const { link } = await linkFor(p.autentique_doc_id, email);
    return json({ id: p.id, status: p.autentique_status, link });
  }

  const pdf = Uint8Array.from(atob(String(body.pdf || "")), (c) => c.charCodeAt(0));
  if (pdf.length < 1000 || pdf.length > 4.5e6 || new TextDecoder().decode(pdf.slice(0, 5)) !== "%PDF-") return json({ error: "PDF inválido" }, 400);

  const cfg = prop.config || {};
  const primeiro = String(row.cliente_nome || "").split(" ")[0];
  const sandbox = body.sandbox === true;
  const ops = {
    query: `mutation($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!) {
      createDocument(sandbox: ${sandbox}, document: $document, signers: $signers, file: $file) {
        id signatures { public_id email user { email } action { name } link { short_link } }
      } }`,
    variables: {
      document: {
        name: `Contrato ${row.contrato_id} · ${cfg.servico || "Desenvolvimento web"}${cfg.projeto ? " · " + cfg.projeto : ""}`,
        message: `Olá, ${primeiro}! Aqui é o Malta, da Malta Business. Este é o contrato do seu projeto${cfg.projeto ? ` (${cfg.projeto})` : ""}. É só revisar e assinar pelo botão abaixo. Qualquer dúvida, me chama no WhatsApp ${cfg.contratada?.whats || "(31) 8763-7599"}.`,
      },
      signers: [{ email, action: "SIGN" }],
      file: null,
    },
  };
  const form = new FormData();
  form.append("operations", JSON.stringify(ops));
  form.append("map", JSON.stringify({ file: ["variables.file"] }));
  form.append("file", new Blob([pdf], { type: "application/pdf" }), `Contrato-${row.contrato_id}.pdf`);
  const r = await fetch(AUT, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) return json({ error: "Autentique: " + ((j.errors || []).map((e: any) => e.message).join("; ") || r.status) }, 502);
  const doc = j.data.createDocument;

  await db.from("contratos_web").update({ autentique_doc_id: doc.id, autentique_status: "pendente", autentique_sandbox: sandbox }).eq("id", row.id);
  const { link } = await linkFor(doc.id, email);
  return json({ id: row.id, status: "pendente", link });
}

async function status(body: any) {
  const { data: row } = await db.from("contratos_web").select("id,contrato_id,autentique_doc_id,autentique_status").eq("id", body.id).single();
  if (!row?.autentique_doc_id) return json({ status: null });
  if (row.autentique_status === "assinado") return json({ status: "assinado" });
  const prop = await proposta(row.contrato_id);
  const d = await gql(`query($id: UUID!) { document(id: $id) { signatures { public_id email user { email } action { name } signed { created_at } rejected { created_at } } } }`, { id: row.autentique_doc_id });
  const s = clientSig(d.document.signatures, prop?.cliente_email || "");
  let st = "pendente", em = null;
  if (s?.signed?.created_at) { st = "assinado"; em = s.signed.created_at; }
  else if (s?.rejected?.created_at) st = "recusado";
  if (st !== row.autentique_status) {
    await db.from("contratos_web").update({ autentique_status: st, autentique_assinado_em: em }).eq("id", row.id);
    if (st === "assinado") await db.from("propostas").update({ status: "assinada", assinada_em: new Date().toISOString() }).eq("contrato_id", row.contrato_id).eq("status", "aberta");
  }
  return json({ status: st });
}

async function adminPdf(req: Request, body: any) {
  // o dono é quem consegue ler a linha com o próprio login (regras do banco)
  const auth = req.headers.get("Authorization") || "";
  const user = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: row } = await user.from("contratos_web").select("id,autentique_doc_id").eq("id", body.id).maybeSingle();
  if (!row) return json({ error: "Sem permissão" }, 403);
  if (!row.autentique_doc_id) return json({ error: "Sem documento na Autentique" }, 404);
  const d = await gql(`query($id: UUID!) { document(id: $id) { files { original signed } } }`, { id: row.autentique_doc_id });
  return json({ signed: d.document.files?.signed || null, original: d.document.files?.original || null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!TOKEN) return json({ error: "AUTENTIQUE_TOKEN não configurado" }, 500);
  try {
    const body = await req.json();
    if (typeof body?.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) return json({ error: "id inválido" }, 400);
    if (body.action === "criar") return await criar(body);
    if (body.action === "status") return await status(body);
    if (body.action === "admin_pdf") return await adminPdf(req, body);
    return json({ error: "Ação desconhecida" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
