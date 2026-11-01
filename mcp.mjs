// Telegram MCP server for Cloudflare Workers (Streamable HTTP, stateless).
// Bot token is passed per tool call and is NEVER stored or logged.

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const MAX_OUT = 20000;

const s = (description) => ({ type: "string", description });
const n = (description) => ({ type: "integer", description });
const o = (description) => ({ type: "object", description });
const chat = s("Chat ID yoki @username");

function tool(name, description, method, props = {}, required = []) {
  return {
    name,
    method,
    description,
    inputSchema: {
      type: "object",
      properties: { token: s("Bot token (BotFather'dan)"), ...props },
      required: ["token", ...required],
    },
  };
}

const TOOLS = [
  tool("get_me", "Bot haqida ma'lumot (token tekshirish uchun ham)", "getMe"),
  tool("send_message", "Matnli xabar yuborish", "sendMessage", {
    chat_id: chat, text: s("Xabar matni"), parse_mode: s("HTML yoki MarkdownV2"),
    reply_markup: o("Inline tugmalar: {inline_keyboard:[[{text,callback_data|url}]]}"),
    message_thread_id: n("Topic ID (forum guruhlar uchun)"),
    reply_to_message_id: n("Javob beriladigan xabar ID"),
    disable_notification: { type: "boolean" },
  }, ["chat_id", "text"]),
  tool("send_photo", "Rasm yuborish (URL yoki file_id)", "sendPhoto", {
    chat_id: chat, photo: s("Rasm URL yoki file_id"), caption: s("Izoh"),
    parse_mode: s("HTML yoki MarkdownV2"), reply_markup: o("Inline tugmalar"),
    message_thread_id: n("Topic ID"),
  }, ["chat_id", "photo"]),
  tool("send_document", "Fayl yuborish (URL yoki file_id)", "sendDocument", {
    chat_id: chat, document: s("Fayl URL yoki file_id"), caption: s("Izoh"),
    message_thread_id: n("Topic ID"),
  }, ["chat_id", "document"]),
  tool("edit_message_text", "Yuborilgan xabar matnini tahrirlash", "editMessageText", {
    chat_id: chat, message_id: n("Xabar ID"), text: s("Yangi matn"),
    parse_mode: s("HTML yoki MarkdownV2"), reply_markup: o("Inline tugmalar"),
  }, ["chat_id", "message_id", "text"]),
  tool("delete_message", "Xabarni o'chirish", "deleteMessage", {
    chat_id: chat, message_id: n("Xabar ID"),
  }, ["chat_id", "message_id"]),
  tool("forward_message", "Xabarni uzatish", "forwardMessage", {
    chat_id: chat, from_chat_id: chat, message_id: n("Xabar ID"),
  }, ["chat_id", "from_chat_id", "message_id"]),
  tool("pin_chat_message", "Xabarni qadash", "pinChatMessage", {
    chat_id: chat, message_id: n("Xabar ID"),
  }, ["chat_id", "message_id"]),
  tool("get_chat", "Chat/guruh/kanal ma'lumoti", "getChat", { chat_id: chat }, ["chat_id"]),
  tool("get_chat_member", "A'zo holati", "getChatMember", {
    chat_id: chat, user_id: n("Foydalanuvchi ID"),
  }, ["chat_id", "user_id"]),
  tool("ban_chat_member", "A'zoni ban qilish", "banChatMember", {
    chat_id: chat, user_id: n("Foydalanuvchi ID"), until_date: n("Unix vaqt (ixtiyoriy)"),
  }, ["chat_id", "user_id"]),
  tool("unban_chat_member", "Banni olib tashlash", "unbanChatMember", {
    chat_id: chat, user_id: n("Foydalanuvchi ID"), only_if_banned: { type: "boolean" },
  }, ["chat_id", "user_id"]),
  tool("get_updates", "Yangi xabarlarni olish (webhook o'rnatilgan bo'lsa ishlamaydi; avval delete_webhook)", "getUpdates", {
    offset: n("Oxirgi update_id + 1"), limit: n("1-100"),
  }),
  tool("get_webhook_info", "Webhook holati", "getWebhookInfo"),
  tool("set_webhook", "Webhook o'rnatish", "setWebhook", {
    url: s("HTTPS webhook URL"), secret_token: s("Ixtiyoriy secret"),
  }, ["url"]),
  tool("delete_webhook", "Webhookni o'chirish", "deleteWebhook", {
    drop_pending_updates: { type: "boolean" },
  }),
  tool("get_file_link", "file_id bo'yicha yuklab olish havolasi (token havolada bo'ladi, ehtiyot bo'ling)", "getFile", {
    file_id: s("file_id"),
  }, ["file_id"]),
  tool("call_api", "Istalgan Telegram Bot API metodini chaqirish (yuqoridagilarda yo'q bo'lsa)", null, {
    method: s("Metod nomi, masalan sendPoll, createForumTopic"),
    params: o("Metod parametrlari (JSON)"),
  }, ["method"]),
];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const PUBLIC_TOOLS = TOOLS.map(({ method, ...rest }) => rest);

async function runTool(name, args = {}) {
  const t = BY_NAME[name];
  if (!t) throw new Error("Noma'lum tool: " + name);
  const { token, ...rest } = args;
  if (!token || !TOKEN_RE.test(token)) throw new Error("Token noto'g'ri formatda");

  let method = t.method;
  let body = rest;
  if (name === "call_api") {
    method = String(rest.method || "");
    if (!/^[A-Za-z]{3,40}$/.test(method)) throw new Error("Metod nomi noto'g'ri");
    body = rest.params || {};
  }
  if (name === "get_updates") body = { timeout: 0, ...rest };

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let out = await res.text();
  out = out.split(token).join("***");
  if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + "\n...(qirqildi)";
  return { content: [{ type: "text", text: out }], isError: !res.ok };
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined) return null; // notification

  try {
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: params?.protocolVersion || "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "telegram-mcp", version: "0.1.0" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: PUBLIC_TOOLS });
      case "tools/call":
        try {
          return ok(await runTool(params?.name, params?.arguments));
        } catch (e) {
          return ok({ content: [{ type: "text", text: String(e.message) }], isError: true });
        }
      default:
        return err(-32601, "Method not found: " + method);
    }
  } catch (e) {
    return err(-32603, "Internal error");
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
};

const PAGE = `<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telegram → Claude: botni chatga ulang</title>
<meta name="description" content="Claude chatidan Telegram bot orqali xabar yuborish, tahrirlash va guruhlarni boshqarish uchun MCP connector.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;800&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#EEF3F7; --card:#FFFFFF; --ink:#10202E; --muted:#51657A;
  --line:#CBD8E3; --accent:#1B7FB8; --accent-ink:#FFFFFF; --warn-bg:#FBF0D3; --warn-ink:#5A4300;
  color-scheme: light;
}
@media (prefers-color-scheme: dark){
  :root{--paper:#0E1822; --card:#15242F; --ink:#E6EEF5; --muted:#93A8BA; --line:#27394A;
    --accent:#4FB3E8; --accent-ink:#06121B; --warn-bg:#3A2F10; --warn-ink:#F3DFA5; color-scheme: dark;}
}
*{box-sizing:border-box}
html{scroll-padding-top:16px}
body{margin:0;background:var(--paper);color:var(--ink);font:400 17px/1.6 "IBM Plex Sans",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:56px 20px 72px}
h1,h2{font-family:"Bricolage Grotesque","IBM Plex Sans",system-ui,sans-serif;line-height:1.08;letter-spacing:-.02em;margin:0}
h1{font-weight:800;font-size:clamp(2.2rem,7vw,3.4rem)}
h2{font-weight:600;font-size:1.5rem;margin-bottom:14px}
.lead{color:var(--muted);max-width:56ch;margin:16px 0 28px}
.urlbox{display:flex;gap:8px;background:var(--card);border:2px solid var(--ink);border-radius:12px;padding:8px 8px 8px 16px;align-items:center}
.urlbox code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;font:500 .95rem "IBM Plex Mono",ui-monospace,monospace;scrollbar-width:none}
button{font:500 1rem "IBM Plex Sans",system-ui,sans-serif;background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
button:focus-visible,a:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.hint{font-size:.9rem;color:var(--muted);margin:10px 2px 0}
section{margin-top:56px}
ol{list-style:none;margin:0;padding:0;counter-reset:s}
ol li{counter-increment:s;position:relative;padding:0 0 28px 56px;border-left:2px solid var(--line);margin-left:18px}
ol li:last-child{border-color:transparent;padding-bottom:0}
ol li::before{content:counter(s);position:absolute;left:-19px;top:-2px;width:36px;height:36px;border-radius:50%;background:var(--ink);color:var(--paper);display:grid;place-items:center;font:600 1rem "Bricolage Grotesque",sans-serif}
ol h3{margin:0 0 4px;font-size:1.1rem}
ol p{margin:0;color:var(--muted)}
.ex{margin-top:10px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font:500 .92rem/1.5 "IBM Plex Mono",monospace;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.chips li{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:4px 14px;font:500 .88rem "IBM Plex Mono",monospace}
.warn{background:var(--warn-bg);color:var(--warn-ink);border-radius:12px;padding:20px 22px}
.warn h2{font-size:1.2rem;margin-bottom:8px}
.warn ul{margin:0;padding-left:20px}
.warn li+li{margin-top:6px}
footer{margin-top:56px;color:var(--muted);font-size:.9rem}
footer a{color:var(--accent)}
@media (prefers-reduced-motion:no-preference){button{transition:transform .1s}button:active{transform:scale(.97)}}
</style>
</head>
<body>
<main>
  <h1>Claude chatidan Telegram’ga yozing</h1>
  <p class="lead">Telegram botingizni Claude’ga ulang. Keyin chatda “guruhga bugungi hisobotni yubor” desangiz bo‘ldi: Claude xabarni o‘zi yuboradi, tahrirlaydi yoki o‘chiradi.</p>

  <div class="urlbox">
    <code id="url">/mcp</code>
    <button id="copy" type="button">Nusxalash</button>
  </div>
  <p class="hint">Bu connector manzili. Quyidagi 3 qadamda Claude’ga qo‘shasiz.</p>

  <section>
    <h2>Ulash</h2>
    <ol>
      <li>
        <h3>Bot yarating va tokenni oling</h3>
        <p>Telegram’da <b>@BotFather</b> ga o‘ting, <b>/newbot</b> yozing va ko‘rsatmalarga amal qiling. Oxirida token beradi.</p>
        <div class="ex">123456789:AAH-namuna-token-uzun-qator</div>
      </li>
      <li>
        <h3>Connector’ni qo‘shing</h3>
        <p>Claude ilovasida Sozlamalar → Connectors bo‘limida custom connector qo‘shing va yuqoridagi manzilni kiriting.</p>
      </li>
      <li>
        <h3>Tokenni chatda yuboring</h3>
        <p>Claude’ga tokenni yozing va nima qilishni ayting. Avval tekshirib ko‘ring:</p>
        <div class="ex">Shu bot tokenini get_me bilan tekshir: 123456789:AAH...</div>
      </li>
    </ol>
  </section>

  <section>
    <h2>Claude nima qila oladi</h2>
    <ul class="chips">
      <li>send_message</li><li>send_photo</li><li>send_document</li>
      <li>edit_message_text</li><li>delete_message</li><li>forward_message</li>
      <li>pin_chat_message</li><li>get_chat</li><li>get_chat_member</li>
      <li>ban_chat_member</li><li>get_updates</li><li>set_webhook</li>
      <li>call_api</li>
    </ul>
    <p class="hint">call_api orqali Telegram Bot API’ning istalgan metodini (so‘rovnoma, forum mavzusi va boshqalar) chaqirish mumkin.</p>
  </section>

  <section class="warn">
    <h2>Token xavfsizligi</h2>
    <ul>
      <li>Token chat tarixida qoladi. Muhim botingizni emas, alohida bot oching.</li>
      <li>Server tokenni saqlamaydi va log’ga yozmaydi: u faqat Telegram’ga so‘rov yuborish uchun ishlatiladi.</li>
      <li>Ishlatib bo‘lgach, BotFather’da <b>/revoke</b> qiling. Eski token shu zahoti o‘chadi.</li>
    </ul>
  </section>

  <footer>
    Ochiq kod: <a href="https://github.com/YOUR-USERNAME/telegram-mcp">github.com/YOUR-USERNAME/telegram-mcp</a>
  </footer>
</main>
<script>
document.getElementById('url').textContent = location.origin + '/mcp';
document.getElementById('copy').addEventListener('click', async function(){
  var b=this, t=document.getElementById('url').textContent;
  try{ await navigator.clipboard.writeText(t); b.textContent='Nusxalandi'; }
  catch(e){ b.textContent='Qo‘lda belgilang'; }
  setTimeout(function(){ b.textContent='Nusxalash'; }, 1800);
});
</script>
</body>
</html>
`;

export default async (request) => {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (url.pathname === "/mcp") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
    let payload;
    try { payload = await request.json(); }
    catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS }); }

    const batch = Array.isArray(payload);
    const results = (await Promise.all((batch ? payload : [payload]).map(handleRpc))).filter(Boolean);
    if (!results.length) return new Response(null, { status: 202, headers: CORS });
    return Response.json(batch ? results : results[0], { headers: CORS });
  }

  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
};

export const config = { path: ["/", "/mcp"] };
