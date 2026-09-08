#!/usr/bin/env python3
"""AlgoTest-style backtest report.
All prices are 1-MINUTE CANDLE CLOSES from Delta India:
   entry = close of the 05:30 IST 1m candle
   exit  = close of the 17:29 IST 1m candle (expiry settles 17:30 IST)
PnL = (entry*(1-slip) - exit*(1+slip)) * lots * 0.001 BTC, shown in INR at 85."""
import analyze as A, features, math, datetime

days=A.add_context(A.load()); T=A.T_YEARS
MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

def em(d):
    iv=d.get("atmiv")
    return None if not iv else d["spot"]*iv*math.sqrt(T)
def cap(n):   return lambda c,S,d: max([x for x in c if x["entry"]<=n],key=lambda x:x["entry"],default=None)
def band(a,b):return lambda c,S,d: max([x for x in c if a<=x["entry"]<=b],key=lambda x:x["entry"],default=None)
def emcap(sel,k=0.020):
    def f(c,S,d):
        E=em(d)
        if not E: return None
        return sel([x for x in c if x["entry"]/E<=k],S,d)
    return f

def tradebook(selC,selP):
    """one row per day: both legs, 1m closes, PnL in INR"""
    rows=[]
    for d in days:
        legs=[]; tot=0.0
        for cp,sel in (("C",selC),("P",selP)):
            c=d["legs"][cp]
            if not c: continue
            L=sel(c,d["spot"],d)
            if not L: continue
            ex=L["exit"]
            sell=L["entry"]*(1-A.SLIPPAGE); buy=ex*(1+A.SLIPPAGE)
            p=(sell-buy)*A.LOTS*A.LOT_SIZE
            legs.append((cp,L["sym"],L["entry"],ex,p)); tot+=p
        if legs: rows.append({"date":d["date"],"spot":d["spot"],"legs":legs,"pnl":tot*85})
    return rows

def yearwise(rows,title):
    """AlgoTest 'Year-wise Returns' table"""
    yr={}
    for r in rows:
        y=int(r["date"][:4]); m=int(r["date"][5:7])
        yr.setdefault(y,[0.0]*12)[m-1]+=r["pnl"]
    print(f"\n  YEAR-WISE RETURNS (INR)   -- {title}")
    print("  "+"-"*118)
    print(f"  {'Year':<6}"+"".join(f"{m:>8}" for m in MON)+f"{'Total':>10}{'MaxDD':>9}{'DaysMDD':>9}{'R/MDD':>8}")
    print("  "+"-"*118)
    for y in sorted(yr):
        mv=yr[y]; tot=sum(mv)
        yrows=[r for r in rows if r["date"].startswith(str(y))]
        dd,dmdd=drawdown(yrows)
        rm = f"{tot/abs(dd):.2f}" if dd<0 else "No DD"
        print(f"  {y:<6}"+"".join(f"{v:>8.0f}" for v in mv)+f"{tot:>10.0f}{dd:>9.0f}{dmdd:>9d}{rm:>8}")
    print("  "+"-"*118)

def drawdown(rows):
    cum=0.0; peak=0.0; dd=0.0; pk_i=0; worst=(0,0)
    for i,r in enumerate(rows):
        cum+=r["pnl"]
        if cum>peak: peak=cum; pk_i=i
        if cum-peak<dd: dd=cum-peak; worst=(pk_i,i)
    return dd,(worst[1]-worst[0])

def stats(rows,title):
    p=[r["pnl"] for r in rows]
    if not p: print("  no trades"); return
    w=[x for x in p if x>0]; l=[x for x in p if x<0]
    dd,dmdd=drawdown(rows)
    gp=sum(w); gl=-sum(l)
    print(f"\n  OVERALL  -- {title}")
    print(f"    Period                 : {rows[0]['date']}  ->  {rows[-1]['date']}")
    print(f"    Total trading days     : {len(p)}")
    print(f"    Total Profit           : INR {sum(p):,.0f}")
    print(f"    Average Profit / day   : INR {sum(p)/len(p):,.1f}")
    print(f"    Win days / Loss days   : {len(w)} / {len(l)}   ({100*len(w)/len(p):.1f}% win)")
    print(f"    Average Profit on win  : INR {(gp/len(w) if w else 0):,.1f}")
    print(f"    Average Loss on loss   : INR {(-gl/len(l) if l else 0):,.1f}")
    print(f"    Max Profit (1 day)     : INR {max(p):,.0f}")
    print(f"    Max Loss   (1 day)     : INR {min(p):,.0f}")
    print(f"    Max Drawdown           : INR {dd:,.0f}   over {dmdd} days")
    print(f"    Return / MDD           : {(sum(p)/abs(dd)) if dd<0 else float('inf'):,.2f}")
    print(f"    Profit Factor          : {(gp/gl) if gl>0 else float('inf'):,.2f}")

STRATS=[("A. CURRENT   CE prem<=15 + PE prem<=15", cap(15), cap(15)),
        ("B. CE prem<=15 + PE prem 15-40",         cap(15), band(15,40)),
        ("C. B + Premium/ExpectedMove <= 0.020",   emcap(cap(15)), emcap(band(15,40)))]

W=122
print("="*W)
print("  ALGO BACKTEST REPORT  -  Delta Exchange India  -  BTCUSD daily-expiry short strangle")
print("="*W)
print("  Index            : BTCUSD (Delta India)        Strategy type : Intraday")
print("  Entry Time       : 05:30 IST                   Exit Time     : 17:29 IST")
print("  Expiry           : Today (settles 17:30 IST = 12:00 UTC)")
print("  Positions        : SELL 1 Call + SELL 1 Put    Lots          : 10 per leg")
print("  Lot size         : 0.001 BTC                   Slippage      : 5%")
print("  Stop Loss        : None                        Target        : None")
print("  Price source     : 1-MINUTE CANDLE CLOSE (Delta India /v2/history/candles resolution=1m)")
print("  Brokerage        : NOT included                FX            : 1 USD = 85 INR")
print("="*W)

books={}
for name,sc,sp in STRATS:
    rows=tradebook(sc,sp); books[name]=rows
    print(f"\n\n{'='*W}\n  {name}\n{'='*W}")
    yearwise(rows,name); stats(rows,name)

# ---- full daily tradebook for the current strategy ----
name,rows=STRATS[0][0],books[STRATS[0][0]]
print(f"\n\n{'='*W}\n  DAY-BY-DAY TRADEBOOK  -  {name}\n  (entry/exit are 1-minute candle CLOSE prices, USD per BTC)\n{'='*W}")
print(f"  {'Date':<12}{'Spot':>9}  {'Leg':<3}{'Symbol':<22}{'Entry':>9}{'Exit':>9}{'PnL INR':>10}   {'Day INR':>9}  {'Cum INR':>9}")
cum=0.0
for r in rows:
    cum+=r["pnl"]
    for i,(cp,sym,e,x,p) in enumerate(r["legs"]):
        d=f"{r['date']:<12}{r['spot']:>9.0f}" if i==0 else " "*21
        tail=f"   {r['pnl']:>9.1f}  {cum:>9.1f}" if i==len(r["legs"])-1 else ""
        print(f"  {d}  {'CE' if cp=='C' else 'PE':<3}{sym:<22}{e:>9.2f}{x:>9.2f}{p*85:>10.1f}{tail}")
