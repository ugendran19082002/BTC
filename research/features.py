#!/usr/bin/env python3
"""Daily BTCUSD technical features for the short-premium study.
Every value for day D is computed from data up to and including D-1 close,
so it is known at the 05:30 entry on day D.  No lookahead."""
import json,urllib.request,datetime,math,os,time
IN="https://api.india.delta.exchange"
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30))
F=os.path.join(os.path.dirname(os.path.abspath(__file__)),"btc_daily.json")

def fetch(a="2023-12-29",b="2026-09-04"):
    if os.path.exists(F): return json.load(open(F))
    s=int(datetime.datetime.fromisoformat(a).replace(tzinfo=datetime.timezone.utc).timestamp())
    e=int(datetime.datetime.fromisoformat(b).replace(tzinfo=datetime.timezone.utc).timestamp())
    rows=[]
    cur=s
    while cur<e:
        nxt=min(cur+86400*300,e)
        for _ in range(4):
            try:
                with urllib.request.urlopen(f"{IN}/v2/history/candles?resolution=1d&symbol=BTCUSD&start={cur}&end={nxt}",timeout=30) as r:
                    rows+= [c for c in (json.load(r).get('result') or []) if c['close']>0]; break
            except Exception: time.sleep(1)
        cur=nxt
    seen={}
    for c in rows: seen[c['time']]=c
    out=[seen[k] for k in sorted(seen)]
    for c in out: c['date']=datetime.datetime.fromtimestamp(c['time'],IST).date().isoformat()
    json.dump(out,open(F,'w')); return out

def ema(v,n):
    k=2/(n+1); out=[]; e=None
    for x in v:
        e=x if e is None else x*k+e*(1-k); out.append(e)
    return out
def sma(v,n): return [None if i<n-1 else sum(v[i-n+1:i+1])/n for i in range(len(v))]

def rsi(cl,n=14):
    out=[None]*len(cl); g=l=0.0
    for i in range(1,len(cl)):
        d=cl[i]-cl[i-1]; up=max(d,0); dn=max(-d,0)
        if i<=n: g+=up; l+=dn
        if i==n: g/=n; l/=n; out[i]=100-100/(1+(g/l if l else 999))
        elif i>n:
            g=(g*(n-1)+up)/n; l=(l*(n-1)+dn)/n
            out[i]=100-100/(1+(g/l if l else 999))
    return out

def atr(h,lo,c,n=14):
    tr=[None]+[max(h[i]-lo[i],abs(h[i]-c[i-1]),abs(lo[i]-c[i-1])) for i in range(1,len(c))]
    out=[None]*len(c); a=None
    for i in range(1,len(c)):
        a=tr[i] if a is None else (a*(n-1)+tr[i])/n
        if i>=n: out[i]=a
    return out

def adx(h,lo,c,n=14):
    n_=len(c); out=[None]*n_
    if n_<2*n: return out
    tr=[0.0]*n_; pdm=[0.0]*n_; ndm=[0.0]*n_
    for i in range(1,n_):
        up=h[i]-h[i-1]; dn=lo[i-1]-lo[i]
        pdm[i]=up if (up>dn and up>0) else 0.0
        ndm[i]=dn if (dn>up and dn>0) else 0.0
        tr[i]=max(h[i]-lo[i],abs(h[i]-c[i-1]),abs(lo[i]-c[i-1]))
    def wil(x):
        o=[None]*n_; s=sum(x[1:n+1]); o[n]=s
        for i in range(n+1,n_): s=s-s/n+x[i]; o[i]=s
        return o
    TR,P,N=wil(tr),wil(pdm),wil(ndm)
    dx=[None]*n_
    for i in range(n,n_):
        if not TR[i]: continue
        pdi=100*P[i]/TR[i]; ndi=100*N[i]/TR[i]
        dx[i]=100*abs(pdi-ndi)/(pdi+ndi) if (pdi+ndi) else 0.0
    vals=[d for d in dx if d is not None]
    if len(vals)>=n:
        a=sum(vals[:n])/n; idx=[i for i,d in enumerate(dx) if d is not None]
        out[idx[n-1]]=a
        for j in range(n,len(idx)):
            i=idx[j]; a=(a*(n-1)+dx[i])/n; out[i]=a
    return out

def build():
    rows=fetch()
    c=[r['close'] for r in rows]; h=[r['high'] for r in rows]; l=[r['low'] for r in rows]
    e12,e26=ema(c,12),ema(c,26)
    macd=[e12[i]-e26[i] for i in range(len(c))]; sig=ema(macd,9)
    e20,e50=ema(c,20),ema(c,50); s20=sma(c,20)
    R=rsi(c); A=atr(h,l,c); D=adx(h,l,c)
    sd20=[None if i<19 else (sum((c[j]-s20[i])**2 for j in range(i-19,i+1))/20)**0.5 for i in range(len(c))]
    feats={}
    for i,r in enumerate(rows):
        if i<60: continue
        rets=[math.log(c[j]/c[j-1]) for j in range(i-19,i+1)]
        rv20=(sum(x*x for x in rets)/20)**0.5*math.sqrt(365)
        rets10=[math.log(c[j]/c[j-1]) for j in range(i-9,i+1)]
        rv10=(sum(x*x for x in rets10)/10)**0.5*math.sqrt(365)
        nxt=rows[i+1]['date'] if i+1<len(rows) else None
        if not nxt: continue
        feats[nxt]={                       # features for NEXT day, from today's close
            "close":c[i],"rsi":R[i],"macd":macd[i],"macd_hist":macd[i]-sig[i],
            "atr":A[i],"atr_pct":(A[i]/c[i] if A[i] else None),"adx":D[i],
            "ema20":e20[i],"ema50":e50[i],"above_ema20":c[i]>e20[i],"above_ema50":c[i]>e50[i],
            "ema20_gt_50":e20[i]>e50[i],
            "bb_width":(4*sd20[i]/c[i] if sd20[i] else None),
            "rv10":rv10,"rv20":rv20,
            "ret1":(c[i]-c[i-1])/c[i-1],"ret3":(c[i]-c[i-3])/c[i-3],
            "dow":datetime.date.fromisoformat(nxt).weekday()}
    return feats

if __name__=="__main__":
    f=build(); ks=sorted(f)
    print(f"features for {len(f)} days: {ks[0]} -> {ks[-1]}")
    k=ks[len(ks)//2]
    for a,b in f[k].items(): print(f"  {a:14s} {b}")
