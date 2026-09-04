#!/usr/bin/env python3
"""N. RECONCILIATION PACK  +  O. variants  +  P. PE band sweep  +  Q. adaptive PE"""
import analyze as A, features, math, json, glob, os, datetime
days=A.add_context(A.load()); T=A.T_YEARS
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
CACHE=os.path.join(os.path.dirname(os.path.abspath(__file__)),"cache")
def seg(a,b): return [d for d in days if a<=d["date"]<=b]
PER=[("2024",seg("2024-01-01","2024-12-31")),("2025",seg("2025-01-01","2025-12-31")),
     ("2026",seg("2026-01-01","2026-12-31")),("ALL",days)]
def em(d):
    iv=d.get("atmiv")
    return None if not iv else d["spot"]*iv*math.sqrt(T)
def cap(n):    return lambda c,S,d: max([x for x in c if x["entry"]<=n],key=lambda x:x["entry"],default=None)
def band(a,b): return lambda c,S,d: max([x for x in c if a<=x["entry"]<=b],key=lambda x:x["entry"],default=None)
def emcap(sel,k=0.020):
    def f(c,S,d):
        E=em(d)
        if not E: return None
        return sel([x for x in c if x["entry"]/E<=k],S,d)
    return f
def run2(dd,sc,sp,ef=None):
    ef=ef or A.EXITS["hold to 17:29"]; out=[]
    for d in dd:
        tot=0.0; got=False
        for cp,sel in (("C",sc),("P",sp)):
            c=d["legs"][cp]
            if not c: continue
            L=sel(c,d["spot"],d)
            if not L: continue
            p,_=A.pnl(L,ef); tot+=p; got=True
        if got: out.append(tot)
    return out
H=f"  {'variant':38s} {'days':>5s} {'win%':>7s} {'INR':>8s} {'avg':>7s} {'maxloss':>9s} {'PF':>8s} {'maxDD':>8s}"
def row(lab,dd,sc,sp,ef=None):
    m=A.metrics(run2(dd,sc,sp,ef))
    if not m: return f"  {lab:38s}    no trades"
    pf="inf" if m['pf']==float('inf') else f"{m['pf']:.2f}"
    return (f"  {lab:38s} {m['n']:>5d} {m['win%']:>6.1f}% {m['total']*85:>8.0f} {m['avg']*85:>7.1f} "
            f"{m['maxloss']*85:>9.0f} {pf:>8s} {m['maxdd']*85:>8.0f}")

W=118
print("="*W); print("  N.  RECONCILIATION PACK  -  paste your AlgoTest trade log for these days and compare line by line")
print("="*W)
for tgt in ("2025-02-28","2025-03-29"):
    f=os.path.join(CACHE,tgt+".json")
    if not os.path.exists(f): print(f"\n  {tgt}: not in cache"); continue
    raw=json.load(open(f)); d=next((x for x in days if x["date"]==tgt),None)
    E=em(d)
    print(f"\n\n  {'='*110}\n  DATE {tgt}   spot@05:30 = {d['spot']:.1f}   ATM IV = {(d.get('atmiv') or 0)*100:.1f}%"
          f"   ExpectedMove = {E:.0f}" if E else "")
    print(f"  {'='*110}")
    print(f"  FULL CHAIN as harvested (1-minute candle CLOSE).  'picked' = what this reproduction chose.")
    print(f"  {'symbol':24s} {'strike':>8s} {'entry@05:30':>12s} {'exit@17:29':>11s} {'dist%':>7s} {'IV%':>6s} "
          f"{'prem/EM':>8s} {'vol':>10s} {'OI':>8s}  picked")
    picks={}
    for cp,lab in (("C","CE"),("P","PE")):
        L=cap(15)(d["legs"][cp],d["spot"],d)
        if L: picks[L["sym"]]=lab
    for cp in ("C","P"):
        for x in sorted(d["legs"][cp],key=lambda z:z["K"]):
            r=raw["syms"].get(x["sym"],{})
            mark=f"  <== {picks[x['sym']]} (prem<=15)" if x["sym"] in picks else ""
            print(f"  {x['sym']:24s} {x['K']:>8.0f} {x['entry']:>12.2f} {x['exit']:>11.2f} "
                  f"{x['dist']*100:>6.2f}% {(x['iv'] or 0)*100:>5.1f}% {(x['entry']/E if E else 0):>8.4f} "
                  f"{(r.get('vol') or 0):>10.0f} {(r.get('oi_open') or 0):>8.2f}{mark}")
    print(f"\n  WHAT TO CHECK AGAINST AlgoTest for {tgt}:")
    print(f"    1. Did AlgoTest pick the same two symbols marked <== above?")
    print(f"    2. Are its entry prices the same as 'entry@05:30'?")
    print(f"    3. Are its exit prices the same as 'exit@17:29'?")
    print(f"    4. What charges did it deduct on this day?")

print("\n\n"+"="*W); print("  O.  FOUR VARIANTS, FULL PERIOD AND PER YEAR"); print("="*W)
V=[("A  CE<=15 + PE<=15",           cap(15), cap(15)),
   ("B  CE<=15 + PE 15-40",         cap(15), band(15,40)),
   ("C  B + Prem/EM<=2% both legs",  emcap(cap(15)), emcap(band(15,40))),
   ("D  Prem/EM<=2% both legs only", emcap(cap(10**9)), emcap(cap(10**9)))]
for pl,dd in PER:
    if not dd: continue
    print(f"\n  PERIOD {pl}  ({len(dd)} days)"); print(H)
    for lab,sc,sp in V: print(row(lab,dd,sc,sp))

print("\n\n"+"="*W); print("  P.  PE BAND SWEEP  (CE fixed at prem<=15)  -  tested separately per period"); print("="*W)
BANDS=[(10,15),(15,20),(15,25),(15,30),(15,40),(20,40),(20,50),(25,50)]
for pl,dd in PER:
    if not dd: continue
    print(f"\n  PERIOD {pl}  ({len(dd)} days)"); print(H)
    print(row("PE <=15  (baseline)",dd,cap(15),cap(15)))
    for a,b in BANDS: print(row(f"PE {a}-{b}",dd,cap(15),band(a,b)))

print("\n\n"+"="*W); print("  Q.  ADAPTIVE PE  -  PE band chosen by market condition, known at 05:30"); print("="*W)
FE=features.build()
def adaptive(hi_band,lo_band,key,thr):
    def f(c,S,d):
        v=FE.get(d["date"],{}).get(key) if key!="iv" else d.get("atmiv")
        b=hi_band if (v is not None and v>thr) else lo_band
        return band(*b)(c,S,d)
    return f
import statistics as st
ivs=[d["atmiv"] for d in days if d.get("atmiv")]; ivmed=st.median(ivs)
atr=[FE.get(d["date"],{}).get("atr_pct") for d in days if FE.get(d["date"],{}).get("atr_pct")]
atrmed=st.median(atr)
for pl,dd in PER:
    if not dd: continue
    print(f"\n  PERIOD {pl}  ({len(dd)} days)"); print(H)
    print(row("PE 15-40 fixed",dd,cap(15),band(15,40)))
    print(row(f"PE wide(15-40) if IV>{ivmed:.0%} else 15-20",dd,cap(15),adaptive((15,40),(15,20),"iv",ivmed)))
    print(row(f"PE wide(15-40) if IV<{ivmed:.0%} else 15-20",dd,cap(15),adaptive((15,20),(15,40),"iv",ivmed)))
    print(row(f"PE wide(15-40) if ATR%>med else 15-20",dd,cap(15),adaptive((15,40),(15,20),"atr_pct",atrmed)))
    print(row(f"PE wide(15-40) if ATR%<med else 15-20",dd,cap(15),adaptive((15,20),(15,40),"atr_pct",atrmed)))
