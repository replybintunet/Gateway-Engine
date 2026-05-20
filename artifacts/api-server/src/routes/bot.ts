import { Router, type IRouter } from "express";

const router: IRouter = Router();

const PAYSTACK_BASE = "https://api.paystack.co";
const TG_BASE = () => `https://api.telegram.org/bot${process.env["TELEGRAM_BOT_TOKEN"]}`;
const PAYSTACK_KEY = () => process.env["PAYSTACK_SECRET_KEY"] ?? "";

// In-memory session store: chatId → { step, amount, phone, reference }
const sessions = new Map<number, { step: string; amount?: number; phone?: string; reference?: string }>();

// ─── Webhook entry — respond 200 immediately, process async ──────────────────
router.post("/bot", (req, res) => {
  res.sendStatus(200); // Telegram gets instant acknowledgement
  const update = req.body as TelegramUpdate;
  handleUpdate(update).catch(() => {/* silent */});
});

// ─── Types ────────────────────────────────────────────────────────────────────
interface TelegramUpdate {
  message?: {
    chat: { id: number; first_name?: string };
    text?: string;
    message_id?: number;
    reply_to_message?: { text?: string; message_id?: number };
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleUpdate(update: TelegramUpdate) {
  const msg = update.message;
  if (!msg) return;

  const chatId     = msg.chat.id;
  const firstName  = msg.chat.first_name ?? "there";
  const text       = (msg.text ?? "").trim();
  const replyText  = msg.reply_to_message?.text ?? "";
  const session    = sessions.get(chatId) ?? { step: "idle" };

  // ── /start  /pay  1 ────────────────────────────────────────────────────────
  if (["/start", "/pay", "1"].includes(text) || text.toLowerCase() === "pay") {
    sessions.set(chatId, { step: "await_amount" });
    await sendForceReply(chatId,
      `👋 Welcome back, *${escMd(firstName)}*\\!\n\n` +
      `You've reached the *BintuPay Secure Payment Portal*\\.\n\n` +
      `Please enter the *amount* you wish to pay \\(KES\\)\\. For example: \`500\``
    );
    return;
  }

  // ── /help ──────────────────────────────────────────────────────────────────
  if (text === "/help") {
    await sendMsg(chatId,
      `🛡 *BintuPay Payment Bot — Help Guide*\n\n` +
      `Here's how to make a payment:\n\n` +
      `1\\. Type \`/pay\` to start a new transaction\n` +
      `2\\. Enter the payment amount when prompted\n` +
      `3\\. Enter your M\\-Pesa phone number\n` +
      `4\\. Check your phone for the STK push and enter your PIN\n` +
      `5\\. Receive instant confirmation once payment is verified\n\n` +
      `*Other commands:*\n` +
      `• \`/status\` — check a transaction by reference\n` +
      `• \`/receipt\` — retrieve a payment receipt\n\n` +
      `_All transactions are secured end\\-to\\-end via Paystack\\._`
    );
    return;
  }

  // ── /status ────────────────────────────────────────────────────────────────
  if (text === "/status") {
    sessions.set(chatId, { step: "await_status_ref" });
    await sendForceReply(chatId,
      `🔍 *Transaction Status Check*\n\nPlease enter your *transaction reference* to check its current status:`
    );
    return;
  }

  // ── /receipt ───────────────────────────────────────────────────────────────
  if (text === "/receipt") {
    sessions.set(chatId, { step: "await_receipt_ref" });
    await sendForceReply(chatId,
      `🧾 *Payment Receipt Lookup*\n\nPlease enter your *transaction reference* to retrieve your receipt:`
    );
    return;
  }

  // ── Session-based step handling ────────────────────────────────────────────

  // Detect step from session OR fall back to reading reply context
  let step = session.step;
  if (step === "idle" && replyText) {
    if (replyText.includes("amount you wish to pay") || replyText.includes("exact amount")) step = "await_amount";
    else if (replyText.includes("M-Pesa phone number") || replyText.includes("phone number to charge")) step = "await_phone";
    else if (replyText.includes("transaction reference") && replyText.includes("status")) step = "await_status_ref";
    else if (replyText.includes("transaction reference") && replyText.includes("receipt")) step = "await_receipt_ref";
  }

  // STEP: amount
  if (step === "await_amount") {
    const num = parseFloat(text.replace(/,/g, ""));
    if (isNaN(num) || num < 10) {
      await sendForceReply(chatId,
        `⚠️ *Invalid Amount*\n\nMinimum transaction is KES 10\\.\n\nPlease enter a valid amount \\(KES\\):`
      );
      return;
    }
    sessions.set(chatId, { step: "await_phone", amount: Math.round(num) });
    const fmt = Math.round(num).toLocaleString();
    await sendForceReply(chatId,
      `✅ *Amount Set:* KES ${escMd(fmt)}\n\n` +
      `Now please enter the *M\\-Pesa phone number* to charge\\.\n` +
      `Accepted formats: \`07XXXXXXXX\` or \`01XXXXXXXX\``
    );
    return;
  }

  // STEP: phone → trigger charge + poll
  if (step === "await_phone") {
    // Recover amount from session or reply context
    let amount = session.amount ?? 0;
    if (!amount) {
      const m = replyText.match(/KES\s*([\d,]+)/i);
      if (m) amount = parseInt(m[1].replace(/,/g, ""), 10);
    }
    if (!amount) {
      await sendMsg(chatId,
        `⚠️ *Session Expired*\n\nWe could not retrieve your session\\. Please type \`/pay\` to start again\\.`
      );
      sessions.delete(chatId);
      return;
    }

    const phone = text.replace(/\D/g, "");
    if (!/^(07|01)\d{8}$/.test(phone)) {
      await sendForceReply(chatId,
        `⚠️ *Invalid Phone Number*\n\n` +
        `\`${escMd(phone)}\` is not recognised\\. Use format \`07XXXXXXXX\` or \`01XXXXXXXX\`:`
      );
      return;
    }

    sessions.set(chatId, { step: "processing", amount, phone });

    await sendMsg(chatId,
      `⏳ *Initiating Secure Transaction\\.\\.\\.*\n\n` +
      `_Connecting to M\\-Pesa for KES ${escMd(amount.toLocaleString())} — please wait\\._`
    );

    // Format phone for Paystack
    const formatted = `+254${phone.slice(1)}`;
    const email = `user_${phone}@bintupay.com`;

    let reference = "";
    try {
      const chargeRes = await paystackPost("/charge", {
        email,
        amount: amount * 100,
        currency: "KES",
        mobile_money: { phone: formatted, provider: "mpesa" },
      });

      if (!chargeRes.status || !chargeRes.data?.reference) {
        await sendMsg(chatId,
          `❌ *Payment Initialisation Failed*\n\n` +
          `📋 *Reason:* ${escMd(chargeRes.message ?? "Gateway rejected the request")}\n\n` +
          `_Type \`/pay\` to try again\\._`
        );
        sessions.set(chatId, { step: "idle" });
        return;
      }

      reference = chargeRes.data.reference as string;
      sessions.set(chatId, { step: "polling", amount, phone, reference });

      await sendMsg(chatId,
        `📲 *STK Push Sent Successfully*\n\n` +
        `A payment request of *KES ${escMd(amount.toLocaleString())}* has been sent to \`${escMd(phone)}\`\\.\n\n` +
        `👉 Open your phone and enter your *M\\-Pesa PIN* to complete the payment\\.\n\n` +
        `🔐 Reference: \`${escMd(reference)}\`\n\n` +
        `⏳ _Monitoring status — you will be notified immediately once it confirms\\._`
      );
    } catch {
      await sendMsg(chatId, `❌ *Network Error*\n\nCould not reach the payment gateway\\. Please try again with \`/pay\`\\.`);
      sessions.set(chatId, { step: "idle" });
      return;
    }

    // Poll Paystack every 3s for up to 50s (16 checks)
    let resolved = false;
    for (let i = 0; i < 16; i++) {
      await sleep(3000);
      try {
        const check = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
        const txStatus = (check.data as Record<string, string>)?.status ?? "";
        const gwMsg    = (check.data as Record<string, string>)?.gateway_response ?? "Unknown";

        if (txStatus === "success") {
          sessions.set(chatId, { step: "idle" });
          await sendMsg(chatId,
            `🎉 *Payment Confirmed\\!*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `💰 *Amount:* KES ${escMd(amount.toLocaleString())}\n` +
            `📱 *Phone:* \`${escMd(phone)}\`\n` +
            `🆔 *Reference:* \`${escMd(reference)}\`\n` +
            `✅ *Status:* Successful\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Your payment has been received and confirmed\\. Thank you for using *BintuPay*\\!\n\n` +
            `_Type \`/receipt ${escMd(reference)}\` to get your receipt, or \`/pay\` to make another payment\\._`
          );
          resolved = true;
          break;
        }

        if (txStatus === "failed") {
          sessions.set(chatId, { step: "idle" });
          await sendMsg(chatId,
            `❌ *Transaction Declined*\n\n` +
            `Your payment of KES ${escMd(amount.toLocaleString())} could not be processed\\.\n\n` +
            `📋 *Reason:* \`${escMd(gwMsg)}\`\n\n` +
            `Please check:\n` +
            `• Your M\\-Pesa balance is sufficient\n` +
            `• Your PIN was entered correctly\n` +
            `• You have not exceeded your daily transaction limit\n\n` +
            `_Type \`/pay\` to retry\\._`
          );
          resolved = true;
          break;
        }

        // Midway nudge at ~24 seconds
        if (i === 7) {
          await sendMsg(chatId,
            `🔄 _Still waiting for your PIN confirmation\\. Please check your phone and enter your M\\-Pesa PIN\\._`
          );
        }
      } catch { /* keep polling */ }
    }

    if (!resolved) {
      sessions.set(chatId, { step: "idle" });
      await sendMsg(chatId,
        `⏰ *Verification Timeout*\n\n` +
        `We could not confirm your transaction within 50 seconds\\.\n\n` +
        `🔍 *Reference:* \`${escMd(reference)}\`\n\n` +
        `Your payment may still be processing\\. Check your M\\-Pesa messages for confirmation\\. ` +
        `If funds were deducted without service delivery, contact support with the reference above\\.\n\n` +
        `_Type \`/pay\` to start a new transaction\\._`
      );
    }
    return;
  }

  // STEP: status check by reference
  if (step === "await_status_ref") {
    const ref = text.trim();
    sessions.set(chatId, { step: "idle" });
    await sendMsg(chatId, `🔍 _Checking status for \`${escMd(ref)}\`\\.\\.\\._`);
    try {
      const check = await paystackGet(`/transaction/verify/${encodeURIComponent(ref)}`);
      const status = (check.data as Record<string, string>)?.status ?? "";
      const gwMsg  = (check.data as Record<string, string>)?.gateway_response ?? "Unknown";
      if (status === "success") {
        await sendMsg(chatId,
          `✅ *Transaction Confirmed*\n\n🆔 *Reference:* \`${escMd(ref)}\`\n📋 *Status:* Successful\n\n_This transaction completed successfully\\._`
        );
      } else if (status === "failed") {
        await sendMsg(chatId,
          `❌ *Transaction Failed*\n\n🆔 *Reference:* \`${escMd(ref)}\`\n📋 *Reason:* \`${escMd(gwMsg)}\`\n\n_Type \`/pay\` to retry\\._`
        );
      } else if (status) {
        await sendMsg(chatId,
          `⏳ *Transaction Pending*\n\n🆔 *Reference:* \`${escMd(ref)}\`\n📋 *Status:* \`${escMd(status)}\`\n\n_Still processing\\. Check again in a moment\\._`
        );
      } else {
        await sendMsg(chatId,
          `⚠️ *Reference Not Found*\n\nNo transaction found for \`${escMd(ref)}\`\\. Please double\\-check and try again\\.`
        );
      }
    } catch {
      await sendMsg(chatId, `❌ *Error*\n\nCould not verify the reference\\. Please try again\\.`);
    }
    return;
  }

  // STEP: receipt by reference
  if (step === "await_receipt_ref") {
    const ref = text.trim();
    sessions.set(chatId, { step: "idle" });
    await buildAndSendReceipt(chatId, ref);
    return;
  }

  // Inline /receipt <reference> shortcut
  if (text.startsWith("/receipt ")) {
    const ref = text.replace("/receipt ", "").trim();
    await buildAndSendReceipt(chatId, ref);
    return;
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  await sendMsg(chatId,
    `ℹ️ *BintuPay Payment Bot*\n\n` +
    `• \`/pay\` — start a new payment\n` +
    `• \`/status\` — check a transaction\n` +
    `• \`/receipt\` — get a payment receipt\n` +
    `• \`/help\` — full instructions`
  );
}

// ─── Receipt builder ─────────────────────────────────────────────────────────
async function buildAndSendReceipt(chatId: number, reference: string) {
  await sendMsg(chatId, `🧾 _Retrieving receipt for \`${escMd(reference)}\`\\.\\.\\._`);
  try {
    const check = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
    const d = check.data as Record<string, unknown> | null;
    if (!check.status || !d) {
      await sendMsg(chatId,
        `⚠️ *Receipt Not Found*\n\nNo transaction found for \`${escMd(reference)}\`\\.\n\n_Please verify the reference and try again\\._`
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
    const email  = customerData?.["email"]       ?? "";
    const mobile = (d["authorization"] as Record<string, string> | null)?.["mobile_money_number"]
                ?? (d["authorization"] as Record<string, string> | null)?.["last4"]
                ?? "";

    const dateStr = paidAt
      ? new Date(paidAt).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" })
      : "—";

    const statusIcon = status === "success" ? "✅" : status === "failed" ? "❌" : "⏳";
    const methodLabel = channel === "mobile_money" ? "M\\-Pesa" : channel === "card" ? "Card" : escMd(channel);

    if (status !== "success") {
      await sendMsg(chatId,
        `❌ *No Receipt Available*\n\n` +
        `🆔 *Reference:* \`${escMd(reference)}\`\n` +
        `📋 *Status:* ${escMd(status)}\n` +
        `📝 *Note:* ${escMd(gwMsg || "Transaction was not successful")}\n\n` +
        `_Receipts are only issued for confirmed payments\\._`
      );
      return;
    }

    await sendMsg(chatId,
      `🧾 *BintuPay Payment Receipt*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${statusIcon} *Status:* Confirmed\n` +
      `📅 *Date:* ${escMd(dateStr)}\n\n` +
      `💰 *Amount Paid:* ${escMd(currency)} ${escMd(amount.toLocaleString("en-KE", { minimumFractionDigits: 2 }))}\n` +
      `💳 *Method:* ${methodLabel}\n` +
      (mobile ? `📱 *Identifier:* \`${escMd(mobile)}\`\n` : "") +
      (email ? `📧 *Email:* ${escMd(email)}\n` : "") +
      `\n🆔 *Transaction Reference*\n\`${escMd(reference)}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Keep this reference for your records\\. Contact support if you need assistance\\._\n\n` +
      `_Powered by *BintuPay* via Paystack_`
    );
  } catch {
    await sendMsg(chatId, `❌ *Error*\n\nCould not retrieve the receipt at this time\\. Please try again\\.`);
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
async function sendMsg(chatId: number, text: string) {
  await fetch(`${TG_BASE()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" }),
  });
}

async function sendForceReply(chatId: number, text: string) {
  await fetch(`${TG_BASE()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      reply_markup: { force_reply: true, selective: true },
    }),
  });
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function escMd(text: string): string {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

export default router;
