import { Router, type IRouter } from "express";

const router: IRouter = Router();

const PAYSTACK_BASE  = "https://api.paystack.co";
const TG_BASE        = () => `https://api.telegram.org/bot${process.env["TELEGRAM_BOT_TOKEN"]}`;
const PAYSTACK_KEY   = () => process.env["PAYSTACK_SECRET_KEY"] ?? "";
const FRONTEND_URL   = process.env["FRONTEND_URL"] ?? `https://${process.env["REPLIT_DOMAINS"] ?? ""}`;

// In-memory session store
const sessions = new Map<number, { step: string; amount?: number; phone?: string; reference?: string }>();

// ─── Webhook entry — respond 200 immediately, process async ──────────────────
router.post("/bot", (req, res) => {
  res.sendStatus(200);
  const update = req.body as TelegramUpdate;
  handleUpdate(update).catch(() => {/* silent */});
});

interface TelegramUpdate {
  message?: {
    chat: { id: number; first_name?: string };
    text?: string;
    reply_to_message?: { text?: string };
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleUpdate(update: TelegramUpdate) {
  const msg = update.message;
  if (!msg) return;

  const chatId    = msg.chat.id;
  const firstName = esc(msg.chat.first_name ?? "there");
  const text      = (msg.text ?? "").trim();
  const replyText = msg.reply_to_message?.text ?? "";
  const session   = sessions.get(chatId) ?? { step: "idle" };

  // ── /start  /pay  1 ────────────────────────────────────────────────────────
  if (["/start", "/pay", "1"].includes(text) || text.toLowerCase() === "pay") {
    sessions.set(chatId, { step: "await_method" });
    await sendWithButtons(chatId,
      `👋 <b>Welcome, ${firstName}!</b>\n\n` +
      `You've reached the <b>BintuPay Secure Payment Portal</b>.\n\n` +
      `How would you like to pay?`,
      [[
        { text: "💚  M-Pesa", callback_data: "method_mpesa" },
        { text: "💳  Card Payment", url: FRONTEND_URL },
      ]]
    );
    return;
  }

  // ── /card or "card" keyword ────────────────────────────────────────────────
  if (text === "/card" || text.toLowerCase() === "card") {
    await sendWithButtons(chatId,
      `💳 <b>Card Payment</b>\n\n` +
      `Tap the button below to open the <b>BintuPay secure card payment page</b>.\n\n` +
      `<i>You can pay with Visa, Mastercard, or Amex — protected by 256-bit SSL encryption.</i>`,
      [[{ text: "🔒  Open Card Payment Page", url: FRONTEND_URL }]]
    );
    return;
  }

  // ── /mpesa ─────────────────────────────────────────────────────────────────
  if (text === "/mpesa" || text === "mpesa") {
    sessions.set(chatId, { step: "await_amount" });
    await sendForceReply(chatId,
      `💚 <b>M-Pesa Payment</b>\n\n` +
      `Please enter the <b>amount</b> you wish to pay (KES):\n` +
      `<i>Example: 500</i>`
    );
    return;
  }

  // ── /help ──────────────────────────────────────────────────────────────────
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
      `<b>M-Pesa steps:</b>\n` +
      `1. Type /pay and choose M-Pesa\n` +
      `2. Enter the amount\n` +
      `3. Enter your phone number\n` +
      `4. Enter your PIN on the STK push\n` +
      `5. Receive instant confirmation\n\n` +
      `<i>All transactions are secured via Paystack.</i>`
    );
    return;
  }

  // ── /status ────────────────────────────────────────────────────────────────
  if (text === "/status") {
    sessions.set(chatId, { step: "await_status_ref" });
    await sendForceReply(chatId,
      `🔍 <b>Transaction Status</b>\n\n` +
      `Enter your <b>transaction reference</b> to check its status:`
    );
    return;
  }

  // ── /receipt ───────────────────────────────────────────────────────────────
  if (text === "/receipt") {
    sessions.set(chatId, { step: "await_receipt_ref" });
    await sendForceReply(chatId,
      `🧾 <b>Payment Receipt</b>\n\n` +
      `Enter your <b>transaction reference</b> to retrieve your receipt:`
    );
    return;
  }

  // Inline: /receipt <ref>
  if (text.startsWith("/receipt ")) {
    await buildAndSendReceipt(chatId, text.replace("/receipt ", "").trim());
    return;
  }

  // ── Session / reply-context step detection ─────────────────────────────────
  let step = session.step;
  if (step === "idle" && replyText) {
    if (replyText.includes("amount") && replyText.includes("KES"))     step = "await_amount";
    else if (replyText.includes("phone number"))                        step = "await_phone";
    else if (replyText.includes("status") && replyText.includes("reference")) step = "await_status_ref";
    else if (replyText.includes("receipt") && replyText.includes("reference")) step = "await_receipt_ref";
  }

  // STEP: amount ──────────────────────────────────────────────────────────────
  if (step === "await_amount") {
    const num = parseFloat(text.replace(/,/g, ""));
    if (isNaN(num) || num < 10) {
      await sendForceReply(chatId,
        `⚠️ <b>Invalid Amount</b>\n\n` +
        `Minimum transaction is KES 10.\n\n` +
        `Enter a valid amount (KES):`
      );
      return;
    }
    sessions.set(chatId, { step: "await_phone", amount: Math.round(num) });
    await sendForceReply(chatId,
      `✅ <b>Amount set:</b> KES ${Math.round(num).toLocaleString()}\n\n` +
      `Enter the <b>M-Pesa phone number</b> to charge:\n` +
      `<i>Format: 07XXXXXXXX or 01XXXXXXXX</i>`
    );
    return;
  }

  // STEP: phone → trigger charge + poll ──────────────────────────────────────
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
        `<code>${esc(phone)}</code> is not recognised.\n` +
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

      if (!chargeRes.status || !(chargeRes.data as Record<string,string>)?.reference) {
        await sendMsg(chatId,
          `❌ <b>Payment Initialisation Failed</b>\n\n` +
          `<b>Reason:</b> ${esc(chargeRes.message ?? "Gateway rejected the request")}\n\n` +
          `<i>Type /pay to try again.</i>`
        );
        sessions.set(chatId, { step: "idle" });
        return;
      }

      reference = (chargeRes.data as Record<string,string>).reference;
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
      await sendMsg(chatId, `❌ <b>Network Error</b>\n\nCould not reach the payment gateway. Please try again with /pay.`);
      sessions.set(chatId, { step: "idle" });
      return;
    }

    // Poll every 3s for up to 50s
    let resolved = false;
    for (let i = 0; i < 16; i++) {
      await sleep(3000);
      try {
        const check    = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
        const txStatus = (check.data as Record<string,string>)?.status ?? "";
        const gwMsg    = (check.data as Record<string,string>)?.gateway_response ?? "Unknown";

        if (txStatus === "success") {
          sessions.set(chatId, { step: "idle" });
          await sendMsg(chatId,
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
            `Your payment has been received. Thank you for using <b>BintuPay</b>!\n\n` +
            `<i>Type /receipt ${esc(reference)} to retrieve this receipt again.</i>`
          );
          resolved = true;
          break;
        }

        if (txStatus === "failed") {
          sessions.set(chatId, { step: "idle" });
          await sendMsg(chatId,
            `❌ <b>Transaction Declined</b>\n\n` +
            `<pre>` +
            `Amount : KES ${amount.toLocaleString()}\n` +
            `Phone  : ${phone}\n` +
            `Reason : ${gwMsg}` +
            `</pre>\n\n` +
            `Please check:\n` +
            `• Sufficient M-Pesa balance\n` +
            `• Correct PIN was entered\n` +
            `• Daily transaction limit not exceeded\n\n` +
            `<i>Type /pay to retry.</i>`
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
      await sendMsg(chatId,
        `⏰ <b>Verification Timeout</b>\n\n` +
        `<pre>Ref : ${reference}</pre>\n` +
        `We could not confirm within 50 seconds.\n\n` +
        `Check your M-Pesa messages for confirmation. If funds were deducted without service, contact support with the reference above.\n\n` +
        `<i>Type /pay to start a new transaction.</i>`
      );
    }
    return;
  }

  // STEP: status reference ────────────────────────────────────────────────────
  if (step === "await_status_ref") {
    const ref = text.trim();
    sessions.set(chatId, { step: "idle" });
    await sendMsg(chatId, `🔍 <i>Checking status for <code>${esc(ref)}</code>…</i>`);
    try {
      const check    = await paystackGet(`/transaction/verify/${encodeURIComponent(ref)}`);
      const status   = (check.data as Record<string,string>)?.status ?? "";
      const gwMsg    = (check.data as Record<string,string>)?.gateway_response ?? "Unknown";
      const icon     = status === "success" ? "✅" : status === "failed" ? "❌" : "⏳";
      await sendMsg(chatId,
        `${icon} <b>Transaction Status</b>\n\n` +
        `<pre>` +
        `Reference : ${ref}\n` +
        `Status    : ${status || "not found"}\n` +
        (gwMsg && status !== "success" ? `Note      : ${gwMsg}` : "") +
        `</pre>` +
        (status !== "success" && status !== "failed" && status ? `\n<i>Still processing. Check again in a moment.</i>` : "") +
        (!status ? `\n<i>No transaction found. Please verify the reference.</i>` : "")
      );
    } catch {
      await sendMsg(chatId, `❌ <b>Error</b>\n\nCould not verify the reference. Please try again.`);
    }
    return;
  }

  // STEP: receipt reference ───────────────────────────────────────────────────
  if (step === "await_receipt_ref") {
    sessions.set(chatId, { step: "idle" });
    await buildAndSendReceipt(chatId, text.trim());
    return;
  }

  // ── Fallback ────────────────────────────────────────────────────────────────
  await sendWithButtons(chatId,
    `ℹ️ <b>BintuPay Payment Bot</b>\n\n` +
    `Choose an option or use a command:\n` +
    `/pay — new payment\n` +
    `/status — check transaction\n` +
    `/receipt — get receipt\n` +
    `/help — full guide`,
    [[
      { text: "💚  M-Pesa", callback_data: "method_mpesa" },
      { text: "💳  Card Payment", url: FRONTEND_URL },
    ]]
  );
}

// ─── Receipt builder ─────────────────────────────────────────────────────────
async function buildAndSendReceipt(chatId: number, reference: string) {
  await sendMsg(chatId, `🧾 <i>Retrieving receipt for <code>${esc(reference)}</code>…</i>`);
  try {
    const check = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
    const d = check.data as Record<string, unknown> | null;

    if (!check.status || !d) {
      await sendMsg(chatId,
        `⚠️ <b>Receipt Not Found</b>\n\n` +
        `No transaction found for <code>${esc(reference)}</code>.\n` +
        `<i>Please verify the reference and try again.</i>`
      );
      return;
    }

    const status   = (d["status"]           as string) ?? "unknown";
    const amount   = ((d["amount"]          as number) ?? 0) / 100;
    const currency = (d["currency"]         as string) ?? "KES";
    const gwMsg    = (d["gateway_response"] as string) ?? "";
    const paidAt   = d["paid_at"]           as string | null;
    const channel  = (d["channel"]          as string) ?? "unknown";
    const customerData = d["customer"] as Record<string, string> | null;
    const email    = customerData?.["email"] ?? "";
    const authData = d["authorization"]     as Record<string, string> | null;
    const mobile   = authData?.["mobile_money_number"] ?? authData?.["last4"] ?? "";
    const dateStr  = paidAt
      ? new Date(paidAt).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" })
      : "—";

    if (status !== "success") {
      await sendMsg(chatId,
        `❌ <b>No Receipt Available</b>\n\n` +
        `<pre>` +
        `Reference : ${reference}\n` +
        `Status    : ${status}\n` +
        (gwMsg ? `Note      : ${gwMsg}` : "") +
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
      (email  ? `Email  : ${email}\n`  : "") +
      `\n` +
      `Status : CONFIRMED ✅\n` +
      `\n` +
      `Ref    : ${reference}\n` +
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

// ─── Telegram helpers ─────────────────────────────────────────────────────────
async function sendMsg(chatId: number, html: string) {
  await fetch(`${TG_BASE()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML" }),
  });
}

async function sendForceReply(chatId: number, html: string) {
  await fetch(`${TG_BASE()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text: html, parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    }),
  });
}

async function sendWithButtons(chatId: number, html: string, buttons: Array<Array<{ text: string; url?: string; callback_data?: string }>>) {
  await fetch(`${TG_BASE()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text: html, parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
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
