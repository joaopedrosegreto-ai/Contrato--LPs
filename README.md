# Contrato Digital · Malta Business

App de contrato de desenvolvimento web (landing page, site institucional, loja virtual e sistema web) com acesso por e-mail + telefone, pagamento via PIX com comprovante obrigatório, assinatura na tela e PDF assinado.

**No ar:** https://joaopedrosegreto-ai.github.io/Contrato--LPs/

| Quem | Endereço |
|---|---|
| Cliente | `/` — entra com e-mail e telefone |
| Admin · nova proposta | `/#admin` |
| Admin · contratos assinados | `/#admin/contratos` |

---

## Como funciona

### 1. Você cria a proposta (`#admin`, com login)
- E-mail e telefone do cliente (são a "chave" de acesso dele)
- Tipo de projeto: Landing Page, Site Institucional, Loja Virtual, Sistema Web ou Personalizado — cada um já vem com o escopo padrão, editável
- Valor, prazo, rodadas de ajuste, garantia, domínio/hospedagem e manutenção mensal (opcional)
- Formas de pagamento: à vista no PIX (com desconto), entrada + saldo, parcelado no PIX e cartão (com taxa da maquininha em %)
- Ao criar, abre o WhatsApp do cliente com a mensagem pronta

### 2. O cliente acessa e assina
1. Abre o site e digita **e-mail + telefone** — só vê a proposta se os dois baterem (telefone aceita com/sem +55 e com/sem o 9)
2. Preenche os dados (nome, CPF/CNPJ validado, endereço…)
3. Lê o escopo e o contrato e aceita
4. Escolhe a forma de pagamento:
   - **PIX:** aparece o QR Code com o valor certo e ele **precisa anexar o comprovante** (foto, print ou PDF) para liberar a assinatura
   - **Cartão:** vê o valor já com a taxa da maquininha e assina direto
5. Assina **pela Autentique, dentro do próprio app** (a página de assinatura abre embutida). A Autentique confirma o e-mail do cliente com um código e envia a via assinada por e-mail
   - Links antigos (`#c...`) continuam com a assinatura desenhada na tela

### 3. O contrato cai para você (`#admin/contratos`)
Lista com dados do cliente, forma de pagamento, data/hora, IP, total somado e, em cada contrato: **Baixar PDF**, **Ver comprovante**, **WhatsApp do cliente**, status **Pago / Aguardando pagamento** e o status na Autentique (**aguardando · atualizar** ou **Autentique ✓ · PDF assinado**).

---

## Estrutura

Site estático, sem build — tudo em um arquivo:

```
index.html                               app inteiro (HTML + CSS + JS)
assets/logo-malta.png                    logo (PNG, usado no PDF)
assets/logo-malta.svg                    logo Malta Business (nova identidade)
assets/favicon.svg                       favicon (+ favicon.ico na raiz)
supabase/functions/autentique/index.ts   ponte com a API da Autentique (Edge Function)
.github/workflows/                       tarefa diária que mantém o Supabase ativo
```

Bibliotecas via CDN: [jsPDF](https://github.com/parallax/jsPDF) (PDF), [qrcodejs](https://github.com/davidshimjs/qrcodejs) (QR do PIX), [supabase-js](https://github.com/supabase/supabase-js) (banco). Fontes: Archivo + JetBrains Mono (identidade do maltabusiness.vercel.app).

### Banco (Supabase · projeto `malta-contratos`)

| Recurso | Para quê |
|---|---|
| `propostas` | propostas criadas no admin (só o dono lê/escreve) |
| `contratos_web` | contratos assinados (visitante só insere; só o dono lê) |
| bucket `comprovantes` | comprovantes do PIX (privado; visitante só envia) |
| `rpc buscar_proposta(email, tel)` | única forma do cliente achar a proposta dele |
| Edge Function `autentique` | cria o documento na Autentique, consulta se o cliente assinou e entrega o PDF assinado ao dono |

O mesmo projeto também guarda as tabelas `contracts` e `app_config` do app de contrato de fotos — não mexa nelas.

### Segurança
- A chave do Supabase no `index.html` é a **publicável**: só permite registrar contrato, enviar comprovante e buscar proposta por e-mail + telefone
- Ler contratos, propostas e comprovantes exige **login do dono** (e-mail confirmado), verificado no banco por RLS; nenhum outro e-mail consegue criar conta no projeto
- Contrato assinado a partir de uma proposta usa **a proposta salva no servidor** como verdade: valor e escopo não podem ser alterados pelo navegador
- Data de registro, IP e status inicial são definidos pelo servidor

---

### Autentique
- A chave da API fica **só** em Supabase → Edge Functions → Secrets, com o nome `AUTENTIQUE_TOKEN` (nunca no código)
- Cada proposta gera no máximo **um** documento na Autentique (reabrir o contrato reaproveita o mesmo)
- Plano grátis da Autentique: 10 documentos/mês
- Teste sem gastar cota: **logado no admin**, abra o site com `?sandbox=1` (ex.: `/?sandbox=1`) e faça o caminho do cliente — o documento sai em modo de teste, sem valor jurídico, e a Autentique apaga em alguns dias. Sem o seu login o `?sandbox=1` é ignorado (ninguém consegue trocar o documento real de um cliente por um de teste)
- Para publicar uma nova versão da função: `supabase functions deploy autentique --no-verify-jwt`

## Primeiro acesso do admin
1. Abra `/#admin`
2. Digite seu e-mail (o autorizado no banco) e uma senha
3. Toque em **"Primeiro acesso: criar minha senha"** e confirme pelo link que chega no e-mail (se cair numa página de erro depois de confirmar, é normal)
4. Volte e toque em **Entrar** — o login fica salvo no aparelho

## Publicação
GitHub Pages, branch `main`, pasta raiz. Todo push no `main` atualiza o site em 1–2 minutos.

## Personalizar
No `index.html`:
- `DEFAULT_CONTRATADA` — seus dados (nome, CNPJ, cidade, chave PIX, WhatsApp)
- `PRESETS` — tipos de projeto e itens de escopo padrão
- `contractSections()` — texto das cláusulas do contrato

> Links antigos no formato `#c...` (antes das propostas no banco) referenciam os itens de `PRESETS` pela posição. Para mudar um item, prefira adicionar um novo em vez de reescrever o antigo.

## Atenção: Supabase gratuito pausa
No plano gratuito, o projeto **pausa após 7 dias sem uso**. Pausado, o cliente não consegue abrir a proposta nem registrar o contrato. Para reativar: painel do Supabase → projeto `malta-contratos` → **Restore**. Para evitar, use o plano pago ou um acesso automático periódico ao banco.
