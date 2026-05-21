import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const PAYSTACK_BASE = "https://api.paystack.co";
const TG_BASE       = () => `https://api.telegram.org/bot${process.env["TELEGRAM_BOT_TOKEN"]}`;
const PAYSTACK_KEY  = () => process.env["PAYSTACK_SECRET_KEY"] ?? "";

function getFrontendUrl(): string {
  if (process.env["FRONTEND_URL"]) return process.env["FRONTEND_URL"];
  const domains = process.env["REPLIT_DOMAINS"] ?? "";
  const first   = domains.split(",")[0]?.trim() ?? "";
  return first ? `https://${first}` : "";
}

// Preset amounts shown as quick-pick buttons (KES)
const PRESET_AMOUNTS = [99, 500, 1000];

// In-memory session store
type Session = { step: string; amount?: number; phone?: string; reference?: string };
const sessions = new Map<number, Session>();

// ─── Types ────────────────────────────────────────────────────────────────────
interface TelegramMessage {
  chat: { id: number; first_name?: string };
  text?: string;
  reply_to_message?: { text?: string };
}
interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string };
    message?: { chat: { id: number } };
    data?: string;
  };
}
type InlineButton = { text: string; url?: string; callback_data?: string };

// ─── Webhook entry ────────────────────────────────────────────────────────────
router.post("/bot", (req, res) => {
  res.sendStatus(200);
  const update = req.body as TelegramUpdate;
  handleUpdate(update).catch((err: unknown) => {
    logger.error({ err }, "Unhandled error in bot handleUpdate");
  });
});

// ─── Main dispatcher ──────────────────────────────────────────────────────────
async function handleUpdate(update: TelegramUpdate) {
  // Callback query (inline button tap)
  if (update.callback_query) {
    const cq      = update.callback_query;
    const chatId  = cq.message?.chat.id ?? cq.from.id;
    const name    = cq.from.first_name ?? "there";
    await answerCallback(cq.id);
    await handleCallbackData(chatId, cq.data ?? "", name);
    return;
  }

  // Regular message
  if (update.message) {
    await handleMessage(update.message);
  }
}

// ─── Callback query handler ───────────────────────────────────────────────────
async function handleCallbackData(chatId: number, data: string, name: string) {
  // M-Pesa selected from method menu
  if (data === "method_mpesa") {
    sessions.set(chatId, { step: "await_amount" });
    await sendAmountMenu(chatId);
    return;
  }

  // Preset amount button
  if (data.startsWith("amount_")) {
    const val = data.replace("amount_", "");
    if (val === "custom") {
      sessions.set(chatId, { step: "await_amount_custom" });
      await sendForceReply(chatId,
        `✏️ <b>Enter Custom Amount</b>\n\n` +
        `Type the amount you wish to pay (KES):\n` +
        `<i>Minimum: KES 10</i>`
      );
      return;
    }
    const amount = parseInt(val, 10);
    sessions.set(chatId, { step: "await_phone", amount });
    await sendPhonePrompt(chatId, amount);
    return;
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────
async function handleMessage(msg: TelegramMessage) {
  const chatId    = msg.chat.id;
  const firstName = esc(msg.chat.first_name ?? "there");
  const text      = (msg.text ?? "").trim();
  const replyText = msg.reply_to_message?.text ?? "";
  const session   = sessions.get(chatId) ?? { step: "idle" };

  // ── /start  /pay ─────────────────────────────────────────────────────────
  if (["/start", "/pay", "1"].includes(text) || text.toLowerCase() === "pay") {
    sessions.set(chatId, { step: "await_method" });
    await sendMethodMenu(chatId, firstName);
    return;
  }

  // ── /card ─────────────────────────────────────────────────────────────────
  if (text === "/card" || text.toLowerCase() === "card") {
    const cardUrl = getFrontendUrl();
    const body = `💳 <b>Card Payment</b>\n\n` +
      `Tap the button below to open the <b>BintuPay secure card payment page</b>.\n\n` +
      `<i>Visa, Mastercard, Amex — protected by 256-bit SSL encryption.</i>`;
    if (cardUrl) {
      await sendWithButtons(chatId, body, [[{ text: "🔒  Open Card Payment Page", url: cardUrl }]]);
    } else {
      await sendMsg(chatId, body + `\n\n⚠️ <i>Card payment link is not configured on this server yet.</i>`);
    }
    return;
  }

  // ── /mpesa ───────────────────────────────────────────────────────────────
  if (text === "/mpesa" || text.toLowerCase() === "mpesa") {
    sessions.set(chatId, { step: "await_amount" });
    await sendAmountMenu(chatId);
    return;
  }

  // ── /help ────────────────────────────────────────────────────────────────
  if (text === "/help") {
    await sendMsg(chatId,
      `🛡 <b>BintuPay — Help Guide</b>\n\n` +
      `<b>Commands:</b>\n` +
      `/pay — Start a new payment\n` +
      `/mpesa — Pay via M-Pesa\n` +
      `/card — Pay via credit/debit card\n` +
      `/status — Check a transaction\n` +
      `/receipt — Get a payment receipt\n` +
      `/help — Show this guide\n\n` +
      `<b>M-Pesa flow:</b>\n` +
      `1. /pay → choose M-Pesa\n` +
      `2. Select a quick amount or enter your own\n` +
      `3. Enter your phone number\n` +
      `4. Enter your M-Pesa PIN on the STK push\n` +
      `5. Receive instant confirmation\n\n` +
      `<i>All transactions are secured via Paystack.</i>`
    );
    return;
  }

  // ── /status ──────────────────────────────────────────────────────────────
  if (text === "/status") {
    sessions.set(chatId, { step: "await_status_ref" });
    await sendForceReply(chatId,
      `🔍 <b>Transaction Status</b>\n\n` +
      `Enter your <b>transaction reference</b> to check its status:`
    );
    return;
  }

  // ── /receipt ─────────────────────────────────────────────────────────────
  if (text === "/receipt") {
    sessions.set(chatId, { step: "await_receipt_ref" });
    await sendForceReply(chatId,
      `🧾 <b>Payment Receipt</b>\n\n` +
      `Enter your <b>transaction reference</b> to retrieve your receipt:`
    );
    return;
  }
  if (text.startsWith("/receipt ")) {
    await buildAndSendReceipt(chatId, text.replace("/receipt ", "").trim());
    return;
  }

  // ── Detect step from reply context when session is idle ──────────────────
  let step = session.step;
  if (step === "idle" && replyText) {
    if (replyText.includes("custom amount") || (replyText.includes("amount") && replyText.includes("KES"))) {
      step = "await_amount_custom";
    } else if (replyText.includes("phone number")) {
      step = "await_phone";
    } else if (replyText.includes("status") && replyText.includes("reference")) {
      step = "await_status_ref";
    } else if (replyText.includes("receipt") && replyText.includes("reference")) {
      step = "await_receipt_ref";
    }
  }

  // STEP: custom amount input ──────────────────────────────────────────────
  if (step === "await_amount_custom" || step === "await_amount") {
    const num = parseFloat(text.replace(/,/g, ""));
    if (isNaN(num) || num < 10) {
      await sendForceReply(chatId,
        `⚠️ <b>Invalid Amount</b>\n\n` +
        `Minimum is KES 10.\n\n` +
        `Enter a valid amount (KES):`
      );
      return;
    }
    const amount = Math.round(num);
    sessions.set(chatId, { step: "await_phone", amount });
    await sendPhonePrompt(chatId, amount);
    return;
  }

  // STEP: phone → STK push + poll ──────────────────────────────────────────
  if (step === "await_phone") {
    let amount = session.amount ?? 0;
    if (!amount) {
      const m = replyText.match(/KES\s*([\d,]+)/i);
      if (m) amount = parseInt(m[1].replace(/,/g, ""), 10);
    }
    if (!amount) {
      await sendMsg(chatId,
        `⚠️ <b>Session Expired</b>\n\nWe could not retrieve your session. Type /pay to start again.`
      );
      sessions.delete(chatId);
      return;
    }

    const phone = text.replace(/\D/g, "");
    if (!/^(07|01)\d{8}$/.test(phone)) {
      await sendForceReply(chatId,
        `⚠️ <b>Invalid Phone Number</b>\n\n` +
        `<code>${esc(phone || text)}</code> is not recognised.\n` +
        `Use format <code>07XXXXXXXX</code> or <code>01XXXXXXXX</code>:`
      );
      return;
    }

    sessions.set(chatId, { step: "processing", amount, phone });
    await sendMsg(chatId,
      `⏳ <b>Initiating Secure Transaction…</b>\n\n` +
      `<i>Connecting to M-Pesa for KES ${amount.toLocaleString()} — please wait.</i>`
    );

    const formatted = `+254${phone.slice(1)}`;
    const email     = `user_${phone}@bintupay.com`;
    let reference   = "";

    try {
      const chargeRes = await paystackPost("/charge", {
        email, amount: amount * 100, currency: "KES",
        mobile_money: { phone: formatted, provider: "mpesa" },
      });

      const data = chargeRes.data as Record<string, string> | null;
      if (!chargeRes.status || !data?.["reference"]) {
        await sendMsg(chatId,
          `❌ <b>Payment Initialisation Failed</b>\n\n` +
          `<b>Reason:</b> ${esc(chargeRes.message ?? "Gateway rejected the request")}\n\n` +
          `<i>Type /pay to try again.</i>`
        );
        sessions.set(chatId, { step: "idle" });
        return;
      }

      reference = data["reference"];
      sessions.set(chatId, { step: "polling", amount, phone, reference });

      await sendMsg(chatId,
        `📲 <b>STK Push Sent!</b>\n\n` +
        `<pre>` +
        `Amount : KES ${amount.toLocaleString()}\n` +
        `Phone  : ${phone}\n` +
        `Ref    : ${reference}` +
        `</pre>\n` +
        `👉 Open your phone and enter your <b>M-Pesa PIN</b> to complete.\n\n` +
        `<i>Monitoring status — you will be notified immediately once it confirms.</i>`
      );
    } catch {
      await sendMsg(chatId,
        `❌ <b>Network Error</b>\n\nCould not reach the payment gateway. Please try again with /pay.`
      );
      sessions.set(chatId, { step: "idle" });
      return;
    }

    // Poll every 3 s for up to 50 s
    let resolved = false;
    for (let i = 0; i < 16; i++) {
      await sleep(3000);
      try {
        const check    = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
        const tx       = check.data as Record<string, string> | null;
        const txStatus = tx?.["status"] ?? "";
        const gwMsg    = tx?.["gateway_response"] ?? "Unknown";

        if (txStatus === "success") {
          sessions.set(chatId, { step: "idle" });
          await sendWithButtons(chatId,
            `🎉 <b>Payment Confirmed!</b>\n\n` +
            `<pre>` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `  BINTUPAY — RECEIPT\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Amount : KES ${amount.toLocaleString()}\n` +
            `Phone  : ${phone}\n` +
            `Method : M-Pesa\n` +
            `Ref    : ${reference}\n` +
            `Status : CONFIRMED ✅\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━` +
            `</pre>\n\n` +
            `Thank you for using <b>BintuPay</b>! 🙏`,
            [[{ text: "💚  Pay Again", callback_data: "method_mpesa" }]]
          );
          resolved = true;
          break;
        }

        if (txStatus === "failed") {
          sessions.set(chatId, { step: "idle" });
          await sendWithButtons(chatId,
            `❌ <b>Transaction Declined</b>\n\n` +
            `<pre>` +
            `Amount : KES ${amount.toLocaleString()}\n` +
            `Phone  : ${phone}\n` +
            `Reason : ${esc(gwMsg)}` +
            `</pre>\n\n` +
            `Please check:\n` +
            `• Sufficient M-Pesa balance\n` +
            `• Correct PIN was entered\n` +
            `• Daily limit not exceeded`,
            [[{ text: "🔄  Try Again", callback_data: "method_mpesa" }]]
          );
          resolved = true;
          break;
        }

        if (i === 7) {
          await sendMsg(chatId,
            `🔄 <i>Still waiting for your PIN confirmation. Please check your phone and enter your M-Pesa PIN.</i>`
          );
        }
      } catch { /* keep polling */ }
    }

    if (!resolved) {
      sessions.set(chatId, { step: "idle" });
      await sendWithButtons(chatId,
        `⏰ <b>Verification Timeout</b>\n\n` +
        `<pre>Ref : ${reference}</pre>\n` +
        `We could not confirm within 50 seconds.\n\n` +
        `Check your M-Pesa messages. If funds were deducted without service, contact support with the reference above.`,
        [[{ text: "🔄  Try Again", callback_data: "method_mpesa" }]]
      );
    }
    return;
  }

  // STEP: status reference ──────────────────────────────────────────────────
  if (step === "await_status_ref") {
    const ref = text.trim();
    sessions.set(chatId, { step: "idle" });
    await sendMsg(chatId, `🔍 <i>Checking status for <code>${esc(ref)}</code>…</i>`);
    try {
      const check    = await paystackGet(`/transaction/verify/${encodeURIComponent(ref)}`);
      const tx       = check.data as Record<string, string> | null;
      const status   = tx?.["status"] ?? "";
      const gwMsg    = tx?.["gateway_response"] ?? "";
      const icon     = status === "success" ? "✅" : status === "failed" ? "❌" : "⏳";
      await sendMsg(chatId,
        `${icon} <b>Transaction Status</b>\n\n` +
        `<pre>` +
        `Reference : ${esc(ref)}\n` +
        `Status    : ${status || "not found"}\n` +
        (gwMsg && status !== "success" ? `Note      : ${esc(gwMsg)}\n` : "") +
        `</pre>` +
        (!status ? `\n<i>No transaction found. Please verify the reference.</i>` : "")
      );
    } catch {
      await sendMsg(chatId, `❌ <b>Error</b>\n\nCould not verify the reference. Please try again.`);
    }
    return;
  }

  // STEP: receipt reference ─────────────────────────────────────────────────
  if (step === "await_receipt_ref") {
    sessions.set(chatId, { step: "idle" });
    await buildAndSendReceipt(chatId, text.trim());
    return;
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  await sendMethodMenu(chatId, firstName);
}

// ─── Amount menu ─────────────────────────────────────────────────────────────
async function sendAmountMenu(chatId: number) {
  const amountButtons: InlineButton[] = PRESET_AMOUNTS.map(a => ({
    text: `KES ${a.toLocaleString()}`,
    callback_data: `amount_${a}`,
  }));
  await sendWithButtons(chatId,
    `💚 <b>M-Pesa Payment</b>\n\n` +
    `Select an amount or enter your own:`,
    [
      amountButtons,
      [{ text: "✏️  Enter Amount", callback_data: "amount_custom" }],
    ]
  );
}

// ─── Phone prompt ─────────────────────────────────────────────────────────────
async function sendPhonePrompt(chatId: number, amount: number) {
  await sendForceReply(chatId,
    `✅ <b>Amount:</b> KES ${amount.toLocaleString()}\n\n` +
    `Enter the <b>M-Pesa phone number</b> to charge:\n` +
    `<i>Format: 07XXXXXXXX or 01XXXXXXXX</i>`
  );
}

// ─── Method menu ──────────────────────────────────────────────────────────────
async function sendMethodMenu(chatId: number, firstName: string) {
  const cardUrl = getFrontendUrl();
  const row: InlineButton[] = [{ text: "💚  M-Pesa", callback_data: "method_mpesa" }];
  if (cardUrl) row.push({ text: "💳  Card Payment", url: cardUrl });
  await sendWithButtons(chatId,
    `👋 <b>Welcome, ${firstName}!</b>\n\n` +
    `You've reached the <b>BintuPay Secure Payment Portal</b>.\n\n` +
    `How would you like to pay?`,
    [row]
  );
}

// ─── Receipt builder ──────────────────────────────────────────────────────────
async function buildAndSendReceipt(chatId: number, reference: string) {
  await sendMsg(chatId, `🧾 <i>Retrieving receipt for <code>${esc(reference)}</code>…</i>`);
  try {
    const check = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
    const d     = check.data as Record<string, unknown> | null;

    if (!check.status || !d) {
      await sendMsg(chatId,
        `⚠️ <b>Receipt Not Found</b>\n\n` +
        `No transaction found for <code>${esc(reference)}</code>.\n` +
        `<i>Please verify the reference and try again.</i>`
      );
      return;
    }

    const status    = (d["status"]           as string) ?? "unknown";
    const amount    = ((d["amount"]          as number) ?? 0) / 100;
    const currency  = (d["currency"]         as string) ?? "KES";
    const gwMsg     = (d["gateway_response"] as string) ?? "";
    const paidAt    = d["paid_at"]           as string | null;
    const channel   = (d["channel"]          as string) ?? "unknown";
    const customer  = d["customer"]          as Record<string, string> | null;
    const email     = customer?.["email"]    ?? "";
    const auth      = d["authorization"]     as Record<string, string> | null;
    const mobile    = auth?.["mobile_money_number"] ?? auth?.["last4"] ?? "";
    const dateStr   = paidAt
      ? new Date(paidAt).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" })
      : "—";

    if (status !== "success") {
      await sendMsg(chatId,
        `❌ <b>No Receipt Available</b>\n\n` +
        `<pre>` +
        `Reference : ${esc(reference)}\n` +
        `Status    : ${status}\n` +
        (gwMsg ? `Note      : ${esc(gwMsg)}\n` : "") +
        `</pre>\n` +
        `<i>Receipts are only issued for confirmed payments.</i>`
      );
      return;
    }

    const methodLabel = channel === "mobile_money" ? "M-Pesa" : channel === "card" ? "Card" : channel;

    await sendMsg(chatId,
      `🧾 <b>BintuPay — Payment Receipt</b>\n\n` +
      `<pre>` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  OFFICIAL RECEIPT\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Date   : ${dateStr}\n` +
      `Amount : ${currency} ${amount.toLocaleString("en-KE", { minimumFractionDigits: 2 })}\n` +
      `Method : ${methodLabel}\n` +
      (mobile ? `Account: ${mobile}\n` : "") +
      (email  ? `Email  : ${esc(email)}\n` : "") +
      `\n` +
      `Status : CONFIRMED ✅\n` +
      `\n` +
      `Ref    : ${esc(reference)}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━` +
      `</pre>\n\n` +
      `<i>Keep this reference for your records. Powered by BintuPay via Paystack.</i>`
    );
  } catch {
    await sendMsg(chatId, `❌ <b>Error</b>\n\nCould not retrieve the receipt at this time. Please try again.`);
  }
}

// ─── Paystack helpers ─────────────────────────────────────────────────────────
async function paystackPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_KEY()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ status: boolean; message?: string; data?: unknown }>;
}
async function paystackGet(path: string) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_KEY()}` },
  });
  return res.json() as Promise<{ status: boolean; message?: string; data?: unknown }>;
}

// ─── Telegram API helpers ─────────────────────────────────────────────────────
async function tgPost(path: string, body: Record<string, unknown>): Promise<void> {
  const res  = await fetch(`${TG_BASE()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    logger.error({ path, status: res.status, body: text }, "Telegram API error");
  } else {
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (json && !json["ok"]) {
      logger.warn({ path, response: json }, "Telegram API returned ok:false");
    }
  }
}

async function sendMsg(chatId: number, html: string) {
  await tgPost("/sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" });
}

async function sendForceReply(chatId: number, html: string) {
  await tgPost("/sendMessage", {
    chat_id: chatId, text: html, parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true },
  });
}

async function sendWithButtons(chatId: number, html: string, buttons: InlineButton[][]) {
  await tgPost("/sendMessage", {
    chat_id: chatId, text: html, parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function answerCallback(callbackQueryId: string) {
  await tgPost("/answerCallbackQuery", { callback_query_id: callbackQueryId });
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function esc(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

export default router;
