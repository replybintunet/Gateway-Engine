import { useState, useEffect, useRef } from "react";

type PaymentMethod = "mpesa" | "card";
type SheetView = "checkout" | "status" | "otp" | "error";

interface CardDetails {
  number: string;
  expiry: string;
  cvv: string;
  name: string;
}

const API = "/api/payment";

function formatCardNumber(value: string) {
  return value.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
}

function formatExpiry(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  if (digits.length >= 3) return digits.slice(0, 2) + "/" + digits.slice(2);
  return digits;
}

function detectCardBrand(number: string): string {
  const n = number.replace(/\s/g, "");
  if (/^4/.test(n)) return "VISA";
  if (/^5[1-5]|^2[2-7]/.test(n)) return "MASTERCARD";
  if (/^3[47]/.test(n)) return "AMEX";
  return "";
}

function VisaIcon() {
  return (
    <svg viewBox="0 0 38 24" width="38" height="24">
      <rect width="38" height="24" rx="4" fill="#1A1F71" />
      <text x="4" y="17" fill="white" fontSize="13" fontWeight="700" fontFamily="Arial">VISA</text>
    </svg>
  );
}
function MastercardIcon() {
  return (
    <svg viewBox="0 0 38 24" width="38" height="24">
      <rect width="38" height="24" rx="4" fill="#252525" />
      <circle cx="15" cy="12" r="7" fill="#EB001B" />
      <circle cx="23" cy="12" r="7" fill="#F79E1B" />
      <path d="M19 7a7 7 0 0 1 0 10A7 7 0 0 1 19 7z" fill="#FF5F00" />
    </svg>
  );
}
function AmexIcon() {
  return (
    <svg viewBox="0 0 38 24" width="38" height="24">
      <rect width="38" height="24" rx="4" fill="#2557D6" />
      <text x="5" y="17" fill="white" fontSize="10" fontWeight="700" fontFamily="Arial">AMEX</text>
    </svg>
  );
}
function CardBrandIcon({ brand }: { brand: string }) {
  if (brand === "VISA") return <VisaIcon />;
  if (brand === "MASTERCARD") return <MastercardIcon />;
  if (brand === "AMEX") return <AmexIcon />;
  return null;
}

function CreditCardPreview({ card }: { card: CardDetails }) {
  const brand = detectCardBrand(card.number);
  const displayNumber = card.number || "•••• •••• •••• ••••";
  const displayName = card.name || "CARDHOLDER NAME";
  const displayExpiry = card.expiry || "MM/YY";
  return (
    <div style={{
      background: "linear-gradient(135deg,#1a1f2e 0%,#2d3550 50%,#1a1f2e 100%)",
      borderRadius: 16, padding: "20px 22px", color: "#fff",
      fontFamily: "'Space Grotesk',monospace", position: "relative",
      overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.3)", marginBottom: 20,
    }}>
      <div style={{ position:"absolute",top:-30,right:-30,width:120,height:120,borderRadius:"50%",background:"rgba(52,168,83,0.15)",pointerEvents:"none" }} />
      <div style={{ position:"absolute",bottom:-20,left:-20,width:80,height:80,borderRadius:"50%",background:"rgba(52,168,83,0.08)",pointerEvents:"none" }} />
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
        <div style={{ width:36,height:28,background:"linear-gradient(135deg,#d4a843,#f0c060)",borderRadius:5,border:"1px solid rgba(255,255,255,0.2)" }} />
        {brand && <CardBrandIcon brand={brand} />}
      </div>
      <div style={{ fontSize:18,letterSpacing:3,marginBottom:18,opacity:card.number?1:0.5 }}>{displayNumber}</div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-end" }}>
        <div>
          <div style={{ fontSize:9,opacity:0.6,textTransform:"uppercase",marginBottom:2 }}>Card Holder</div>
          <div style={{ fontSize:13,fontWeight:600,letterSpacing:1,opacity:card.name?1:0.5,textTransform:"uppercase" }}>{displayName.slice(0,22)}</div>
        </div>
        <div>
          <div style={{ fontSize:9,opacity:0.6,textTransform:"uppercase",marginBottom:2 }}>Expires</div>
          <div style={{ fontSize:13,fontWeight:600,opacity:card.expiry?1:0.5 }}>{displayExpiry}</div>
        </div>
      </div>
    </div>
  );
}

const SHEET: React.CSSProperties = {
  position: "fixed", bottom: 0, left: "50%",
  width: "100%", maxWidth: 450,
  background: "#fff",
  borderTopLeftRadius: 28, borderTopRightRadius: 28,
  padding: "14px 24px 34px",
  boxShadow: "0 -12px 40px rgba(0,0,0,0.3)",
  transition: "transform 0.45s cubic-bezier(0.16,1,0.3,1)",
  zIndex: 10000,
};
const DRAG_BAR = <div style={{ width:38,height:4,background:"#e2e5ec",borderRadius:2,margin:"0 auto 22px" }} />;
const INPUT_WRAP: React.CSSProperties = { background:"#fff",border:"1.5px solid #dcdfe6",borderRadius:12,padding:"10px 16px",marginBottom:16 };
const INPUT_LABEL: React.CSSProperties = { display:"block",fontSize:11,fontWeight:700,color:"#606770",textTransform:"uppercase" };
const INPUT_FIELD: React.CSSProperties = { width:"100%",border:"none",background:"transparent",fontSize:16,fontWeight:600,outline:"none",color:"#1f2226" };

export default function App() {
  const [isOpen, setIsOpen]   = useState(false);
  const [view, setView]       = useState<SheetView>("checkout");
  const [method, setMethod]   = useState<PaymentMethod>("mpesa");

  const [amount, setAmount]   = useState("");
  const [phone, setPhone]     = useState("");
  const [card, setCard]       = useState<CardDetails>({ number:"", expiry:"", cvv:"", name:"" });

  const [countdown, setCountdown] = useState(50);
  const [statusTitle, setStatusTitle] = useState("Processing…");
  const [statusDesc, setStatusDesc]   = useState("");
  const [isSuccess, setIsSuccess]     = useState(false);

  const [otpLabel, setOtpLabel]   = useState("Enter OTP");
  const [otpHint, setOtpHint]     = useState("");
  const [otpCode, setOtpCode]     = useState("");
  const [otpAction, setOtpAction] = useState<"submit_otp"|"submit_pin">("submit_otp");
  const [pendingRef, setPendingRef] = useState("");

  const [errorMsg, setErrorMsg] = useState("Check parameters and try again.");

  const countdownRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const pollingRef   = useRef<ReturnType<typeof setInterval>|null>(null);

  useEffect(() => {
    const t = setTimeout(() => setIsOpen(true), 150);
    return () => clearTimeout(t);
  }, []);

  function clearIntervals() {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (pollingRef.current)   clearInterval(pollingRef.current);
  }

  function closeAll() {
    clearIntervals();
    setIsOpen(false);
    setView("checkout");
    setIsSuccess(false);
    setOtpCode("");
  }

  function goBackToCheckout() {
    clearIntervals();
    setView("checkout");
    setOtpCode("");
  }

  function startCountdown(seconds = 50) {
    let remaining = seconds;
    setCountdown(remaining);
    setIsSuccess(false);
    clearIntervals();
    countdownRef.current = setInterval(() => {
      remaining--;
      setCountdown(remaining);
      if (remaining <= 0) {
        clearIntervals();
        setErrorMsg("Transaction timed out. Please try again.");
        setView("error");
      }
    }, 1000);
  }

  function showSuccess() {
    clearIntervals();
    setIsSuccess(true);
    setStatusTitle("Payment Successful");
    setStatusDesc("Transaction confirmed successfully.");
    setTimeout(() => closeAll(), 3000);
  }

  function showError(msg: string) {
    clearIntervals();
    setErrorMsg(msg || "Transaction cancelled.");
    setView("error");
  }

  function startPolling(reference: string) {
    clearIntervals();
    pollingRef.current = setInterval(async () => {
      try {
        const res    = await fetch(`${API}?action=verify&reference=${encodeURIComponent(reference)}`);
        const result = await res.json() as { status: boolean; data?: { status: string; gateway_response?: string } };
        if (result.status === true && result.data) {
          if (result.data.status === "success") showSuccess();
          else if (result.data.status === "failed") showError(result.data.gateway_response ?? "Payment failed.");
        }
      } catch { /* silent */ }
    }, 2500);
  }

  function handleChargeResponse(result: {
    status: boolean;
    message?: string;
    data?: { reference?: string; status?: string; gateway_response?: string };
  }) {
    if (!result.status) {
      showError(result.message ?? "Charge failed.");
      return;
    }
    const d = result.data!;
    const ref = d.reference ?? "";
    const txStatus = d.status ?? "";

    if (txStatus === "success") { showSuccess(); return; }
    if (txStatus === "failed")  { showError(d.gateway_response ?? "Declined."); return; }

    // OTP / PIN required
    if (txStatus === "send_otp") {
      clearIntervals();
      setPendingRef(ref);
      setOtpAction("submit_otp");
      setOtpLabel("Enter OTP");
      setOtpHint("Paystack sent a one-time password to your registered email or phone. Enter it below.");
      setOtpCode("");
      setView("otp");
      return;
    }
    if (txStatus === "send_pin") {
      clearIntervals();
      setPendingRef(ref);
      setOtpAction("submit_pin");
      setOtpLabel("Enter Card PIN");
      setOtpHint("Enter your 4-digit card PIN to authorise this transaction.");
      setOtpCode("");
      setView("otp");
      return;
    }

    // Pending / processing — poll
    if (ref) {
      startPolling(ref);
    } else {
      showError("No transaction reference returned.");
    }
  }

  async function processMpesa() {
    if (!amount || !phone) {
      setErrorMsg("Amount and phone number cannot be empty.");
      setView("error");
      return;
    }
    setStatusTitle("Awaiting M-Pesa PIN");
    setStatusDesc("Please check your phone for the M-Pesa STK push popup.");
    setView("status");
    startCountdown(50);
    try {
      const res = await fetch(`${API}?action=charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, phone }),
      });
      const result = await res.json() as Parameters<typeof handleChargeResponse>[0];
      handleChargeResponse(result);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Network error.");
    }
  }

  async function processCard() {
    const raw = card.number.replace(/\s/g, "");
    if (!amount || raw.length < 13 || !card.expiry || !card.cvv || !card.name) {
      setErrorMsg("Please fill in all card details and the amount.");
      setView("error");
      return;
    }
    setStatusTitle("Processing Card");
    setStatusDesc("Please wait while we securely process your payment.");
    setView("status");
    startCountdown(50);
    try {
      const res = await fetch(`${API}?action=card`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, card_number: raw, expiry: card.expiry, cvv: card.cvv, name: card.name }),
      });
      const result = await res.json() as Parameters<typeof handleChargeResponse>[0];
      handleChargeResponse(result);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Network error.");
    }
  }

  async function submitOtp() {
    if (!otpCode.trim()) return;
    setView("status");
    setStatusTitle(otpAction === "submit_pin" ? "Verifying PIN…" : "Verifying OTP…");
    setStatusDesc("Please wait while we confirm your details.");
    startCountdown(30);
    try {
      const body = otpAction === "submit_pin"
        ? { pin: otpCode, reference: pendingRef }
        : { otp: otpCode, reference: pendingRef };
      const res = await fetch(`${API}?action=${otpAction}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json() as Parameters<typeof handleChargeResponse>[0];
      handleChargeResponse(result);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Network error.");
    }
  }

  const brand = detectCardBrand(card.number);
  const sheetVisible = (v: SheetView) => view === v && isOpen;

  return (
    <div style={{ width:"100%",height:"100%",position:"relative",overflow:"hidden",background:"#0b0f17" }}>
      {/* Glow orbs */}
      <div style={{ position:"absolute",top:"-10%",right:"-10%",width:600,height:600,borderRadius:"50%",background:"radial-gradient(circle,rgba(52,168,83,0.12) 0%,transparent 70%)",filter:"blur(50px)",pointerEvents:"none" }} />
      <div style={{ position:"absolute",bottom:"-10%",left:"-10%",width:400,height:400,borderRadius:"50%",background:"radial-gradient(circle,rgba(52,168,83,0.06) 0%,transparent 70%)",filter:"blur(60px)",pointerEvents:"none" }} />

      {!isOpen && (
        <button onClick={() => { setIsOpen(true); setView("checkout"); }} style={{ position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",zIndex:2,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",padding:"14px 28px",borderRadius:30,color:"#fff",cursor:"pointer",fontSize:15,fontWeight:500 }}>
          Open Payment Interface
        </button>
      )}

      {/* Backdrop */}
      <div onClick={closeAll} style={{ position:"fixed",inset:0,background:"rgba(11,15,25,0.55)",backdropFilter:"blur(10px)",opacity:isOpen?1:0,visibility:isOpen?"visible":"hidden",transition:"opacity 0.4s",zIndex:9999 }} />

      {/* ── CHECKOUT ─────────────────────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${sheetVisible("checkout")?"0%":"110%"})`, maxHeight:"90vh", overflowY:"auto" }}>
        {DRAG_BAR}
        <h3 style={{ margin:"0 0 4px",fontFamily:"'Space Grotesk',sans-serif",fontSize:26,color:"#1f2226" }}>
          <span style={{ color:"#34a853" }}>BintuPay</span> Gateway
        </h3>
        <p style={{ fontSize:14,color:"#606770",margin:"0 0 20px" }}>Choose your preferred payment method below.</p>

        {/* Tabs */}
        <div style={{ display:"flex",gap:8,marginBottom:20,background:"#f4f6f9",borderRadius:12,padding:4 }}>
          {(["mpesa","card"] as PaymentMethod[]).map((m) => (
            <button key={m} onClick={() => setMethod(m)} style={{ flex:1,padding:"10px 0",border:"none",cursor:"pointer",borderRadius:9,fontSize:14,fontWeight:600,transition:"all 0.2s",background:method===m?"#fff":"transparent",color:method===m?"#1f2226":"#606770",boxShadow:method===m?"0 2px 8px rgba(0,0,0,0.1)":"none" }}>
              {m === "mpesa" ? "M-Pesa" : "Credit / Debit Card"}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div style={INPUT_WRAP}>
          <label style={INPUT_LABEL}>Amount (KES)</label>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 100" style={INPUT_FIELD} />
        </div>

        {/* M-Pesa */}
        {method === "mpesa" && (
          <>
            <div style={INPUT_WRAP}>
              <label style={INPUT_LABEL}>M-Pesa Number</label>
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XXXXXXXX" style={INPUT_FIELD} />
            </div>
            <p style={{ fontSize:12,color:"#909399",margin:"0 0 16px",lineHeight:1.5 }}>
              Number format should start with 07 or 01. An STK push will be sent to your phone.
            </p>
          </>
        )}

        {/* Card */}
        {method === "card" && (
          <>
            <CreditCardPreview card={card} />
            <div style={INPUT_WRAP}>
              <label style={INPUT_LABEL}>Card Number {brand && <span style={{ color:"#34a853",marginLeft:6 }}>{brand}</span>}</label>
              <input type="text" inputMode="numeric" value={card.number} onChange={(e) => setCard({ ...card, number:formatCardNumber(e.target.value) })} placeholder="1234 5678 9012 3456" maxLength={19} style={{ ...INPUT_FIELD, letterSpacing:2 }} />
            </div>
            <div style={{ display:"flex",gap:12,marginBottom:16 }}>
              <div style={{ ...INPUT_WRAP, flex:1, marginBottom:0 }}>
                <label style={INPUT_LABEL}>Expiry</label>
                <input type="text" inputMode="numeric" value={card.expiry} onChange={(e) => setCard({ ...card, expiry:formatExpiry(e.target.value) })} placeholder="MM/YY" maxLength={5} style={INPUT_FIELD} />
              </div>
              <div style={{ ...INPUT_WRAP, flex:1, marginBottom:0 }}>
                <label style={INPUT_LABEL}>CVV / CVC</label>
                <input type="password" inputMode="numeric" value={card.cvv} onChange={(e) => setCard({ ...card, cvv:e.target.value.replace(/\D/g,"").slice(0,4) })} placeholder="•••" maxLength={4} style={INPUT_FIELD} />
              </div>
            </div>
            <div style={{ ...INPUT_WRAP, marginTop:0 }}>
              <label style={INPUT_LABEL}>Cardholder Name</label>
              <input type="text" value={card.name} onChange={(e) => setCard({ ...card, name:e.target.value.toUpperCase() })} placeholder="JOHN DOE" style={INPUT_FIELD} />
            </div>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:16,color:"#909399",fontSize:12 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span>256-bit SSL encryption. Your card data is never stored.</span>
            </div>
          </>
        )}

        <button onClick={method === "mpesa" ? processMpesa : processCard}
          style={{ width:"100%",padding:"16px",background:"#34a853",color:"#fff",border:"none",borderRadius:100,fontSize:15,fontWeight:600,cursor:"pointer",boxShadow:"0 4px 14px rgba(52,168,83,0.3)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background="#2d8f47")}
          onMouseLeave={(e) => (e.currentTarget.style.background="#34a853")}
        >
          {method === "mpesa" ? "Confirm and Pay via M-Pesa" : `Pay KES ${amount || "0"} Securely`}
        </button>

        {method === "card" && (
          <div style={{ display:"flex",justifyContent:"center",gap:8,marginTop:14,opacity:0.7 }}>
            <VisaIcon /><MastercardIcon /><AmexIcon />
          </div>
        )}
      </div>

      {/* ── STATUS ───────────────────────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${sheetVisible("status")?"0%":"110%"})` }}>
        {DRAG_BAR}
        <div style={{ display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",padding:"10px 0" }}>
          {!isSuccess ? (
            <div style={{ width:100,height:100,borderRadius:"50%",background:"#f4f6f9",border:"4px solid transparent",borderTopColor:"#34a853",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:20,animation:"spin 1.2s linear infinite" }}>
              <span style={{ fontFamily:"'Space Grotesk',sans-serif",fontSize:32,fontWeight:700,color:"#1f2226" }}>{countdown}</span>
            </div>
          ) : (
            <div style={{ width:80,height:80,background:"#e6f4ea",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",color:"#34a853",marginBottom:20 }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
          )}
          <h3 style={{ margin:"0 0 8px",fontFamily:"'Space Grotesk',sans-serif",fontSize:24,color:"#1f2226" }}>{statusTitle}</h3>
          <p style={{ fontSize:14,color:"#606770",margin:0 }}>{statusDesc}</p>
        </div>
      </div>

      {/* ── OTP / PIN ────────────────────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${sheetVisible("otp")?"0%":"110%"})`, zIndex:10001 }}>
        {DRAG_BAR}
        {/* Icon */}
        <div style={{ display:"flex",justifyContent:"center",marginBottom:18 }}>
          <div style={{ width:56,height:56,background:"#e8f5e9",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2.2">
              <rect x="5" y="11" width="14" height="10" rx="2"/>
              <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
            </svg>
          </div>
        </div>
        <h3 style={{ margin:"0 0 6px",fontFamily:"'Space Grotesk',sans-serif",fontSize:22,color:"#1f2226",textAlign:"center" }}>
          {otpLabel}
        </h3>
        <p style={{ fontSize:14,color:"#606770",margin:"0 0 22px",textAlign:"center",lineHeight:1.5 }}>{otpHint}</p>

        {/* OTP digit input */}
        <div style={{ ...INPUT_WRAP, display:"flex",alignItems:"center",gap:10,marginBottom:20 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <input
            type={otpAction === "submit_pin" ? "password" : "text"}
            inputMode="numeric"
            value={otpCode}
            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g,"").slice(0, otpAction==="submit_pin"?4:6))}
            placeholder={otpAction === "submit_pin" ? "••••" : "••••••"}
            maxLength={otpAction === "submit_pin" ? 4 : 6}
            autoFocus
            style={{ ...INPUT_FIELD, flex:1, fontSize:22, letterSpacing:6, textAlign:"center" }}
          />
        </div>

        <button
          onClick={submitOtp}
          disabled={!otpCode.trim()}
          style={{ width:"100%",padding:"16px",background:otpCode.trim()?"#34a853":"#c8e6c9",color:"#fff",border:"none",borderRadius:100,fontSize:15,fontWeight:600,cursor:otpCode.trim()?"pointer":"default",transition:"background 0.2s",marginBottom:12 }}
        >
          Confirm {otpAction === "submit_pin" ? "PIN" : "OTP"}
        </button>
        <button
          onClick={goBackToCheckout}
          style={{ width:"100%",padding:"13px",background:"transparent",color:"#606770",border:"1.5px solid #dcdfe6",borderRadius:100,fontSize:14,fontWeight:500,cursor:"pointer" }}
        >
          Cancel Payment
        </button>
      </div>

      {/* ── ERROR ────────────────────────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${sheetVisible("error")?"0%":"110%"})`, background:"#fffdfd", borderTop:"4px solid #d93025", zIndex:10002 }}>
        {DRAG_BAR}
        <div style={{ width:48,height:48,background:"#fce8e6",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",color:"#d93025",marginBottom:16 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <h3 style={{ margin:"0 0 8px",fontFamily:"'Space Grotesk',sans-serif",fontSize:22,color:"#1f2226" }}>Transaction Failed</h3>
        <p style={{ fontSize:14,color:"#606770",margin:"0 0 20px" }}>{errorMsg}</p>
        <button onClick={goBackToCheckout} style={{ width:"100%",padding:"14px",background:"#1f2226",color:"#fff",border:"none",borderRadius:100,fontSize:15,fontWeight:600,cursor:"pointer" }}>
          Modify Details
        </button>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Work+Sans:wght@400;500;600&display=swap');
        @keyframes spin { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
        * { box-sizing:border-box; }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
      `}</style>
    </div>
  );
}
