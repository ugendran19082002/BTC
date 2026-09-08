#!/usr/bin/env python3
"""FINAL STACKED STRATEGY
   CE premium <= 15
   PE premium 15-40
   Premium / ExpectedMove <= 0.020
   PCR > median
   exit at 70% premium decay
Built up one component at a time so each one's contribution is visible."""
import analyze as A, features, math, statistics as st

days=A.add_context(A.load()); FE=features.build(); T=A.T_YEARS
def seg(a,b): return [d for d in days if a<=d["date"]<=b]
PER=[("2024",seg("2024-01-01","2024-12-31")),("2025",seg("2025-01-01","2025-12-31")),
     ("2026",seg("2026-01-01","2026-12-31")),("ALL",days)]

def em(d):
    iv=d.get("atmiv")
    return None if not iv else d["spot"]*iv*math.sqrt(T)
def pcr(d):
    co=sum(x["oi"] or 0 for x in d["legs"]["C"]); po=sum(x["oi"] or 0 for x in d["legs"]["P"])
    return (po/co) if co>0 else None

# ---- PCR thresholds: in-sample median vs EXPANDING median (no lookahead) ----
PCR={d["date"]:pcr(d) for d in days}
allp=[v for v in PCR.values() if v]
FIXED_MED=st.median(allp)
EXP_MED={}; run=[]
for d in days:                       # days are date-sorted by load()
    v=PCR.get(d["date"])
    EXP_MED[d["date"]]=st.median(run) if len(run)>=30 else None
    if v: run.append(v)

# ---- leg selectors ----
def ce_rule(c,S,d):  return max([x for x in c if x["entry"]<=15],key=lambda x:x["entry"],default=None)
def pe_rule(c,S,d):  return max([x for x in c if 15<=x["entry"]<=40],key=lambda x:x["entry"],default=None)
def pe_base(c,S,d):  return max([x for x in c if x["entry"]<=15],key=lambda x:x["entry"],default=None)
def add_em_cap(sel,cap=0.020):
    def f(c,S,d):
        E=em(d)
        if not E: return None
        return sel([x for x in c if x["entry"]/E<=cap],S,d)
    return f

def run_stack(dd,selC,selP,exitfn,pcr_mode=None):
    out=[]; skipped=0
    for d in dd:
        if pcr_mode:
            v=PCR.get(d["date"])
            thr=FIXED_MED if pcr_mode=="fixed" else EXP_MED.get(d["date"])
            if v is None or thr is None or v<=thr: skipped+=1; continue
        tot=0.0; got=False
        for cp,sel in (("C",selC),("P",selP)):
            c=d["legs"][cp]
            if not c: continue
            leg=sel(c,d["spot"],d)
            if not leg: continue
            p,_=A.pnl(leg,exitfn); tot+=p; got=True
        if got: out.append(tot)
    return out,skipped

HOLD=A.EXITS["hold to 17:29"]; BOOK70=A.exit_book(0.70)
STEPS=[("0. baseline  CE<=15 + PE<=15, hold",        ce_rule, pe_base, HOLD,  None),
       ("1. + PE 15-40",                              ce_rule, pe_rule, HOLD,  None),
       ("2. + Premium/EM <= 0.020",     add_em_cap(ce_rule), add_em_cap(pe_rule), HOLD, None),
       ("3. + PCR > median (in-sample)",add_em_cap(ce_rule), add_em_cap(pe_rule), HOLD, "fixed"),
       ("4. + 70% decay exit  = FULL STACK", add_em_cap(ce_rule), add_em_cap(pe_rule), BOOK70, "fixed"),
       ("4b. FULL STACK, PCR expanding median (no lookahead)",
                                        add_em_cap(ce_rule), add_em_cap(pe_rule), BOOK70, "expanding")]

W=112
print("="*W)
print("FINAL STACKED STRATEGY  -  Delta India BTC daily expiry")
print("  CE premium<=15 | PE premium 15-40 | Premium/ExpectedMove<=0.020 | PCR>median | exit 70% decay")
print("  10 lots/leg | lot 0.001 BTC | slippage 5% | 1 USD = 85 INR | entry 05:30 IST")
print("="*W)
H=f"  {'step':52s} {'days':>5s} {'win%':>7s} {'INR':>8s} {'avg':>7s} {'maxloss':>9s} {'PF':>8s} {'maxDD':>8s}"

for pl,dd in PER:
    if not dd: continue
    print(f"\n\n### PERIOD {pl}   ({len(dd)} days  {dd[0]['date']} -> {dd[-1]['date']})")
    print(H)
    for lab,sc,sp,ef,pm in STEPS:
        v,sk=run_stack(dd,sc,sp,ef,pm)
        m=A.metrics(v)
        if not m: print(f"  {lab:52s}    no trades"); continue
        pf="inf" if m['pf']==float('inf') else f"{m['pf']:.2f}"
        print(f"  {lab:52s} {m['n']:>5d} {m['win%']:>6.1f}% {m['total']*85:>8.0f} "
              f"{m['avg']*85:>7.1f} {m['maxloss']*85:>9.0f} {pf:>8s} {m['maxdd']*85:>8.0f}")

# month by month for the full stack
print("\n\n### FULL STACK, MONTH BY MONTH (in-sample PCR median)")
selC=add_em_cap(ce_rule); selP=add_em_cap(pe_rule)
mon={}
for d in days:
    v=PCR.get(d["date"])
    if v is None or v<=FIXED_MED: continue
    tot=0.0; got=False
    for cp,sel in (("C",selC),("P",selP)):
        c=d["legs"][cp]
        if not c: continue
        leg=sel(c,d["spot"],d)
        if not leg: continue
        p,_=A.pnl(leg,BOOK70); tot+=p; got=True
    if got:
        k=d["date"][:7]; a=mon.setdefault(k,[0,0,0.0]); a[0]+=1
        if tot>0: a[1]+=1
        a[2]+=tot
print(f"  {'month':9s} {'days':>5s} {'wins':>5s} {'INR':>8s}")
cum=0
for k in sorted(mon):
    n,w,s=mon[k]; cum+=s*85
    print(f"  {k:9s} {n:>5d} {w:>5d} {s*85:>8.0f}   cum {cum:>8.0f}")
