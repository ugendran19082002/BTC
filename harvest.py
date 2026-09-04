#!/usr/bin/env python3
"""Harvest Delta India daily-expiry BTC option chains, one JSON per day.
Stored per symbol: entry(05:30), exit(17:29), and a 15-min close path,
so every strike-selection / exit / SL variant can be evaluated offline."""
import json,os,sys,urllib.request,datetime,time,math
import concurrent.futures as cf

IN="https://api.india.delta.exchange"
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
CACHE=os.path.join(os.path.dirname(os.path.abspath(__file__)),"cache")

def api(p,tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(IN+p,timeout=30) as r: return json.load(r)
        except Exception: time.sleep(0.8*(i+1))
    return None

def day_bounds(day):
    s=int(datetime.datetime.combine(day,datetime.time(0,0),datetime.timezone.utc).timestamp())
    return s,s+86400

def bars(sym,day):
    s,e=day_bounds(day)
    d=api(f"/v2/history/candles?resolution=1m&symbol={sym}&start={s}&end={e}")
    return [c for c in ((d or {}).get('result') or []) if c['close']>0]

def series15(sym,day):
    s,e=day_bounds(day)
    d=api(f"/v2/history/candles?resolution=15m&symbol={sym}&start={s}&end={e}")
    return [[c['time'],c['close']] for c in sorted(((d or {}).get('result') or []),key=lambda c:c['time'])]

def pick(bs,day,hh,mm,tol=900):
    if not bs: return None
    t=datetime.datetime(day.year,day.month,day.day,hh,mm,tzinfo=IST).timestamp()
    c=min(bs,key=lambda c:abs(c['time']-t))
    return c['close'] if abs(c['time']-t)<=tol else None

def harvest(day):
    f=os.path.join(CACHE,f"{day.isoformat()}.json")
    if os.path.exists(f):
        try:
            if json.load(open(f)).get("v")==2: return "cached"
        except Exception: pass
    sb=bars("BTCUSD",day)
    spot=pick(sb,day,5,30)
    if spot is None:
        json.dump({"v":2,"date":day.isoformat(),"spot":None,"syms":{}},open(f,"w")); return "no_spot"
    # underlying path (15m) for trend / expected-move filters
    cut=datetime.datetime(day.year,day.month,day.day,17,30,tzinfo=IST).timestamp()
    spath=[[c['time'],c['close']] for c in sorted(sb,key=lambda c:c['time'])
           if c['time']<cut and (c['time']%900==0)]
    tag=f"{day.day:02d}{day.month:02d}{str(day.year)[2:]}"
    lo=int(spot*0.80//1000*1000); hi=int(spot*1.25)
    syms=[f"{cp}-BTC-{k}-{tag}" for k in range(lo,hi+1,1000) for cp in ("C","P")]
    out={}
    def one(s):
        bs=[c for c in bars(s,day) if c['time']<cut-60]
        if len(bs)<30: return s,None
        e=pick(bs,day,5,30); x=pick(bs,day,17,29)
        if e is None: return s,None
        bs.sort(key=lambda c:c['time'])
        path=[[c['time'],c['close']] for c in bs if c['time']%300==0]     # 5-min path from 1m bars
        hi_=max(c['high'] for c in bs); lo_=min(c['low'] for c in bs)
        rec={"entry":e,"exit":x,"hi":hi_,"lo":lo_,"path":path,
             "vol":sum(c.get('volume') or 0 for c in bs),"nbars":len(bs)}
        if e<=200:                                   # tradeable universe -> enrich
            mk=[q for q in series15("MARK:"+s,day) if q[0]<cut]
            oi=[q for q in series15("OI:"+s,day)   if q[0]<cut]
            rec["mark_open"]=mk[0][1] if mk else None
            rec["mark_close"]=mk[-1][1] if mk else None
            rec["oi_open"]=oi[0][1] if oi else None
            rec["oi_max"]=max((q[1] for q in oi),default=None)
        return s,rec
    with cf.ThreadPoolExecutor(8) as p:
        for s,v in p.map(one,syms):
            if v: out[s]=v
    json.dump({"v":2,"date":day.isoformat(),"spot":spot,"spath":spath,"syms":out},open(f,"w"))
    return f"{len(out)} syms"

if __name__=="__main__":
    a=datetime.date.fromisoformat(sys.argv[1]); b=datetime.date.fromisoformat(sys.argv[2])
    d=a; n=0; t0=time.time()
    while d<=b:
        r=harvest(d); n+=1
        el=time.time()-t0; tot=(b-a).days+1
        print(f"{d} {r:>12s}   [{n}/{tot}]  {el/n:.1f}s/day  ETA {(tot-n)*el/n/60:.0f}m",flush=True)
        d+=datetime.timedelta(days=1)
    print("HARVEST DONE")
