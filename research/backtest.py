#!/usr/bin/env python3
"""Short-straddle backtest on Delta Exchange INDIA daily-expiry BTC options.
Replicates the AlgoTest 'BTC_CE' strategy:
  Entry 05:30 IST, Exit 17:29 IST (expiry 17:30 IST)
  Sell 1 Call + 1 Put, strike chosen by 'Premium <= X', 10 lots each
  No SL / no target.  Slippage applied on entry and exit.
Prices from Delta are quoted in USD per 1 BTC; contract size = 0.001 BTC.
"""
import json,urllib.request,urllib.error,datetime,time,sys,threading
import concurrent.futures as cf

IN="https://api.india.delta.exchange"
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
LOTS=10; CONTRACT=0.001; PREMIUM_CAP=15.0; SLIPPAGE=0.05
_lock=threading.Semaphore(8)          # throttle: max 8 in flight

def api(path,tries=4):
    for i in range(tries):
        try:
            with _lock:
                with urllib.request.urlopen(IN+path,timeout=30) as r:
                    return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429,502,503,504): time.sleep(1.5*(i+1)); continue
            return None
        except Exception:
            time.sleep(1.0*(i+1))
    return None

def product_exists(sym):
    d=api(f"/v2/products/{sym}")
    return bool(d and d.get('result'))

def series(sym,day):
    """1-minute bars for `day` (UTC day == 05:30 IST -> 05:30 IST next)."""
    s=int(datetime.datetime.combine(day,datetime.time(0,0),datetime.timezone.utc).timestamp())
    d=api(f"/v2/history/candles?resolution=1m&symbol={sym}&start={s}&end={s+86400}")
    if not d: return []
    return [c for c in (d.get('result') or []) if c['close']>0]

def price_at(bars,day,hh,mm,tol=900):
    if not bars: return None
    t=datetime.datetime(day.year,day.month,day.day,hh,mm,tzinfo=IST).timestamp()
    c=min(bars,key=lambda c:abs(c['time']-t))
    return c['close'] if abs(c['time']-t)<=tol else None

def spot_at(day,hh,mm):
    s=int(datetime.datetime.combine(day,datetime.time(0,0),datetime.timezone.utc).timestamp())
    d=api(f"/v2/history/candles?resolution=1m&symbol=BTCUSD&start={s}&end={s+86400}")
    if not d: return None
    return price_at([c for c in (d.get('result') or []) if c['close']>0],day,hh,mm)

def chain(day,sp):
    """Candidate symbols for the daily expiry on `day` (validated later by bars)."""
    tag=f"{day.day:02d}{day.month:02d}{str(day.year)[2:]}"
    lo=int(sp*0.82//1000*1000); hi=int(sp*1.22)
    ks=list(range(lo,hi+1,1000))
    return [f"{cp}-BTC-{k}-{tag}" for k in ks for cp in ("C","P")]

def run_day(day):
    """Return one result dict for the expiry on `day`."""
    r={"date":day.isoformat(),"status":None,"spot":None,"call":None,"put":None,
       "entry":0.0,"exit":0.0,"pnl_usd":0.0,"cheapest":None,"n_strikes":0,
       "cheap_c":None,"cheap_p":None}
    sp=spot_at(day,5,30)
    if sp is None: r["status"]="no_spot"; return r
    r["spot"]=round(sp,1)
    syms=chain(day,sp)

    if not syms: r["status"]="no_chain"; return r

    cut=datetime.datetime(day.year,day.month,day.day,17,30,tzinfo=IST).timestamp()
    quotes={}
    with cf.ThreadPoolExecutor(8) as p:
        for s,bars in zip(syms,p.map(lambda s:series(s,day),syms)):
            pre=[c for c in bars if c['time']<cut-60]
            if len(pre)<30: continue                 # settlement stub / not traded
            e=price_at(pre,day,5,30); x=price_at(pre,day,17,29)
            if e is not None: quotes[s]=(e,x)
    if not quotes: r["status"]="no_quotes"; return r
    r["n_strikes"]=len(quotes)
    r["cheapest"]=round(min(v[0] for v in quotes.values()),2)

    def pick(cp):
        el={s:v for s,v in quotes.items() if s.startswith(cp+"-") and v[0]<=PREMIUM_CAP}
        if not el: return None
        return max(el.items(),key=lambda kv:kv[1][0])      # richest premium <= cap

    cmin=min([v[0] for k,v in quotes.items() if k.startswith("C-")],default=None)
    pmin=min([v[0] for k,v in quotes.items() if k.startswith("P-")],default=None)
    r["cheap_c"]=None if cmin is None else round(cmin,2)
    r["cheap_p"]=None if pmin is None else round(pmin,2)
    c=pick("C"); p_=pick("P")
    if not c or not p_:
        r["status"]="no_fill_C" if not c and p_ else ("no_fill_P" if c else "no_fill_both")
        return r

    total=0.0
    for leg in (c,p_):
        sym,(entry,exitp)=leg
        if exitp is None: exitp=0.0                        # expired worthless
        sell=entry*(1-SLIPPAGE)                            # sell fills worse
        buy =exitp*(1+SLIPPAGE)                            # buy-back fills worse
        total += (sell-buy)*LOTS*CONTRACT
    r["call"]=f"{c[0]} @{c[1][0]:.2f}->{(c[1][1] or 0):.2f}"
    r["put"] =f"{p_[0]} @{p_[1][0]:.2f}->{(p_[1][1] or 0):.2f}"
    r["entry"]=round(c[1][0]+p_[1][0],2)
    r["exit"] =round((c[1][1] or 0)+(p_[1][1] or 0),2)
    r["pnl_usd"]=round(total,4); r["status"]="TRADED"
    return r

def backtest(start,end,label):
    days=[]; d=start
    while d<=end: days.append(d); d+=datetime.timedelta(days=1)
    print(f"\n{'='*74}\n{label}   {start} -> {end}   ({len(days)} days)\n{'='*74}")
    print(f"{'date':11s} {'status':20s} {'spot':>8s} {'liq':>4s} {'cheapC':>8s} {'cheapP':>8s} {'pnl$':>9s}")
    res=[]
    for day in days:
        r=run_day(day); res.append(r)
        print(f"{r['date']:11s} {r['status']:20s} {str(r['spot'] or '-'):>8s} "
              f"{r['n_strikes']:>4d} {str(r['cheap_c'] or '-'):>8s} {str(r['cheap_p'] or '-'):>8s} "
              f"{r['pnl_usd']:>9.4f}",flush=True)
    t=[r for r in res if r['status']=='TRADED']
    tot=sum(r['pnl_usd'] for r in t)
    print(f"\n  days scanned      : {len(res)}")
    print(f"  days TRADED       : {len(t)}")
    for st in sorted({r['status'] for r in res}):
        if st!='TRADED': print(f"  days {st:18s}: {sum(1 for r in res if r['status']==st)}")
    if t:
        w=sum(1 for r in t if r['pnl_usd']>0)
        print(f"  win rate          : {w}/{len(t)} = {100*w/len(t):.1f}%")
        print(f"  TOTAL PnL         : ${tot:.2f}   (= INR {tot*85:.0f} @85)")
    else:
        print(f"  TOTAL PnL         : no trades")
    return res

if __name__=="__main__":
    a=sys.argv[1:]
    s=datetime.date.fromisoformat(a[0]); e=datetime.date.fromisoformat(a[1])
    backtest(s,e,a[2] if len(a)>2 else "BACKTEST")
