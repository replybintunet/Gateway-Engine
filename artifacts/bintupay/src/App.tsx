import { useState, useEffect, useRef } from "react";

type PaymentMethod = "mpesa" | "card";
type SheetView = "checkout" | "status" | "otp" | "receipt" | "error" | "threeds";

interface CardDetails { number: string; expiry: string; cvv: string; name: string; }
interface ReceiptData { reference: string; amount: string; masked: string; method: PaymentMethod; }

const API = "/api/payment";

function formatCardNumber(v: string) { return v.replace(/\D/g,"").slice(0,16).replace(/(.{4})/g,"$1 ").trim(); }
function formatExpiry(v: string) { const d=v.replace(/\D/g,"").slice(0,4); return d.length>=3?d.slice(0,2)+"/"+d.slice(2):d; }
function detectCardBrand(n: string) {
  const s=n.replace(/\s/g,"");
  if(/^4/.test(s)) return "VISA";
  if(/^5[1-5]|^2[2-7]/.test(s)) return "MASTERCARD";
  if(/^3[47]/.test(s)) return "AMEX";
  return "";
}
function maskCard(n: string) { const d=n.replace(/\s/g,""); return "•••• •••• •••• "+d.slice(-4); }
function maskPhone(p: string) { const d=p.replace(/\D/g,""); return d.slice(0,4)+"•••••"+d.slice(-2); }

function VisaIcon() { return <svg viewBox="0 0 38 24" width="38" height="24"><rect width="38" height="24" rx="4" fill="#1A1F71"/><text x="4" y="17" fill="white" fontSize="13" fontWeight="700" fontFamily="Arial">VISA</text></svg>; }
function MastercardIcon() { return <svg viewBox="0 0 38 24" width="38" height="24"><rect width="38" height="24" rx="4" fill="#252525"/><circle cx="15" cy="12" r="7" fill="#EB001B"/><circle cx="23" cy="12" r="7" fill="#F79E1B"/><path d="M19 7a7 7 0 0 1 0 10A7 7 0 0 1 19 7z" fill="#FF5F00"/></svg>; }
function AmexIcon() { return <svg viewBox="0 0 38 24" width="38" height="24"><rect width="38" height="24" rx="4" fill="#2557D6"/><text x="5" y="17" fill="white" fontSize="10" fontWeight="700" fontFamily="Arial">AMEX</text></svg>; }
function CardBrandIcon({ brand }: { brand: string }) {
  if (brand==="VISA") return <VisaIcon/>; if (brand==="MASTERCARD") return <MastercardIcon/>; if (brand==="AMEX") return <AmexIcon/>; return null;
}

function CreditCardPreview({ card }: { card: CardDetails }) {
  const brand = detectCardBrand(card.number);
  return (
    <div style={{ background:"linear-gradient(135deg,#1a1f2e 0%,#2d3550 50%,#1a1f2e 100%)",borderRadius:16,padding:"20px 22px",color:"#fff",fontFamily:"'Space Grotesk',monospace",position:"relative",overflow:"hidden",boxShadow:"0 8px 32px rgba(0,0,0,0.3)",marginBottom:20 }}>
      <div style={{ position:"absolute",top:-30,right:-30,width:120,height:120,borderRadius:"50%",background:"rgba(52,168,83,0.15)",pointerEvents:"none" }}/>
      <div style={{ position:"absolute",bottom:-20,left:-20,width:80,height:80,borderRadius:"50%",background:"rgba(52,168,83,0.08)",pointerEvents:"none" }}/>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
        <div style={{ width:36,height:28,background:"linear-gradient(135deg,#d4a843,#f0c060)",borderRadius:5,border:"1px solid rgba(255,255,255,0.2)" }}/>
        {brand && <CardBrandIcon brand={brand}/>}
      </div>
      <div style={{ fontSize:18,letterSpacing:3,marginBottom:18,opacity:card.number?1:0.5 }}>{card.number||"•••• •••• •••• ••••"}</div>
      <div style={{ display:"flex",justifyContent:"space-between" }}>
        <div><div style={{ fontSize:9,opacity:0.6,textTransform:"uppercase",marginBottom:2 }}>Card Holder</div><div style={{ fontSize:13,fontWeight:600,letterSpacing:1,opacity:card.name?1:0.5,textTransform:"uppercase" }}>{(card.name||"CARDHOLDER NAME").slice(0,22)}</div></div>
        <div><div style={{ fontSize:9,opacity:0.6,textTransform:"uppercase",marginBottom:2 }}>Expires</div><div style={{ fontSize:13,fontWeight:600,opacity:card.expiry?1:0.5 }}>{card.expiry||"MM/YY"}</div></div>
      </div>
    </div>
  );
}

const SHEET: React.CSSProperties = { position:"fixed",bottom:0,left:"50%",width:"100%",maxWidth:450,background:"#fff",borderTopLeftRadius:28,borderTopRightRadius:28,padding:"14px 24px 34px",boxShadow:"0 -12px 40px rgba(0,0,0,0.3)",transition:"transform 0.45s cubic-bezier(0.16,1,0.3,1)",zIndex:10000 };
const DRAG = <div style={{ width:38,height:4,background:"#e2e5ec",borderRadius:2,margin:"0 auto 22px" }}/>;
const IW: React.CSSProperties = { background:"#fff",border:"1.5px solid #dcdfe6",borderRadius:12,padding:"10px 16px",marginBottom:16 };
const IL: React.CSSProperties = { display:"block",fontSize:11,fontWeight:700,color:"#606770",textTransform:"uppercase" };
const IF: React.CSSProperties = { width:"100%",border:"none",background:"transparent",fontSize:16,fontWeight:600,outline:"none",color:"#1f2226" };
const GREEN_BTN: React.CSSProperties = { width:"100%",padding:"16px",background:"#34a853",color:"#fff",border:"none",borderRadius:100,fontSize:15,fontWeight:600,cursor:"pointer",boxShadow:"0 4px 14px rgba(52,168,83,0.3)" };

export default function App() {
  const [isOpen,setIsOpen]   = useState(false);
  const [view,setView]       = useState<SheetView>("checkout");
  const [method,setMethod]   = useState<PaymentMethod>("mpesa");
  const [amount,setAmount]   = useState("");
  const [phone,setPhone]     = useState("");
  const [card,setCard]       = useState<CardDetails>({ number:"",expiry:"",cvv:"",name:"" });
  const [countdown,setCountdown] = useState(50);
  const [statusTitle,setStatusTitle] = useState("Processing…");
  const [statusDesc,setStatusDesc]   = useState("");
  const [isSuccess,setIsSuccess]     = useState(false);
  const [otpLabel,setOtpLabel]       = useState("Enter OTP");
  const [otpHint,setOtpHint]         = useState("");
  const [otpCode,setOtpCode]         = useState("");
  const [otpAction,setOtpAction]     = useState<"submit_otp"|"submit_pin"|"submit_address"|"submit_phone"|"submit_birthday">("submit_otp");
  const [otpInputType,setOtpInputType] = useState<"text"|"password"|"tel">("text");
  const [otpMaxLen,setOtpMaxLen]     = useState(6);
  const [otpPlaceholder,setOtpPlaceholder] = useState("••••••");
  const [otpNumericOnly,setOtpNumericOnly] = useState(true);
  const [otpBodyKey,setOtpBodyKey]   = useState("otp");
  const [pendingRef,setPendingRef] = useState("");
  const [receipt,setReceipt]       = useState<ReceiptData|null>(null);
  const [copied,setCopied]         = useState(false);
  const [errorMsg,setErrorMsg]     = useState("Check parameters and try again.");
  const [redirectUrl,setRedirectUrl] = useState("");
  const [iframeLoading,setIframeLoading] = useState(true);

  const countdownRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const pollingRef   = useRef<ReturnType<typeof setInterval>|null>(null);

  useEffect(() => { const t=setTimeout(()=>setIsOpen(true),150); return ()=>clearTimeout(t); },[]);

  function stopAll() {
    if(countdownRef.current) clearInterval(countdownRef.current);
    if(pollingRef.current)   clearInterval(pollingRef.current);
  }
  function stopPolling() { if(pollingRef.current) clearInterval(pollingRef.current); }

  function closeAll() { stopAll(); setIsOpen(false); setView("checkout"); setIsSuccess(false); setCountdown(50); setOtpCode(""); setReceipt(null); setCopied(false); setRedirectUrl(""); setIframeLoading(true); }
  function goBackToCheckout() { stopAll(); setView("checkout"); setIsSuccess(false); setCountdown(50); setOtpCode(""); setRedirectUrl(""); setIframeLoading(true); }

  // Starts a 50-second countdown. Calls onTimeout if it reaches 0.
  function startCountdown(onTimeout: ()=>void) {
    if(countdownRef.current) clearInterval(countdownRef.current);
    let remaining=50;
    setCountdown(remaining);
    setIsSuccess(false);
    countdownRef.current = setInterval(()=>{
      remaining--;
      setCountdown(remaining);
      if(remaining<=0){
        clearInterval(countdownRef.current!);
        countdownRef.current=null;
        onTimeout();
      }
    },1000);
  }

  function showReceipt(ref: string) {
    stopAll();
    setIsSuccess(true);
    setReceipt({
      reference: ref,
      amount,
      masked: method==="card" ? maskCard(card.number) : maskPhone(phone),
      method,
    });
    setView("receipt");
  }

  function showError(msg: string) { stopAll(); setErrorMsg(msg||"Transaction cancelled."); setView("error"); }

  function startPolling(reference: string) {
    // Don't stop the countdown — let it keep running as the overall deadline.
    // Only reset the polling interval.
    stopPolling();
    pollingRef.current = setInterval(async ()=>{
      try {
        const res    = await fetch(`${API}?action=verify&reference=${encodeURIComponent(reference)}`);
        const result = await res.json() as { status:boolean; data?:{ status:string; gateway_response?:string } };
        if(result.status===true && result.data){
          if(result.data.status==="success") { stopPolling(); showReceipt(reference); }
          else if(result.data.status==="failed") { stopPolling(); showError(result.data.gateway_response??"Payment failed."); }
        }
      } catch { /* silent */ }
    },2500);
  }

  function openOtpSheet(ref: string, action: typeof otpAction, label: string, hint: string, opts: { inputType:"text"|"password"|"tel"; maxLen:number; placeholder:string; numericOnly:boolean; bodyKey:string }) {
    stopPolling();
    setPendingRef(ref);
    setOtpAction(action);
    setOtpLabel(label);
    setOtpHint(hint);
    setOtpInputType(opts.inputType);
    setOtpMaxLen(opts.maxLen);
    setOtpPlaceholder(opts.placeholder);
    setOtpNumericOnly(opts.numericOnly);
    setOtpBodyKey(opts.bodyKey);
    setOtpCode("");
    setView("otp");
  }

  function handleChargeResponse(result:{status:boolean;message?:string;data?:{reference?:string;status?:string;gateway_response?:string;display_text?:string;redirect_url?:string}}, ref_fallback=""): void {
    if(!result.status){ showError(result.message??"Charge failed."); return; }
    const d=result.data!;
    const ref=d.reference??ref_fallback;
    const txStatus=d.status??"";
    const hint=d.display_text??"";

    if(txStatus==="success"){
      stopPolling(); showReceipt(ref); return;
    }
    if(txStatus==="failed"){
      stopPolling(); showError(d.gateway_response??"Card declined."); return;
    }
    if(txStatus==="send_otp"){
      openOtpSheet(ref,"submit_otp","Enter OTP",hint||"Enter the one-time password sent to your registered phone or email.",{inputType:"text",maxLen:6,placeholder:"••••••",numericOnly:true,bodyKey:"otp"}); return;
    }
    if(txStatus==="send_pin"){
      openOtpSheet(ref,"submit_pin","Enter Card PIN",hint||"Enter your 4-digit card PIN to authorise this transaction.",{inputType:"password",maxLen:4,placeholder:"••••",numericOnly:true,bodyKey:"pin"}); return;
    }
    if(txStatus==="send_phone"){
      openOtpSheet(ref,"submit_phone","Enter Phone Number",hint||"Your bank requires your phone number to complete this transaction.",{inputType:"tel",maxLen:15,placeholder:"07XXXXXXXX",numericOnly:false,bodyKey:"phone"}); return;
    }
    if(txStatus==="send_address"){
      openOtpSheet(ref,"submit_address","Billing Address",hint||"Your bank requires your billing address to complete verification.",{inputType:"text",maxLen:200,placeholder:"e.g. 123 Main St, Nairobi",numericOnly:false,bodyKey:"address"}); return;
    }
    if(txStatus==="send_birthday"){
      openOtpSheet(ref,"submit_birthday","Date of Birth",hint||"Your bank requires your date of birth to verify your identity.",{inputType:"text",maxLen:10,placeholder:"YYYY-MM-DD",numericOnly:false,bodyKey:"birthday"}); return;
    }
    if(txStatus==="pay_offline"){
      stopPolling();
      const url=d.redirect_url??"";
      if(url){
        setRedirectUrl(url);
        setIframeLoading(true);
        setView("threeds");
        startPolling(ref); return;
      }
    }
    // pending / processing / unknown → poll
    if(ref){
      setStatusTitle("Processing Payment");
      setStatusDesc("Your payment is being processed. Please wait…");
      setView("status");
      startPolling(ref);
    } else { showError("No transaction reference returned."); }
  }

  async function processMpesa() {
    if(!amount||!phone){ setErrorMsg("Amount and phone number cannot be empty."); setView("error"); return; }
    setStatusTitle("Awaiting M-Pesa PIN");
    setStatusDesc("Please check your phone for the M-Pesa STK push popup.");
    setView("status");
    startCountdown(()=>{ showError("Transaction timed out. Please try again."); });
    try {
      const res=await fetch(`${API}?action=charge`,{ method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount,phone}) });
      const result=await res.json() as Parameters<typeof handleChargeResponse>[0];
      handleChargeResponse(result);
    } catch(err:unknown){ showError(err instanceof Error?err.message:"Network error."); }
  }

  async function processCard() {
    const raw=card.number.replace(/\s/g,"");
    if(!amount||raw.length<13||!card.expiry||!card.cvv||!card.name){ setErrorMsg("Please fill in all card details and the amount."); setView("error"); return; }
    setStatusTitle("Processing Card");
    setStatusDesc("Please wait while we securely process your payment.");
    setView("status");
    startCountdown(()=>{ showError("Transaction timed out. Please try again."); });
    try {
      const res=await fetch(`${API}?action=card`,{ method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount,card_number:raw,expiry:card.expiry,cvv:card.cvv,name:card.name}) });
      const result=await res.json() as Parameters<typeof handleChargeResponse>[0];
      handleChargeResponse(result);
    } catch(err:unknown){ showError(err instanceof Error?err.message:"Network error."); }
  }

  async function submitOtp() {
    if(!otpCode.trim()) return;
    const actionLabels: Record<string, string> = {
      submit_pin:"Verifying PIN…", submit_otp:"Verifying OTP…",
      submit_phone:"Submitting Phone…", submit_address:"Submitting Address…", submit_birthday:"Verifying Identity…",
    };
    setView("status");
    setStatusTitle(actionLabels[otpAction]??"Verifying…");
    setStatusDesc("Please wait while your details are confirmed with the bank.");
    startCountdown(()=>{ showError("Verification timed out. Please try again."); });
    try {
      const body = { [otpBodyKey]: otpCode, reference: pendingRef };
      const res=await fetch(`${API}?action=${otpAction}`,{ method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body) });
      const result=await res.json() as Parameters<typeof handleChargeResponse>[0];
      handleChargeResponse(result, pendingRef);
    } catch(err:unknown){ showError(err instanceof Error?err.message:"Network error."); }
  }

  async function copyRef() {
    if(!receipt) return;
    try { await navigator.clipboard.writeText(receipt.reference); setCopied(true); setTimeout(()=>setCopied(false),2500); }
    catch { /* fallback */ }
  }

  const brand = detectCardBrand(card.number);
  const vis = (v:SheetView) => view===v&&isOpen;

  return (
    <div style={{ width:"100%",height:"100%",position:"relative",overflow:"hidden",background:"#0b0f17" }}>
      <div style={{ position:"absolute",top:"-10%",right:"-10%",width:600,height:600,borderRadius:"50%",background:"radial-gradient(circle,rgba(52,168,83,0.12) 0%,transparent 70%)",filter:"blur(50px)",pointerEvents:"none" }}/>
      <div style={{ position:"absolute",bottom:"-10%",left:"-10%",width:400,height:400,borderRadius:"50%",background:"radial-gradient(circle,rgba(52,168,83,0.06) 0%,transparent 70%)",filter:"blur(60px)",pointerEvents:"none" }}/>

      {!isOpen && (
        <button onClick={()=>{setIsOpen(true);setView("checkout");}} style={{ position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",zIndex:2,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.15)",padding:"14px 28px",borderRadius:30,color:"#fff",cursor:"pointer",fontSize:15,fontWeight:500 }}>
          Open Payment Interface
        </button>
      )}

      {/* Backdrop */}
      <div onClick={closeAll} style={{ position:"fixed",inset:0,background:"rgba(11,15,25,0.55)",backdropFilter:"blur(10px)",opacity:isOpen?1:0,visibility:isOpen?"visible":"hidden",transition:"opacity 0.4s",zIndex:9999 }}/>

      {/* ── CHECKOUT ─────────────────────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${vis("checkout")?"0%":"110%"})`, maxHeight:"90vh", overflowY:"auto" }}>
        {DRAG}
        <h3 style={{ margin:"0 0 4px",fontFamily:"'Space Grotesk',sans-serif",fontSize:26,color:"#1f2226" }}>
          <span style={{ color:"#34a853" }}>BintuPay</span> Gateway
        </h3>
        <p style={{ fontSize:14,color:"#606770",margin:"0 0 20px" }}>Choose your preferred payment method below.</p>
        <div style={{ display:"flex",gap:8,marginBottom:20,background:"#f4f6f9",borderRadius:12,padding:4 }}>
          {(["mpesa","card"] as PaymentMethod[]).map(m=>(
            <button key={m} onClick={()=>setMethod(m)} style={{ flex:1,padding:"10px 0",border:"none",cursor:"pointer",borderRadius:9,fontSize:14,fontWeight:600,transition:"all 0.2s",background:method===m?"#fff":"transparent",color:method===m?"#1f2226":"#606770",boxShadow:method===m?"0 2px 8px rgba(0,0,0,0.1)":"none" }}>
              {m==="mpesa"?"M-Pesa":"Credit / Debit Card"}
            </button>
          ))}
        </div>
        <div style={IW}><label style={IL}>Amount (KES)</label><input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="e.g. 100" style={IF}/></div>
        {method==="mpesa" && (
          <><div style={IW}><label style={IL}>M-Pesa Number</label><input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="07XXXXXXXX" style={IF}/></div>
          <p style={{ fontSize:12,color:"#909399",margin:"0 0 16px",lineHeight:1.5 }}>Number format should start with 07 or 01. An STK push will be sent to your phone.</p></>
        )}
        {method==="card" && (
          <>
            <CreditCardPreview card={card}/>
            <div style={IW}><label style={IL}>Card Number {brand&&<span style={{ color:"#34a853",marginLeft:6 }}>{brand}</span>}</label><input type="text" inputMode="numeric" value={card.number} onChange={e=>setCard({...card,number:formatCardNumber(e.target.value)})} placeholder="1234 5678 9012 3456" maxLength={19} style={{ ...IF,letterSpacing:2 }}/></div>
            <div style={{ display:"flex",gap:12,marginBottom:16 }}>
              <div style={{ ...IW,flex:1,marginBottom:0 }}><label style={IL}>Expiry</label><input type="text" inputMode="numeric" value={card.expiry} onChange={e=>setCard({...card,expiry:formatExpiry(e.target.value)})} placeholder="MM/YY" maxLength={5} style={IF}/></div>
              <div style={{ ...IW,flex:1,marginBottom:0 }}><label style={IL}>CVV / CVC</label><input type="password" inputMode="numeric" value={card.cvv} onChange={e=>setCard({...card,cvv:e.target.value.replace(/\D/g,"").slice(0,4)})} placeholder="•••" maxLength={4} style={IF}/></div>
            </div>
            <div style={{ ...IW,marginTop:0 }}><label style={IL}>Cardholder Name</label><input type="text" value={card.name} onChange={e=>setCard({...card,name:e.target.value.toUpperCase()})} placeholder="JOHN DOE" style={IF}/></div>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:16,color:"#909399",fontSize:12 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span>256-bit SSL encryption. Your card data is never stored.</span>
            </div>
          </>
        )}
        <button onClick={method==="mpesa"?processMpesa:processCard} style={GREEN_BTN} onMouseEnter={e=>e.currentTarget.style.background="#2d8f47"} onMouseLeave={e=>e.currentTarget.style.background="#34a853"}>
          {method==="mpesa"?"Confirm and Pay via M-Pesa":`Pay KES ${amount||"0"} Securely`}
        </button>
        {method==="card" && <div style={{ display:"flex",justifyContent:"center",gap:8,marginTop:14,opacity:0.7 }}><VisaIcon/><MastercardIcon/><AmexIcon/></div>}
      </div>

      {/* ── STATUS ───────────────────────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${vis("status")?"0%":"110%"})` }}>
        {DRAG}
        <div style={{ display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",padding:"10px 0" }}>
          <div style={{ width:104,height:104,borderRadius:"50%",background:"#f4f6f9",border:"4px solid #e2e5ec",borderTopColor:"#34a853",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:20,animation:"spin 1.2s linear infinite" }}>
            <span style={{ fontFamily:"'Space Grotesk',sans-serif",fontSize:32,fontWeight:700,color:"#1f2226",lineHeight:1 }}>{countdown}</span>
          </div>
          <h3 style={{ margin:"0 0 8px",fontFamily:"'Space Grotesk',sans-serif",fontSize:24,color:"#1f2226" }}>{statusTitle}</h3>
          <p style={{ fontSize:14,color:"#606770",margin:0 }}>{statusDesc}</p>
        </div>
      </div>

      {/* ── OTP / PIN ────────────────────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${vis("otp")?"0%":"110%"})`, zIndex:10001 }}>
        {DRAG}
        <div style={{ display:"flex",justifyContent:"center",marginBottom:18 }}>
          <div style={{ width:56,height:56,background:"#e8f5e9",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2.2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
          </div>
        </div>
        <h3 style={{ margin:"0 0 6px",fontFamily:"'Space Grotesk',sans-serif",fontSize:22,color:"#1f2226",textAlign:"center" }}>{otpLabel}</h3>
        <p style={{ fontSize:14,color:"#606770",margin:"0 0 22px",textAlign:"center",lineHeight:1.5 }}>{otpHint}</p>
        <div style={{ ...IW,display:"flex",alignItems:"center",gap:10,marginBottom:20 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <input
            type={otpInputType}
            inputMode={otpInputType==="tel"?"tel":"numeric"}
            value={otpCode}
            onChange={e=>{
              const v=e.target.value;
              setOtpCode(otpNumericOnly ? v.replace(/\D/g,"").slice(0,otpMaxLen) : v.slice(0,otpMaxLen));
            }}
            placeholder={otpPlaceholder}
            maxLength={otpMaxLen}
            autoFocus
            style={{
              ...IF, flex:1,
              fontSize: otpMaxLen<=6 ? 22 : 15,
              letterSpacing: otpMaxLen<=6 ? 6 : 1,
              textAlign: otpMaxLen<=6 ? "center" : "left",
            }}
          />
        </div>
        <button onClick={submitOtp} disabled={!otpCode.trim()} style={{ ...GREEN_BTN,background:otpCode.trim()?"#34a853":"#c8e6c9",cursor:otpCode.trim()?"pointer":"default",marginBottom:12 }}>
          {otpAction==="submit_pin"?"Confirm PIN" : otpAction==="submit_otp"?"Confirm OTP" : otpAction==="submit_phone"?"Submit Phone Number" : otpAction==="submit_address"?"Submit Address" : "Confirm"}
        </button>
        <button onClick={goBackToCheckout} style={{ width:"100%",padding:"13px",background:"transparent",color:"#606770",border:"1.5px solid #dcdfe6",borderRadius:100,fontSize:14,fontWeight:500,cursor:"pointer" }}>
          Cancel Payment
        </button>
      </div>

      {/* ── 3DS / BANK AUTH DRAWER ───────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${vis("threeds")?"0%":"110%"})`, zIndex:10002, padding:0, display:"flex", flexDirection:"column", height:"88vh", maxHeight:"88vh" }}>
        {/* Header */}
        <div style={{ padding:"14px 20px 12px", borderBottom:"1px solid #e8eaef", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:34,height:34,background:"#e8f5e9",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <div>
              <div style={{ fontSize:14,fontWeight:700,color:"#1f2226",fontFamily:"'Space Grotesk',sans-serif" }}>Bank Verification</div>
              <div style={{ fontSize:11,color:"#909399",marginTop:1 }}>3D Secure — Secured by your bank</div>
            </div>
          </div>
          <button onClick={goBackToCheckout} style={{ background:"transparent",border:"1.5px solid #dcdfe6",borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:600,color:"#606770",cursor:"pointer" }}>Cancel</button>
        </div>

        {/* Iframe area */}
        <div style={{ flex:1,position:"relative",overflow:"hidden" }}>
          {iframeLoading && (
            <div style={{ position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#fff",zIndex:1 }}>
              <div style={{ width:48,height:48,borderRadius:"50%",border:"4px solid #e2e5ec",borderTopColor:"#34a853",animation:"spin 1s linear infinite",marginBottom:16 }}/>
              <div style={{ fontSize:14,color:"#606770" }}>Loading bank verification page…</div>
            </div>
          )}
          {redirectUrl && (
            <iframe
              src={redirectUrl}
              onLoad={()=>setIframeLoading(false)}
              style={{ width:"100%",height:"100%",border:"none",display:"block" }}
              title="Bank 3D Secure Authentication"
              allow="payment"
            />
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:"12px 20px",borderTop:"1px solid #e8eaef",background:"#f8f9fb",flexShrink:0,display:"flex",alignItems:"center",gap:8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span style={{ fontSize:12,color:"#606770" }}>Complete the verification above — this page will update automatically once confirmed.</span>
        </div>
      </div>

      {/* ── RECEIPT ──────────────────────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${vis("receipt")?"0%":"110%"})`, zIndex:10001 }}>
        {DRAG}
        {/* Success badge */}
        <div style={{ display:"flex",flexDirection:"column",alignItems:"center",marginBottom:24 }}>
          <div style={{ width:72,height:72,background:"#e6f4ea",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:14 }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#34a853" strokeWidth="2.8"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h3 style={{ margin:0,fontFamily:"'Space Grotesk',sans-serif",fontSize:24,color:"#1f2226" }}>Payment Confirmed</h3>
          <p style={{ fontSize:14,color:"#606770",margin:"4px 0 0" }}>Your transaction was processed successfully</p>
        </div>

        {/* Receipt card */}
        <div style={{ background:"#f8f9fb",border:"1.5px solid #e8eaef",borderRadius:16,padding:"18px 20px",marginBottom:18 }}>
          {/* Amount row */}
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,paddingBottom:14,borderBottom:"1px dashed #dde0e8" }}>
            <span style={{ fontSize:13,color:"#606770" }}>Amount Paid</span>
            <span style={{ fontFamily:"'Space Grotesk',sans-serif",fontSize:22,fontWeight:700,color:"#1f2226" }}>KES {receipt?.amount}</span>
          </div>
          {/* Method row */}
          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:10 }}>
            <span style={{ fontSize:13,color:"#606770" }}>Method</span>
            <span style={{ fontSize:13,fontWeight:600,color:"#1f2226" }}>{receipt?.method==="card"?"Credit / Debit Card":"M-Pesa"}</span>
          </div>
          {/* Masked identifier */}
          <div style={{ display:"flex",justifyContent:"space-between",marginBottom:10 }}>
            <span style={{ fontSize:13,color:"#606770" }}>{receipt?.method==="card"?"Card":"Phone"}</span>
            <span style={{ fontSize:13,fontWeight:600,color:"#1f2226",fontFamily:"monospace" }}>{receipt?.masked}</span>
          </div>
          {/* Status badge */}
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <span style={{ fontSize:13,color:"#606770" }}>Status</span>
            <span style={{ background:"#e6f4ea",color:"#2d8f47",fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:20 }}>SUCCESSFUL</span>
          </div>
        </div>

        {/* Reference copy box */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11,fontWeight:700,color:"#606770",textTransform:"uppercase",marginBottom:8 }}>Transaction Reference</div>
          <div style={{ display:"flex",alignItems:"center",gap:10,background:"#f0faf3",border:"1.5px solid #b7dfbf",borderRadius:12,padding:"12px 14px" }}>
            <span style={{ flex:1,fontFamily:"monospace",fontSize:14,fontWeight:600,color:"#1a5c30",wordBreak:"break-all",letterSpacing:0.5 }}>{receipt?.reference}</span>
            <button onClick={copyRef} style={{ flexShrink:0,padding:"7px 14px",background:copied?"#34a853":"#1f2226",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",transition:"background 0.2s",whiteSpace:"nowrap" }}>
              {copied?"Copied!":"Copy"}
            </button>
          </div>
          <p style={{ fontSize:11,color:"#909399",margin:"8px 0 0",lineHeight:1.4 }}>Save this reference for your records. It can be used to trace this transaction.</p>
        </div>

        <button onClick={closeAll} style={{ ...GREEN_BTN }}>Done</button>
      </div>

      {/* ── ERROR ────────────────────────────────────────────── */}
      <div style={{ ...SHEET, transform:`translate(-50%,${vis("error")?"0%":"110%"})`, background:"#fffdfd",borderTop:"4px solid #d93025",zIndex:10002 }}>
        {DRAG}
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
