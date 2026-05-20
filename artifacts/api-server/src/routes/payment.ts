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

// ─── M-Pesa STK Push ────────────────────────────────────────────────────────
router.post("/payment", async (req, res) => {
  const action = (req.query["action"] as string) ?? "";

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
        res.json({ status: true, data: { reference: inner["reference"], status: inner["status"] } });
      } else {
        res.json(data);
      }
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Gateway error." });
    }
    return;
  }

  // ─── Card Charge ──────────────────────────────────────────────────────────
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
    try {
      const data = await paystackPost("/charge", {
        email,
        amount: Math.round(parseFloat(amount) * 100),
        currency: "KES",
        card: { number: card_number, cvv, expiry_month: expiryMonth, expiry_year: expiryYear },
      });
      const d = data as Record<string, unknown>;
      if (d["status"] === true) {
        const inner = d["data"] as Record<string, unknown>;
        const txStatus = inner["status"] as string;
        if (txStatus === "failed") {
          res.json({ status: false, message: inner["gateway_response"] ?? "Card charge declined." });
        } else {
          res.json({
            status: true,
            data: {
              reference: inner["reference"],
              status: txStatus,
              gateway_response: inner["gateway_response"] ?? "Processing",
            },
          });
        }
      } else {
        res.json({ status: false, message: (d["message"] as string) ?? "Card charge failed." });
      }
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Gateway error." });
    }
    return;
  }

  // ─── Submit OTP ───────────────────────────────────────────────────────────
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
        res.json({ status: true, data: { reference, status: inner["status"], gateway_response: inner["gateway_response"] ?? "" } });
      } else {
        res.json({ status: false, message: (d["message"] as string) ?? "OTP rejected." });
      }
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Gateway error." });
    }
    return;
  }

  // ─── Submit PIN ───────────────────────────────────────────────────────────
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
        const txStatus = inner["status"] as string;
        res.json({ status: true, data: { reference, status: txStatus, gateway_response: inner["gateway_response"] ?? "" } });
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

// ─── Verify (GET) ─────────────────────────────────────────────────────────
router.get("/payment", async (req, res) => {
  const action = (req.query["action"] as string) ?? "";
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
        res.json({ status: true, data: { status: inner["status"], gateway_response: inner["gateway_response"] ?? "Updating" } });
      } else {
        res.json(data);
      }
    } catch (err: unknown) {
      res.json({ status: false, message: err instanceof Error ? err.message : "Verify error." });
    }
    return;
  }
  res.json({ status: false, message: "Invalid action context." });
});

export default router;
