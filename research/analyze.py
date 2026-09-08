#!/usr/bin/env python3
"""R&D: compare strike-selection / exit / filter variants for the Delta India
daily-expiry BTC short-premium setup.  CE and PE measured separately.
Position sizing + margin model taken from test.md."""
import json,os,glob,math,datetime,statistics as st
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
CACHE=os.path.join(os.path.dirname(os.path.abspath(__file__)),"cache")

# ---- test.md model ------------------------------------------------------
LOT_SIZE     = 0.001      # BTC per lot
MARGIN_PER_LOT = 0.50     # USD
USDINR       = 85.0
LOTS         = 10
SLIPPAGE     = 0.05
BASE         = 'prem<=15 [BASELINE]'   # <-- the user's live strategy: sell CE+PE, premium<=15
T_YEARS      = 12/24/365.0   # 05:30 -> 17:30 IST

# ---- Black-Scholes (r=0) for IV + delta ---------------------------------
def _nd(x): return 0.5*(1+math.erf(x/math.sqrt(2)))
def bs(cp,S,K,T,v):
    if v<=0 or T<=0: return max(0.0,(S-K) if cp=="C" else (K-S))
    d1=(math.log(S/K)+0.5*v*v*T)/(v*math.sqrt(T)); d2=d1-v*math.sqrt(T)
    return S*_nd(d1)-K*_nd(d2) if cp=="C" else K*_nd(-d2)-S*_nd(-d1)
def iv(cp,S,K,T,px):
    lo,hi=1e-4,8.0
    if bs(cp,S,K,T,hi)<px: return None
    for _ in range(60):
        m=(lo+hi)/2
        if bs(cp,S,K,T,m)<px: lo=m
        else: hi=m
    return (lo+hi)/2
def delta(cp,S,K,T,v):
    if not v or T<=0: return 1.0 if (cp=="C" and S>K) or (cp=="P" and S<K) else 0.0
    d1=(math.log(S/K)+0.5*v*v*T)/(v*math.sqrt(T))
    return _nd(d1) if cp=="C" else _nd(d1)-1

# ---- load ---------------------------------------------------------------
def load():
    days=[]
    for f in sorted(glob.glob(os.path.join(CACHE,"*.json"))):
        d=json.load(open(f))
        if not d.get("spot") or not d.get("syms"): continue
        S=d["spot"]; legs={"C":[],"P":[]}
        for sym,v in d["syms"].items():
            cp=sym[0]; K=float(sym.split("-")[2])
            if v["entry"] is None: continue
            vol=iv(cp,S,K,T_YEARS,v["entry"])
            dist_=abs(K-S)/S
            legs[cp].append({"sym":sym,"K":K,"entry":v["entry"],
                "exit":v["exit"] if v["exit"] is not None else 0.10,
                "hi":v["hi"],"path":v["path"],
                "dist":dist_,"iv":vol,
                "vol":v.get("vol") or 0.0,"oi":v.get("oi_open"),
                "mark_open":v.get("mark_open"),"mark_close":v.get("mark_close"),
                "prem_per_dist":(v["entry"]/dist_ if dist_>0 else 0.0),
                "delta":abs(delta(cp,S,K,T_YEARS,vol)) if vol else None})
        if legs["C"] or legs["P"]:
            days.append({"date":d["date"],"spot":S,"spath":d.get("spath") or [],"legs":legs})
    return days

# ---- strike selectors (return one leg dict or None) ---------------------
def cap(n):   return lambda c,S: max([x for x in c if x["entry"]<=n], key=lambda x:x["entry"], default=None)
def band(a,b):return lambda c,S: max([x for x in c if a<=x["entry"]<=b], key=lambda x:x["entry"], default=None)
def dist(p):  return lambda c,S: min([x for x in c if x["dist"]>=p], key=lambda x:x["dist"], default=None)
def dlt(t):   return lambda c,S: min([x for x in c if x["delta"] is not None], key=lambda x:abs(x["delta"]-t), default=None)
def richest():return lambda c,S: max(c, key=lambda x:x["entry"], default=None)

def rich_otm(minp):
    """among strikes at least `minp` OTM, take the RICHEST premium."""
    return lambda c,S: max([x for x in c if x["dist"]>=minp], key=lambda x:x["entry"], default=None)
def prem_per_dist(minp):
    """best premium per unit distance = most over-paid tail."""
    return lambda c,S: max([x for x in c if x["dist"]>=minp], key=lambda x:x["prem_per_dist"], default=None)
def iv_rich(minp):
    return lambda c,S: max([x for x in c if x["dist"]>=minp and x["iv"]], key=lambda x:x["iv"], default=None)
def liq(inner,minvol=0,minoi=0):
    def f(c,S):
        return inner([x for x in c if (x["vol"] or 0)>=minvol and (x["oi"] or 0)>=minoi],S)
    return f

SELECTORS={
 "rich OTM >=2%":rich_otm(0.02), "rich OTM >=3%":rich_otm(0.03), "rich OTM >=5%":rich_otm(0.05),
 "prem/dist >=2%":prem_per_dist(0.02), "prem/dist >=4%":prem_per_dist(0.04),
 "IV-rich >=3%":iv_rich(0.03),
 "prem<=15 +liq":liq(cap(15),minvol=1000,minoi=1.0),
 "rich OTM>=3% +liq":liq(rich_otm(0.03),minvol=1000,minoi=1.0),
 "prem<=5":cap(5), "prem<=15 [BASELINE]":cap(15), "prem<=40":cap(40), "prem<=100":cap(100),
 "prem 15-40":band(15,40), "prem 40-100":band(40,100),
 "dist>=2%":dist(0.02), "dist>=4%":dist(0.04),
 "delta~0.10":dlt(0.10), "delta~0.25":dlt(0.25), "richest(ATM)":richest(),
}

# ---- exit rules ---------------------------------------------------------
def exit_hold(leg):  return leg["exit"],"hold"
def exit_book(pct):
    def f(leg):
        tgt=leg["entry"]*(1-pct)
        for _,px in leg["path"]:
            if px<=tgt: return px,"booked"
        return leg["exit"],"hold"
    return f
def exit_sl(mult):
    def f(leg):
        stop=leg["entry"]*mult
        for _,px in leg["path"]:
            if px>=stop: return px,"stopped"
        return leg["exit"],"hold"
    return f
def exit_sl_book(mult,pct):
    def f(leg):
        stop=leg["entry"]*mult; tgt=leg["entry"]*(1-pct)
        for _,px in leg["path"]:
            if px>=stop: return px,"stopped"
            if px<=tgt:  return px,"booked"
        return leg["exit"],"hold"
    return f
EXITS={"hold to 17:29":exit_hold,"book 50% decay":exit_book(0.50),
       "SL 3x":exit_sl(3.0),"SL 3x + book 50%":exit_sl_book(3.0,0.50)}

# ---- pnl ----------------------------------------------------------------
def pnl(leg,exitfn,lots=LOTS):
    x,how=exitfn(leg)
    sell=leg["entry"]*(1-SLIPPAGE); buy=x*(1+SLIPPAGE)
    return (sell-buy)*lots*LOT_SIZE, how

def metrics(vals):
    if not vals: return None
    n=len(vals); w=[v for v in vals if v>0]; l=[v for v in vals if v<0]
    tot=sum(vals); gp=sum(w); gl=-sum(l)
    cum=0; peak=0; dd=0
    for v in vals:
        cum+=v; peak=max(peak,cum); dd=min(dd,cum-peak)
    return {"n":n,"win%":100*len(w)/n,"total":tot,"avg":tot/n,
            "maxloss":min(vals),"pf":(gp/gl if gl>0 else float('inf')),
            "maxdd":dd,"margin_roi":100*tot/(LOTS*MARGIN_PER_LOT) if LOTS else 0}

# ---- study --------------------------------------------------------------
def run(days,selname,exitname,side="BOTH",filt=None):
    sel=SELECTORS[selname]; ef=EXITS[exitname]
    per_day=[]; ce=[]; pe=[]; hows={}
    for d in days:
        if filt and not filt(d): continue
        tot=0.0; got=False
        for cp,bucket in (("C",ce),("P",pe)):
            if side!="BOTH" and side!=cp: continue
            c=d["legs"][cp]
            if not c: continue
            leg=sel(c,d["spot"])
            if not leg: continue
            p,how=pnl(leg,ef); bucket.append(p); tot+=p; got=True
            hows[how]=hows.get(how,0)+1
        if got: per_day.append(tot)
    return per_day,ce,pe,hows

def fmt(m,label):
    if not m: return f"  {label:24s}      no trades"
    inr=m['total']*USDINR
    pf="inf" if m['pf']==float('inf') else f"{m['pf']:.2f}"
    return (f"  {label:24s} {m['n']:>4d} {m['win%']:>6.1f}% {m['total']:>9.4f} {inr:>8.0f} "
            f"{m['avg']:>8.4f} {m['maxloss']:>9.4f} {pf:>7s} {m['maxdd']:>8.4f}")

HDR=(f"  {'variant':24s} {'trds':>4s} {'win%':>7s} {'totUSD':>9s} {'totINR':>8s} "
     f"{'avg':>8s} {'maxloss':>9s} {'PF':>7s} {'maxDD':>8s}")

def study(days,title):
    print(f"\n{'='*112}\n{title}   |  {len(days)} days  {days[0]['date']} -> {days[-1]['date']}"
          f"  |  {LOTS} lots, lot {LOT_SIZE} BTC, slippage {SLIPPAGE:.0%}, 1 USD = {USDINR:.0f} INR\n{'='*112}")

    print(f"\n### A. STRIKE SELECTION  (exit: hold to 17:29)  -- CE+PE combined per day\n{HDR}")
    rows=[]
    for s in SELECTORS:
        pd_,ce,pe,_=run(days,s,"hold to 17:29")
        m=metrics(pd_); rows.append((s,m))
        print(fmt(m,s))

    print(f"\n### B. SAME, CE LEG ONLY\n{HDR}")
    for s in SELECTORS:
        _,ce,_,_=run(days,s,"hold to 17:29",side="C"); print(fmt(metrics(ce),s))
    print(f"\n### C. SAME, PE LEG ONLY\n{HDR}")
    for s in SELECTORS:
        _,_,pe,_=run(days,s,"hold to 17:29",side="P"); print(fmt(metrics(pe),s))

    ok=[r for r in rows if r[1] and r[1]["n"]>=20]
    chall=max(ok,key=lambda r:r[1]['pf'])[0] if ok else BASE
    b=dict(rows).get(BASE)
    if b:
        print(f"\n  >>> BASELINE (prem<=15 CE+PE): {b['n']} trades, win {b['win%']:.1f}%, "
              f"INR {b['total']*USDINR:.0f}, maxloss INR {b['maxloss']*USDINR:.0f}, maxDD INR {b['maxdd']*USDINR:.0f}")
        print(f"  >>> best challenger by profit factor (n>=20): {chall}")

    print(f"\n### D. EXIT RULES on BASELINE (prem<=15 CE+PE)  <-- your strategy\n{HDR}")
    for e in EXITS:
        pd_,_,_,hows=run(days,BASE,e)
        print(fmt(metrics(pd_),e)+f"   {hows}")
    print(f"\n### E. EXIT RULES on challenger ({chall})\n{HDR}")
    for e in EXITS:
        pd_,_,_,hows=run(days,chall,e)
        print(fmt(metrics(pd_),e)+f"   {hows}")
    return rows,BASE,chall


# ---- helpers for filters (all known AT ENTRY - no lookahead) ------------
def atm_iv(d):
    best=None
    for cp in ("C","P"):
        for x in d["legs"][cp]:
            if x["iv"] is None: continue
            if best is None or x["dist"]<best[0]: best=(x["dist"],x["iv"])
    return best[1] if best else None

def add_context(days):
    for i,d in enumerate(days):
        d["atmiv"]=atm_iv(d)
        d["prev_ret"]=None
        if i>0 and days[i-1]["spot"]:
            d["prev_ret"]=(d["spot"]-days[i-1]["spot"])/days[i-1]["spot"]
    return days

def entry_at(leg,hhmm):
    """re-price entry from the 15-min path (theta-timing study)."""
    if not leg["path"]: return None
    hh,mm=hhmm
    for ts,px in leg["path"]:
        t=datetime.datetime.fromtimestamp(ts,IST)
        if (t.hour,t.minute)>=(hh,mm): return px
    return None

def run_entry(days,selname,hhmm):
    sel=SELECTORS[selname]; out=[]
    for d in days:
        tot=0.0; got=False
        for cp in ("C","P"):
            c=d["legs"][cp]
            if not c: continue
            leg=sel(c,d["spot"])
            if not leg: continue
            e=entry_at(leg,hhmm)
            if e is None: continue
            sell=e*(1-SLIPPAGE); buy=leg["exit"]*(1+SLIPPAGE)
            tot+=(sell-buy)*LOTS*LOT_SIZE; got=True
        if got: out.append(tot)
    return out

def run_hedged(days,selname,width):
    """sell selected strike, buy `width` strikes further OTM -> defined risk"""
    sel=SELECTORS[selname]; out=[]
    for d in days:
        tot=0.0; got=False
        for cp in ("C","P"):
            c=d["legs"][cp]
            if not c: continue
            short=sel(c,d["spot"])
            if not short: continue
            further=[x for x in c if (x["K"]>short["K"] if cp=="C" else x["K"]<short["K"])]
            if not further: continue
            long=min(further,key=lambda x:abs(abs(x["K"]-short["K"])-width*1000))
            ps=(short["entry"]*(1-SLIPPAGE)-short["exit"]*(1+SLIPPAGE))*LOTS*LOT_SIZE
            pl=(long["exit"]*(1-SLIPPAGE)-long["entry"]*(1+SLIPPAGE))*LOTS*LOT_SIZE
            tot+=ps+pl; got=True
        if got: out.append(tot)
    return out

def extra(days,best):
    print(f"\n### F. FILTERS  (strike={best}, exit=hold)  -- all filters known at 05:30, no lookahead\n"+HDR)
    ivs=[d["atmiv"] for d in days if d["atmiv"]]
    med=st.median(ivs) if ivs else None
    prs=[abs(d["prev_ret"]) for d in days if d["prev_ret"] is not None]
    pmed=st.median(prs) if prs else None
    fl={"no filter":None,
        f"ATM IV > median ({med:.1%})" if med else "iv":(lambda d:d["atmiv"] is not None and d["atmiv"]>med),
        f"ATM IV < median":(lambda d:d["atmiv"] is not None and d["atmiv"]<=med),
        f"|prev day move| < median ({pmed:.2%})" if pmed else "tr":(lambda d:d["prev_ret"] is not None and abs(d["prev_ret"])<pmed),
        "|prev day move| < 1%":(lambda d:d["prev_ret"] is not None and abs(d["prev_ret"])<0.01)}
    for name,f in fl.items():
        pd_,_,_,_=run(days,best,"hold to 17:29",filt=f); print(fmt(metrics(pd_),name))

    print(f"\n### G. ENTRY TIMING  (strike={best}, exit hold to 17:29)\n"+HDR)
    for lab,hm in [("enter 05:30 (base)",(5,30)),("enter 07:30",(7,30)),
                   ("enter 09:30",(9,30)),("enter 11:30",(11,30)),("enter 13:30",(13,30))]:
        print(fmt(metrics(run_entry(days,best,hm)),lab))

    print(f"\n### H. HEDGED SPREAD vs NAKED  (strike={best})\n"+HDR)
    print(fmt(metrics(run(days,best,"hold to 17:29")[0]),"naked short"))
    for w in (1,2,3,5):
        print(fmt(metrics(run_hedged(days,best,w)),f"spread, {w}k wide"))

    print(f"\n### I. POSITION SIZING  (test.md model: margin ${MARGIN_PER_LOT}/lot, 1 USD = {USDINR:.0f} INR)")
    for name in ["prem<=15 [BASELINE]",best]:
        pd_,_,_,_=run(days,name,"hold to 17:29"); m=metrics(pd_)
        if not m: continue
        worst=abs(m["maxloss"]); dd=abs(m["maxdd"])
        print(f"\n  strike rule: {name}")
        print(f"    at {LOTS} lots -> worst day ${worst:.4f} (INR {worst*USDINR:.0f}), maxDD ${dd:.4f} (INR {dd*USDINR:.0f})")
        print(f"    margin used  = {LOTS}x2 legs x ${MARGIN_PER_LOT} = ${LOTS*2*MARGIN_PER_LOT:.2f} (INR {LOTS*2*MARGIN_PER_LOT*USDINR:.0f})")
        print(f"    {'fund INR':>10s} {'max lots':>9s} {'lots @2% risk/day':>19s} {'lots @10% maxDD':>17s}")
        for fund in (10000,50000,100000,500000):
            usd=fund/USDINR
            maxlots=int(usd//MARGIN_PER_LOT)
            l_day=int((usd*0.02)/(worst/LOTS)) if worst>0 else maxlots
            l_dd =int((usd*0.10)/(dd/LOTS)) if dd>0 else maxlots
            print(f"    {fund:>10,d} {maxlots:>9,d} {min(l_day,maxlots):>19,d} {min(l_dd,maxlots):>17,d}")


# ---- J. technical feature filters (all from prior close - no lookahead) --
def tech_filters(FE):
    import statistics as _s
    def q(key,fn):
        vals=[v[key] for v in FE.values() if v.get(key) is not None]
        return _s.median(vals) if vals else None
    med={k:q(k,None) for k in ("rsi","adx","atr_pct","bb_width","rv10","rv20","macd_hist")}
    F={}
    F["no filter"]=lambda d:True
    F[f"RSI > 60"]        =lambda d: (FE.get(d["date"],{}).get("rsi") or 0)>60
    F[f"RSI 40-60 (range)"]=lambda d: 40<=(FE.get(d["date"],{}).get("rsi") or -1)<=60
    F[f"RSI < 40"]        =lambda d: 0<(FE.get(d["date"],{}).get("rsi") or 999)<40
    F[f"ADX < 20 (range)"] =lambda d: 0<(FE.get(d["date"],{}).get("adx") or 999)<20
    F[f"ADX 20-25"]        =lambda d: 20<=(FE.get(d["date"],{}).get("adx") or -1)<25
    F[f"ADX > 25 (trend)"] =lambda d: (FE.get(d["date"],{}).get("adx") or 0)>25
    F[f"ATR% < median"]    =lambda d: (FE.get(d["date"],{}).get("atr_pct") or 9)<med["atr_pct"]
    F[f"ATR% > median"]    =lambda d: (FE.get(d["date"],{}).get("atr_pct") or 0)>med["atr_pct"]
    F["MACD hist > 0"]     =lambda d: (FE.get(d["date"],{}).get("macd_hist") or 0)>0
    F["MACD hist < 0"]     =lambda d: (FE.get(d["date"],{}).get("macd_hist") or 0)<0
    F["close > EMA20"]     =lambda d: bool(FE.get(d["date"],{}).get("above_ema20"))
    F["close < EMA20"]     =lambda d: FE.get(d["date"],{}).get("above_ema20") is False
    F["EMA20 > EMA50 (up)"]=lambda d: bool(FE.get(d["date"],{}).get("ema20_gt_50"))
    F["EMA20 < EMA50 (dn)"]=lambda d: FE.get(d["date"],{}).get("ema20_gt_50") is False
    F["BBwidth < median"]  =lambda d: (FE.get(d["date"],{}).get("bb_width") or 9)<med["bb_width"]
    F["BBwidth > median"]  =lambda d: (FE.get(d["date"],{}).get("bb_width") or 0)>med["bb_width"]
    F["RV20 < median"]     =lambda d: (FE.get(d["date"],{}).get("rv20") or 9)<med["rv20"]
    F["RV20 > median"]     =lambda d: (FE.get(d["date"],{}).get("rv20") or 0)>med["rv20"]
    F["VRP: IV > RV20"]    =lambda d: d.get("atmiv") is not None and (FE.get(d["date"],{}).get("rv20") or 9)<d["atmiv"]
    F["VRP: IV > 1.2x RV20"]=lambda d: d.get("atmiv") is not None and d["atmiv"]>1.2*(FE.get(d["date"],{}).get("rv20") or 9)
    F["VRP: IV < RV20"]    =lambda d: d.get("atmiv") is not None and (FE.get(d["date"],{}).get("rv20") or 0)>d["atmiv"]
    for i,nm in enumerate(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]):
        F[f"dow {nm}"]=(lambda k: (lambda d: FE.get(d["date"],{}).get("dow")==k))(i)
    return F

def study_tech(days,best,FE):
    print(f"\n### J. TECHNICAL / REGIME FILTERS  (strike={best}, exit=hold to 17:29)")
    print("    every feature computed from the PRIOR daily close -> known at 05:30 entry")
    print(HDR)
    rows=[]
    for name,f in tech_filters(FE).items():
        pd_,_,_,_=run(days,best,"hold to 17:29",filt=f)
        m=metrics(pd_)
        if m and m["n"]>=15: rows.append((name,m))
        print(fmt(m,name))
    if rows:
        print("\n  --- ranked by profit factor (min 15 trades) ---")
        for n,m in sorted(rows,key=lambda r:-r[1]["pf"])[:8]:
            pf="inf" if m["pf"]==float('inf') else f"{m['pf']:.2f}"
            print(f"    {n:26s} PF={pf:>7s}  total INR {m['total']*USDINR:>7.0f}  "
                  f"win {m['win%']:.0f}%  n={m['n']}  maxDD {m['maxdd']*USDINR:.0f}")

if __name__=="__main__":
    import features
    days=add_context(load())
    if not days: print("no cache yet"); raise SystemExit
    FE=features.build()
    def seg(a,b):
        return [d for d in days if a<=d["date"]<=b]

    PERIODS=[("FULL  2024-09-04 -> 2026-09-03", days),
             ("YEAR 2025  (2025-01-01 -> 2025-12-31)", seg("2025-01-01","2025-12-31")),
             ("YEAR 2026  (2026-01-01 -> 2026-09-03)", seg("2026-01-01","2026-12-31"))]

    summary=[]
    for label,dd in PERIODS:
        if len(dd)<30:
            print(f"\n\n{'#'*112}\n#  {label}  -- only {len(dd)} days, skipped\n{'#'*112}")
            continue
        print(f"\n\n{'#'*112}\n#  PERIOD: {label}   ({len(dd)} days)\n{'#'*112}")
        rows,base,chall=study(dd,"DELTA INDIA BTC DAILY SHORT-PREMIUM R&D  |  "+label)
        extra(dd,base)
        study_tech(dd,base,FE)
        m=dict(rows).get(base)
        summary.append((label,m,dict(rows)))

    # ---- cross-period stability: does any rule survive BOTH years? ----
    print(f"\n\n{'#'*112}\n#  CROSS-PERIOD STABILITY  -  a rule is only real if it works in BOTH 2025 and 2026\n{'#'*112}")
    if len(summary)>=3:
        _,_,r25=summary[1]; _,_,r26=summary[2]
        print(f"\n  {'strike rule':24s} {'2025 INR':>10s} {'2025 PF':>8s} {'2026 INR':>10s} {'2026 PF':>8s}  {'verdict':s}")
        for k in SELECTORS:
            a=r25.get(k); b=r26.get(k)
            if not a or not b: continue
            pfa="inf" if a['pf']==float('inf') else f"{a['pf']:.2f}"
            pfb="inf" if b['pf']==float('inf') else f"{b['pf']:.2f}"
            good=(a['total']>0 and b['total']>0)
            v="STABLE (+ both years)" if good else ("fails 2026" if a['total']>0 else ("fails 2025" if b['total']>0 else "loses both"))
            print(f"  {k:24s} {a['total']*USDINR:>10.0f} {pfa:>8s} {b['total']*USDINR:>10.0f} {pfb:>8s}  {v}")
