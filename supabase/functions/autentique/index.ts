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

// erro com mensagem segura para o usuário; o detalhe vai só para o log
class Falha extends Error {
  constructor(public publico: string, public http = 500, detalhe?: unknown) {
    super(publico);
    if (detalhe) console.error(publico, detalhe);
  }
}
const INVALIDO = () => new Falha("Contrato indisponível. Recarregue a página ou fale com a Malta.", 400);
const BANCO = (e: unknown) => new Falha("Falha temporária no servidor. Tente de novo em instantes.", 503, e);

async function gql(query: string, variables: Record<string, unknown> = {}) {
  let r: Response;
  try {
    r = await fetch(AUT, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw new Falha("A Autentique não respondeu. Tente de novo em instantes.", 502, e); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Falha("Erro na Autentique. Tente de novo em instantes.", 502, j.errors || r.status);
  return j.data;
}

async function documento(docId: string, campos: string) {
  const d = await gql(`query($id: UUID!) { document(id: $id) { ${campos} } }`, { id: docId });
  if (!d?.document) throw new Falha("Documento não encontrado na Autentique.", 404, docId);
  return d.document;
}

// assinatura do cliente dentro do documento (o criador do documento pode aparecer na lista também)
function clientSig(sigs: any[], email: string) {
  const s = (sigs || []).find((s) => (s.email || s.user?.email || "").toLowerCase() === email.toLowerCase());
  if (!s) throw new Falha("Signatário não encontrado no documento.", 500, { email });
  return s;
}

async function linkFor(docId: string, email: string) {
  const doc = await documento(docId, "signatures { public_id email user { email } link { short_link } }");
  const s = clientSig(doc.signatures, email);
  if (s.link?.short_link) return s.link.short_link as string;
  const l = await gql(`mutation($id: UUID!) { createLinkToSignature(public_id: $id) { short_link } }`, { id: s.public_id });
  const link = l?.createLinkToSignature?.short_link;
  if (!link) throw new Falha("A Autentique não gerou o link de assinatura.", 502);
  return link as string;
}

async function proposta(contratoId: string) {
  const { data, error } = await db.from("propostas").select("cliente_email,config,status").eq("contrato_id", contratoId).maybeSingle();
  if (error) throw BANCO(error);
  return data;
}

// o dono é quem consegue ler propostas com o próprio login (regras do banco)
async function isOwner(req: Request, contratoId: string) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ey")) return false; // chave publicável não é login
  const user = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await user.from("propostas").select("contrato_id").eq("contrato_id", contratoId).maybeSingle();
  return !!data;
}

async function criar(req: Request, body: any) {
  const { data: row, error } = await db.from("contratos_web")
    .select("id,contrato_id,origem,cliente_nome,created_at")
    .eq("id", body.id).maybeSingle();
  if (error) throw BANCO(error);
  if (!row || row.origem !== "proposta") throw INVALIDO();
  if (Date.now() - new Date(row.created_at).getTime() > 2 * 3600e3) throw INVALIDO();
  const prop = await proposta(row.contrato_id);
  if (!prop || prop.status === "cancelada") throw INVALIDO();
  const email = prop.cliente_email;
  // modo de teste só para o dono logado ou propostas de teste "MB-TESTE-" (criadas só direto no banco);
  // evita que alguém troque o documento real de um cliente por um de teste
  const sandbox = body.sandbox === true && (row.contrato_id.startsWith("MB-TESTE-") || await isOwner(req, row.contrato_id));

  // já existe documento (do mesmo modo) para esta proposta? reaproveita — não gasta outro documento do mês
  const reuse = async () => {
    const { data: prev, error: e2 } = await db.from("contratos_web").select("id,autentique_doc_id,autentique_status")
      .eq("contrato_id", row.contrato_id).eq("autentique_sandbox", sandbox).not("autentique_doc_id", "is", null)
      .order("created_at", { ascending: false }).limit(1);
    if (e2) throw BANCO(e2);
    if (!prev?.length) return null;
    const p = prev[0];
    // o documento já existe em outra linha: descarta a linha nova (sem documento) para não poluir a lista do dono
    if (p.id !== row.id) {
      const { error: e5 } = await db.from("contratos_web").delete().eq("id", row.id).is("autentique_doc_id", null);
      if (e5) console.error("falha ao descartar linha duplicada", e5);
    }
    if (p.autentique_status === "assinado") return json({ id: p.id, status: "assinado" });
    return json({ id: p.id, status: p.autentique_status, link: await linkFor(p.autentique_doc_id, email) });
  };
  const reused = await reuse();
  if (reused) return reused;

  const pdf = Uint8Array.from(atob(String(body.pdf || "")), (c) => c.charCodeAt(0));
  if (pdf.length < 1000 || pdf.length > 4.5e6 || new TextDecoder().decode(pdf.slice(0, 5)) !== "%PDF-") throw new Falha("PDF inválido.", 400);

  // trava: só uma chamada por vez cria o documento desta proposta
  const agora = new Date(), velho = new Date(Date.now() - 120e3).toISOString();
  const { data: claim, error: e3 } = await db.from("propostas").update({ autentique_claim: agora.toISOString() })
    .eq("contrato_id", row.contrato_id).or(`autentique_claim.is.null,autentique_claim.lt."${velho}"`).select("contrato_id");
  if (e3) throw BANCO(e3);
  if (!claim?.length) {
    const again = await reuse(); // outra chamada acabou de criar
    if (again) return again;
    throw new Falha("Seu contrato está sendo preparado. Aguarde alguns segundos e tente de novo.", 409);
  }
  const solta = () => db.from("propostas").update({ autentique_claim: null }).eq("contrato_id", row.contrato_id);

  try {
    const cfg = prop.config || {};
    const primeiro = String(row.cliente_nome || "").split(" ")[0];
    const ops = {
      query: `mutation($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!) {
        createDocument(sandbox: ${sandbox}, document: $document, signers: $signers, file: $file) {
          id signatures { public_id email user { email } link { short_link } }
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
    let r: Response;
    try { r = await fetch(AUT, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: form, signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new Falha("A Autentique não respondeu. Tente de novo em instantes.", 502, e); }
    const j = await r.json().catch(() => ({}));
    const doc = j?.data?.createDocument;
    if (!r.ok || j.errors || !doc?.id) throw new Falha("Erro na Autentique ao criar o documento. Tente de novo.", 502, j.errors || r.status);

    // grava o documento; tenta de novo se o banco oscilar (o documento já existe na Autentique)
    let e4: unknown = null;
    for (const wait of [0, 1000, 3000]) {
      if (wait) await new Promise((res) => setTimeout(res, wait));
      ({ error: e4 } = await db.from("contratos_web").update({ autentique_doc_id: doc.id, autentique_status: "pendente", autentique_sandbox: sandbox }).eq("id", row.id));
      if (!e4) break;
    }
    if (e4) throw new Falha("Falha ao registrar o documento. Fale com a Malta.", 500, { e4, orfao: doc.id, contrato: row.contrato_id });
    return json({ id: row.id, status: "pendente", link: await linkFor(doc.id, email) });
  } finally {
    await solta();
  }
}

async function status(body: any) {
  const { data: row, error } = await db.from("contratos_web").select("id,contrato_id,autentique_doc_id,autentique_status,autentique_sandbox").eq("id", body.id).maybeSingle();
  if (error) throw BANCO(error);
  if (!row) throw INVALIDO();
  if (!row.autentique_doc_id) return json({ status: null });
  if (row.autentique_status === "assinado") return json({ status: "assinado" });
  const prop = await proposta(row.contrato_id);
  if (!prop) throw INVALIDO();
  const doc = await documento(row.autentique_doc_id, "signatures { public_id email user { email } signed { created_at } rejected { created_at } }");
  const s = clientSig(doc.signatures, prop.cliente_email);
  let st = "pendente", em = null;
  if (s.signed?.created_at) { st = "assinado"; em = s.signed.created_at; }
  else if (s.rejected?.created_at) st = "recusado";
  if (st !== row.autentique_status) {
    const { error: e1 } = await db.from("contratos_web").update({ autentique_status: st, autentique_assinado_em: em }).eq("id", row.id);
    if (e1) throw BANCO(e1);
    // documento de teste não fecha a proposta real
    if (st === "assinado" && !row.autentique_sandbox) {
      const { error: e2 } = await db.from("propostas").update({ status: "assinada", assinada_em: new Date().toISOString() }).eq("contrato_id", row.contrato_id).eq("status", "aberta");
      if (e2) throw BANCO(e2);
    }
  }
  return json({ status: st });
}

async function adminPdf(req: Request, body: any) {
  // o dono é quem consegue ler a linha com o próprio login (regras do banco)
  const auth = req.headers.get("Authorization") || "";
  const user = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: row, error } = await user.from("contratos_web").select("id,autentique_doc_id").eq("id", body.id).maybeSingle();
  if (error) throw BANCO(error);
  if (!row) throw new Falha("Sem permissão.", 403);
  if (!row.autentique_doc_id) throw new Falha("Sem documento na Autentique.", 404);
  const doc = await documento(row.autentique_doc_id, "files { original signed }");
  return json({ signed: doc.files?.signed || null, original: doc.files?.original || null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!TOKEN) { console.error("AUTENTIQUE_TOKEN não configurado"); return json({ error: "Assinatura indisponível no momento. Fale com a Malta." }, 500); }
  try {
    const body = await req.json().catch(() => null);
    if (typeof body?.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) return json({ error: "Requisição inválida" }, 400);
    if (body.action === "criar") return await criar(req, body);
    if (body.action === "status") return await status(body);
    if (body.action === "admin_pdf") return await adminPdf(req, body);
    return json({ error: "Ação desconhecida" }, 400);
  } catch (e) {
    if (e instanceof Falha) return json({ error: e.publico }, e.http);
    console.error(e);
    return json({ error: "Erro inesperado. Tente de novo em instantes." }, 500);
  }
});
