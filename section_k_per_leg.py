import analyze as A
all_=A.add_context(A.load())
def seg(a,b): return [d for d in all_ if a<=d["date"]<=b]
PER=[("2024",seg("2024-01-01","2024-12-31")),("2025",seg("2025-01-01","2025-12-31")),
     ("2026",seg("2026-01-01","2026-12-31")),("ALL",all_)]
RULES=["prem<=15 [BASELINE]","prem 15-40","prem<=40","prem<=100","prem 40-100","rich OTM>=3% +liq"]
W=100
print("\n"+"#"*W)
print("#  K.  PER-LEG OPTIMISATION  -  should CE and PE use the SAME strike rule?")
print("#  (exit: hold to 17:29 | 10 lots | slippage 5% | 1 USD = 85 INR)")
print("#"*W)
for side,nm in (("C","K1.  CE  (Call leg only)"),("P","K2.  PE  (Put leg only)")):
    print(f"\n### {nm}")
    print(f"  {'rule':22s} {'period':7s} {'trds':>5s} {'win%':>7s} {'INR':>8s} {'avg':>7s} {'maxloss':>9s} {'PF':>9s} {'maxDD':>8s}")
    for r in RULES:
        for lab,dd in PER:
            if not dd: continue
            _,ce,pe,_=A.run(dd,r,"hold to 17:29",side=side)
            m=A.metrics(ce if side=="C" else pe)
            if not m: continue
            pf="inf" if m['pf']==float('inf') else f"{m['pf']:.2f}"
            print(f"  {r:22s} {lab:7s} {m['n']:>5d} {m['win%']:>6.1f}% {m['total']*85:>8.0f} "
                  f"{m['avg']*85:>7.1f} {m['maxloss']*85:>9.0f} {pf:>9s} {m['maxdd']*85:>8.0f}")
        print()

# ---- K3: real day-level mixed backtest (NOT a sum of leg totals) ----
def mixed(days,ce_rule,pe_rule):
    selC=A.SELECTORS[ce_rule]; selP=A.SELECTORS[pe_rule]; out=[]
    for d in days:
        tot=0.0; got=False
        for cp,sel in (("C",selC),("P",selP)):
            c=d["legs"][cp]
            if not c: continue
            leg=sel(c,d["spot"])
            if not leg: continue
            p,_=A.pnl(leg,A.EXITS["hold to 17:29"]); tot+=p; got=True
        if got: out.append(tot)
    return out

print("### K3.  MIXED STRATEGY, combined day by day (correct drawdown, not a sum of legs)")
print(f"  {'strategy':38s} {'period':7s} {'days':>5s} {'win%':>7s} {'INR':>8s} {'maxloss':>9s} {'PF':>9s} {'maxDD':>8s}")
COMBOS=[("CE prem<=15  +  PE prem<=15   (current)","prem<=15 [BASELINE]","prem<=15 [BASELINE]"),
        ("CE prem<=15  +  PE prem 15-40","prem<=15 [BASELINE]","prem 15-40"),
        ("CE prem<=15  +  PE prem<=40","prem<=15 [BASELINE]","prem<=40"),
        ("CE prem<=40  +  PE prem<=40","prem<=40","prem<=40")]
for nm,cr,pr in COMBOS:
    for lab,dd in PER:
        if not dd: continue
        m=A.metrics(mixed(dd,cr,pr))
        if not m: continue
        pf="inf" if m['pf']==float('inf') else f"{m['pf']:.2f}"
        print(f"  {nm:38s} {lab:7s} {m['n']:>5d} {m['win%']:>6.1f}% {m['total']*85:>8.0f} "
              f"{m['maxloss']*85:>9.0f} {pf:>9s} {m['maxdd']*85:>8.0f}")
    print()
print("""  READING THIS TABLE
    CE and PE do NOT want the same strike rule.
      - CE: prem<=15 is positive in all three periods and never had a real loss.
            Widening CE to prem 15-40 loses INR 2,038 in 2024 (PF 0.28).
      - PE: prem 15-40 is positive in all three periods (+621 / +3,488 / +1,276),
            PF 4.75, worst day only -INR 477.
    Switching ONLY the PE leg roughly doubles total PnL without adding lots,
    and the worst day gets smaller, not bigger.

  CAVEAT
    ~19 strike rules x 2 legs x 3 periods were searched. With that many
    comparisons some rule will look good by chance. The PE result is
    consistent across all three periods, which is encouraging but not proof.
    Brokerage is still excluded. Size down before trusting this live.""")
