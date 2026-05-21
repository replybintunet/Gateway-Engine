import { Router, type IRouter } from "express";

const router: IRouter = Router();

const PAYSTACK_BASE = "https://api.paystack.co";

function getSecretKey(): string {
  const key = process.env["PAYSTACK_SECRET_KEY"];
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is not configured.");
  return key;
}

async function paystackPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

async function paystackGet(path: string) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    headers: { Authorization: `Bearer ${getSecretKey()}` },
  });
  return res.json() as Promise<Record<string, unknown>>;
}

function formatKenyanNumber(phone: string): string | false {
  const digits = phone.replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `+254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return `+${digits}`;
  return false;
}

// Paystack test cards — useful for verifying the card flow
const TEST_CARDS: Record<string, { number: string; cvv: string; expiry: string; desc: string }> = {
  visa_success:   { number: "4084084084084081", cvv: "408", expiry: "12/30", desc: "Visa — succeeds immediately" },
  visa_otp:       { number: "4084080000000409", cvv: "408", expiry: "12/30", desc: "Visa — triggers OTP" },
  visa_pin:       { number: "4084080000000805", cvv: "408", expiry: "12/30", desc: "Visa — triggers PIN" },
  mastercard:     { number: "5399834695874723", cvv: "123", expiry: "12/30", desc: "Mastercard — succeeds" },
  verve:          { number: "5060665060665060", cvv: "123", expiry: "12/30", desc: "Verve — succeeds" },
};

function isTestCard(number: string): string | false {
  const clean = number.replace(/\s/g, "");
  for (const [key, card] of Object.entries(TEST_CARDS)) {
    if (clean === card.number) return key;
  }
  return false;
}

// ─── POST /api/payment ───────────────────────────────────────────────────────────────
router.post("/payment", async (req, res) => {
  const action = (req.query["action"] as string) ?? "";

  // ── M-Pesa STK Push ─────────────────────────────────────────────────────────
  if (action === "charge") {
    const { phone, amount } = req.body as { phone?: string; amount?: string };
    if (!phone || !amount) {
      res.json({ status: false, message: "Phone number and amount required." });
      return;
    }
    const formatted = formatKenyanNumber(phone);
    if (!formatted) {
      res.json({ status: false, message: "Invalid format. Use 07XXXXXXXX or 01XXXXXXXX." });
      return;
    }
    const cleanDigits = formatted.replace("+", "");
    const email = `user_${cleanDigits}@bintupay.com`;
    try {
      const data = await paystackPost("/charge", {
        email,
        amount: Math.round(parseFloat(amount) * 100),
        currency: "KES",
        mobile_money: { phone: formatted, provider: "mpesa" },
      });
      const d = data as Record<string, unknown>;
      if (d["status"] === true) {
        const inner = d["data"] as Record<string, unknown>;
        res.json({ status: true, data: { reference: inner["reference"], status: inner["status"], gateway_response: inner["gateway_response"] ?? "" } });
      } else {
        res.json(data);
      }
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Gateway error." });
    }
    return;
  }

  // ── Card Charge ──────────────────────────────────────────────────────────────────────
  if (action === "card") {
    const { amount, card_number, expiry, cvv, name } = req.body as {
      amount?: string;
      card_number?: string;
      expiry?: string;
      cvv?: string;
      name?: string;
    };
    if (!amount || !card_number || !expiry || !cvv || !name) {
      res.json({ status: false, message: "All card fields and amount are required." });
      return;
    }
    const parts = expiry.split("/");
    if (parts.length !== 2) {
      res.json({ status: false, message: "Invalid expiry format. Use MM/YY." });
      return;
    }
    const expiryMonth = parts[0]!.trim().padStart(2, "0");
    const rawYear = parts[1]!.trim();
    const expiryYear = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    const last4 = card_number.slice(-4);
    const email = `card_${last4}_${Date.now()}@bintupay.com`;

    // Detect if using a test card — helpful for debugging
    const testCardKey = isTestCard(card_number);

    try {
      const chargeBody: Record<string, unknown> = {
        email,
        amount: Math.round(parseFloat(amount) * 100),
        currency: "KES",
        card: {
          number: card_number,
          cvv,
          expiry_month: expiryMonth,
          expiry_year: expiryYear,
        },
        metadata: {
          cardholder_name: name,
          custom_fields: [
            { display_name: "Cardholder", variable_name: "cardholder_name", value: name },
            { display_name: "Last 4", variable_name: "card_last4", value: last4 },
            ...(testCardKey ? [{ display_name: "Test Card", variable_name: "test_card", value: testCardKey }] : []),
          ],
        },
      };

      const data = await paystackPost("/charge", chargeBody);
      const d = data as Record<string, unknown>;

      if (d["status"] !== true) {
        // Paystack returned status: false — charge rejected at validation level
        res.json({ status: false, message: (d["message"] as string) ?? "Card charge rejected by gateway." });
        return;
      }

      const inner = d["data"] as Record<string, unknown>;
      const txStatus = (inner["status"] as string) ?? "";
      const reference = inner["reference"] as string;

      // Map all known Paystack charge statuses
      const knownStatuses = ["success", "failed", "send_otp", "send_pin", "send_address", "send_phone", "pay_offline", "open_url", "pending", "processing"];
      if (!knownStatuses.includes(txStatus)) {
        // Unknown status — return raw for debugging
        res.json({
          status: true,
          data: {
            reference,
            status: txStatus,
            gateway_response: (inner["gateway_response"] as string) ?? "Unknown status",
            display_text: (inner["display_text"] as string) ?? "",
            raw_response: inner,
          },
        });
        return;
      }

      if (txStatus === "failed") {
        res.json({
          status: false,
          message: (inner["gateway_response"] as string)
            ?? (inner["message"] as string)
            ?? "Card charge declined.",
        });
        return;
      }

      if (txStatus === "success") {
        res.json({
          status: true,
          data: {
            reference,
            status: "success",
            gateway_response: (inner["gateway_response"] as string) ?? "Approved",
          },
        });
        return;
      }

      // Intermediate states: send_otp, send_pin, send_address, send_phone, pay_offline, pending, processing
      const displayText = (inner["display_text"] as string) ?? "";

      if (txStatus === "pay_offline" || txStatus === "open_url") {
        // 3DS redirect required — bank authentication page
        const redirectUrl = (inner["redirecturl"] as string) ?? (inner["url"] as string) ?? "";
        res.json({
          status: true,
          data: {
            reference,
            status: "pay_offline",
            gateway_response: displayText || "Redirecting to bank for 3D Secure authentication",
            redirect_url: redirectUrl,
            display_text: displayText,
          },
        });
        return;
      }

      // OTP, PIN, address, phone, pending, processing — all need client-side action or polling
      res.json({
        status: true,
        data: {
          reference,
          status: txStatus,
          gateway_response: (inner["gateway_response"] as string) ?? "Processing",
          display_text: displayText,
        },
      });
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Gateway error during card charge." });
    }
    return;
  }

  // ── Submit OTP ───────────────────────────────────────────────────────────────────────
  if (action === "submit_otp") {
    const { otp, reference } = req.body as { otp?: string; reference?: string };
    if (!otp || !reference) {
      res.json({ status: false, message: "OTP and reference are required." });
      return;
    }
    try {
      const data = await paystackPost("/charge/submit_otp", { otp, reference });
      const d = data as Record<string, unknown>;
      if (d["status"] === true) {
        const inner = d["data"] as Record<string, unknown>;
        res.json({
          status: true,
          data: {
            reference,
            status: inner["status"],
            gateway_response: inner["gateway_response"] ?? "",
            display_text: inner["display_text"] ?? "",
          },
        });
      } else {
        res.json({ status: false, message: (d["message"] as string) ?? "OTP rejected." });
      }
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Gateway error." });
    }
    return;
  }

  // ── Submit PIN ───────────────────────────────────────────────────────────────────────
  if (action === "submit_pin") {
    const { pin, reference } = req.body as { pin?: string; reference?: string };
    if (!pin || !reference) {
      res.json({ status: false, message: "PIN and reference are required." });
      return;
    }
    try {
      const data = await paystackPost("/charge/submit_pin", { pin, reference });
      const d = data as Record<string, unknown>;
      if (d["status"] === true) {
        const inner = d["data"] as Record<string, unknown>;
        res.json({
          status: true,
          data: {
            reference,
            status: inner["status"],
            gateway_response: inner["gateway_response"] ?? "",
            display_text: inner["display_text"] ?? "",
          },
        });
      } else {
        res.json({ status: false, message: (d["message"] as string) ?? "PIN rejected." });
      }
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Gateway error." });
    }
    return;
  }

  res.json({ status: false, message: "Invalid action context." });
});

// ─── GET /api/payment ──────────────────────────────────────────────────────────────────
router.get("/payment", async (req, res) => {
  const action = (req.query["action"] as string) ?? "";

  // Verify transaction status
  if (action === "verify") {
    const reference = (req.query["reference"] as string) ?? "";
    if (!reference) {
      res.json({ status: false, message: "Reference required." });
      return;
    }
    try {
      const data = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
      const d = data as Record<string, unknown>;
      if (d["status"] === true) {
        const inner = d["data"] as Record<string, unknown>;
        res.json({
          status: true,
          data: {
            status: inner["status"],
            gateway_response: inner["gateway_response"] ?? "Updating",
            display_text: inner["display_text"] ?? "",
            channel: inner["channel"] ?? "",
            amount: inner["amount"],
            currency: inner["currency"] ?? "",
          },
        });
      } else {
        res.json(data);
      }
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Verify error." });
    }
    return;
  }

  // 3DS redirect callback — called after bank authentication completes
  if (action === "callback") {
    const reference = (req.query["reference"] as string) ?? "";
    const trxref = (req.query["trxref"] as string) ?? "";
    const resolvedRef = reference || trxref;

    if (!resolvedRef) {
      res.json({ status: false, message: "No transaction reference in callback." });
      return;
    }

    try {
      const data = await paystackGet(`/transaction/verify/${encodeURIComponent(resolvedRef)}`);
      const d = data as Record<string, unknown>;
      if (d["status"] === true) {
        const inner = d["data"] as Record<string, unknown>;
        const txStatus = (inner["status"] as string) ?? "";
        res.json({
          status: true,
          data: {
            reference: resolvedRef,
            status: txStatus,
            gateway_response: (inner["gateway_response"] as string) ?? "",
            channel: inner["channel"] ?? "",
          },
        });
      } else {
        res.json({ status: false, message: "Could not verify transaction after redirect." });
      }
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Callback verification error." });
    }
    return;
  }

  res.json({ status: false, message: "Invalid action context." });
});

// Health check
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "bintupay-api", timestamp: new Date().toISOString() });
});

export default router;
