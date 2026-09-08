#!/usr/bin/env python3
"""Test the claims and strike methods proposed in reference.md against
636 days of Delta India BTC daily-expiry data."""
import analyze as A, features, math, statistics as st

days=A.add_context(A.load())
FE=features.build()
T=A.T_YEARS
def seg(a,b): return [d for d in days if a<=d["date"]<=b]
PER=[("2024",seg("2024-01-01","2024-12-31")),("2025",seg("2025-01-01","2025-12-31")),
     ("2026",seg("2026-01-01","2026-12-31")),("ALL",days)]

# ---- expected move, per reference.md sec 3B:  EM = Spot * IV * sqrt(DTE/365)
def em(d):
    iv=d.get("atmiv")
    return None if not iv else d["spot"]*iv*math.sqrt(T)

def atr_pct(d):
    f=FE.get(d["date"],{}) ; return f.get("atr_pct")

# ---- selectors --------------------------------------------------------
def by_delta(t):
    return lambda c,S,d=None: min([x for x in c if x["delta"] is not None],
                                  key=lambda x:abs(x["delta"]-t), default=None)
def by_em(k):
    def f(c,S,d=None):
        E=em(d)
        if not E: return None
        cp=c[0]["sym"][0]
        tgt=S+k*E if cp=="C" else S-k*E
        return min(c,key=lambda x:abs(x["K"]-tgt))
    return f
def by_norm(field,thr):
    """normalised premium cap, per reference.md sec 27"""
    def f(c,S,d=None):
        if field=="spot": den=S
        elif field=="em": den=em(d)
        else: den=(atr_pct(d) or 0)*S
        if not den: return None
        el=[x for x in c if x["entry"]/den<=thr]
        return max(el,key=lambda x:x["entry"],default=None)
    return f
def wrap(f):
    return lambda c,S,d=None: f(c,S)

def fixed_cap(n):
    return lambda c,S,d=None: max([x for x in c if x["entry"]<=n],key=lambda x:x["entry"],default=None)

def run2(dd,selC,selP,exitfn=None,filt=None):
    ef=exitfn or A.EXITS["hold to 17:29"]; out=[]
    for d in dd:
        if filt and not filt(d): continue
        tot=0.0; got=False
        for cp,sel in (("C",selC),("P",selP)):
            c=d["legs"][cp]
            if not c: continue
            leg=sel(c,d["spot"],d)
            if not leg: continue
            p,_=A.pnl(leg,ef); tot+=p; got=True
        if got: out.append(tot)
    return out

def row(lab,dd,selC,selP,exitfn=None,filt=None):
    m=A.metrics(run2(dd,selC,selP,exitfn,filt))
    if not m: return f"  {lab:34s}    no trades"
    pf="inf" if m['pf']==float('inf') else f"{m['pf']:.2f}"
    return (f"  {lab:34s} {m['n']:>5d} {m['win%']:>6.1f}% {m['total']*85:>8.0f} "
            f"{m['maxloss']*85:>9.0f} {pf:>8s} {m['maxdd']*85:>9.0f}")
H=f"  {'method':34s} {'days':>5s} {'win%':>7s} {'INR':>8s} {'maxloss':>9s} {'PF':>8s} {'maxDD':>9s}"

print("="*108)
print("TESTING reference.md AGAINST 636 DAYS OF DELTA INDIA BTC DAILY-EXPIRY DATA")
print("10 lots | lot 0.001 BTC | slippage 5% | 1 USD = 85 INR | entry 05:30 IST, exit 17:29 IST")
print("="*108)

print("\n\n### R1.  THE SIX STRIKE METHODS reference.md SAYS TO TEST FIRST (sec 'Method A-F')")
M=[("A. fixed premium <=15 (current)",fixed_cap(15),fixed_cap(15)),
   ("B. fixed delta 15",by_delta(0.15),by_delta(0.15)),
   ("C. delta 10 / 10",by_delta(0.10),by_delta(0.10)),
   ("D. expected move 1.0 EM",by_em(1.0),by_em(1.0)),
   ("D2. expected move 1.5 EM",by_em(1.5),by_em(1.5)),
   ("D3. expected move 2.0 EM",by_em(2.0),by_em(2.0)),
   ("E. skew-adj: CE 15d / PE 8d",by_delta(0.15),by_delta(0.08)),
   ("E2. asymmetric: CE 10d / PE 20d",by_delta(0.10),by_delta(0.20)),
   ("F. per-leg best (K3 winner)",fixed_cap(15),wrap(A.SELECTORS["prem 15-40"]))]
for lab,sc,sp in M:
    print(f"\n  -- {lab}")
    print(H)
    for pl,dd in PER:
        if dd: print(row(f"     {pl}",dd,sc,sp))

print("\n\n### R2.  reference.md CLAIM: 'fixed 15 has a major weakness, normalised is more robust'")
print("     Testing Premium/Spot, Premium/ExpectedMove, Premium/ATR against the fixed cap.")
NORM=[("fixed premium <=15",fixed_cap(15)),
      ("Premium/Spot <= 0.00015",by_norm("spot",0.00015)),
      ("Premium/Spot <= 0.00025",by_norm("spot",0.00025)),
      ("Premium/EM  <= 0.010",by_norm("em",0.010)),
      ("Premium/EM  <= 0.020",by_norm("em",0.020)),
      ("Premium/EM  <= 0.040",by_norm("em",0.040)),
      ("Premium/ATR <= 0.005",by_norm("atr",0.005)),
      ("Premium/ATR <= 0.010",by_norm("atr",0.010))]
for lab,sel in NORM:
    print(f"\n  -- {lab}")
    print(H)
    for pl,dd in PER:
        if dd: print(row(f"     {pl}",dd,sel,sel))

print("\n\n### R3.  PROFIT-EXIT LADDER (reference.md sec 31) on the current strategy")
print(H)
for pct in (0.25,0.40,0.50,0.60,0.70,0.80):
    print(row(f"     book at {int(pct*100)}% decay, ALL",days,fixed_cap(15),fixed_cap(15),A.exit_book(pct)))
print(row("     hold to expiry (current), ALL",days,fixed_cap(15),fixed_cap(15)))

print("\n\n### R4.  STOP-LOSS MODELS (reference.md sec 32) on the current strategy")
print(H)
for k in (1.5,2.0,3.0,5.0):
    print(row(f"     SL at {k}x entry premium, ALL",days,fixed_cap(15),fixed_cap(15),A.exit_sl(k)))
print(row("     no SL (current), ALL",days,fixed_cap(15),fixed_cap(15)))

print("\n\n### R5.  IV / RV  (VRP) REGIME FILTER (reference.md sec 12, 37 Tier-1)")
rv=lambda d: FE.get(d["date"],{}).get("rv20")
print(H)
FL=[("no filter",None),
    ("IV > RV20 (positive VRP)",lambda d: d.get("atmiv") and rv(d) and d["atmiv"]>rv(d)),
    ("IV > 1.2x RV20",          lambda d: d.get("atmiv") and rv(d) and d["atmiv"]>1.2*rv(d)),
    ("IV > 1.5x RV20",          lambda d: d.get("atmiv") and rv(d) and d["atmiv"]>1.5*rv(d)),
    ("IV < RV20 (negative VRP)",lambda d: d.get("atmiv") and rv(d) and d["atmiv"]<rv(d))]
for lab,f in FL: print(row(f"     {lab}",days,fixed_cap(15),fixed_cap(15),None,f))

print("\n\n### R6.  IV PERCENTILE REGIME (reference.md sec 4)")
ivs=sorted(d["atmiv"] for d in days if d.get("atmiv"))
def ivp(d):
    v=d.get("atmiv")
    if not v or not ivs: return None
    return 100.0*sum(1 for x in ivs if x<=v)/len(ivs)
print(H)
for lo,hi in ((0,20),(20,40),(40,60),(60,80),(80,100)):
    print(row(f"     IVP {lo}-{hi}",days,fixed_cap(15),fixed_cap(15),None,
              (lambda a,b: (lambda d: ivp(d) is not None and a<=ivp(d)<b))(lo,hi)))

print("\n\n### R7.  ADX / TREND NO-TRADE FILTER (reference.md sec 14, 29)")
adx=lambda d: FE.get(d["date"],{}).get("adx")
print(H)
for lab,f in [("no filter",None),
              ("ADX < 20 (range only)",lambda d: adx(d) is not None and adx(d)<20),
              ("ADX < 25",             lambda d: adx(d) is not None and adx(d)<25),
              ("ADX > 25 (trending)",  lambda d: adx(d) is not None and adx(d)>25)]:
    print(row(f"     {lab}",days,fixed_cap(15),fixed_cap(15),None,f))

print("\n\n### R8.  OI / PCR / LIQUIDITY FILTERS (reference.md sec 17, 18)")
def pcr(d):
    co=sum(x["oi"] or 0 for x in d["legs"]["C"]); po=sum(x["oi"] or 0 for x in d["legs"]["P"])
    return (po/co) if co>0 else None
vals=[pcr(d) for d in days if pcr(d)]
pm=st.median(vals) if vals else None
print(f"  (median PCR = {pm:.2f})" if pm else "  (no OI data)")
print(H)
for lab,f in [("no filter",None),
              (f"PCR > median",lambda d: pcr(d) is not None and pcr(d)>pm),
              (f"PCR < median",lambda d: pcr(d) is not None and pcr(d)<=pm)]:
    print(row(f"     {lab}",days,fixed_cap(15),fixed_cap(15),None,f))

print("\n\n### R9.  PREMIUM / EXPECTED-MOVE  (PEM, reference.md sec 11) AS A FILTER")
def pem(d):
    E=em(d)
    if not E: return None
    tot=0.0
    for cp in ("C","P"):
        l=fixed_cap(15)(d["legs"][cp],d["spot"],d)
        if l: tot+=l["entry"]
    return tot/E if tot else None
pv=[pem(d) for d in days if pem(d)]
pmed=st.median(pv) if pv else None
print(f"  (median Premium/EM = {pmed:.4f})" if pmed else "")
print(H)
for lab,f in [("no filter",None),
              ("PEM > median (richer premium)",lambda d: pem(d) is not None and pem(d)>pmed),
              ("PEM < median (cheap premium)", lambda d: pem(d) is not None and pem(d)<=pmed)]:
    print(row(f"     {lab}",days,fixed_cap(15),fixed_cap(15),None,f))
