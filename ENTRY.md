How every method works
Read the perp's closed candles on the timeframe.
With the chain: entry on 5m; 4H, 1H, 30m and 15m must not point against the trade; then a 3m confirmation candle and a 1m execution check against the perp's live last trade.
The method's own trigger says long or short, which steps have happened, the entry zone, and a structural stop level.
The plan:
Entry: the zone is at most 0.5 ATR wide, and the fill is the edge price reaches first (top of the zone for a long, bottom for a short).
SL: the method's structural level plus a 0.25 ATR buffer.
TGT1: the nearest real level (of the method's preferred kind) between 1R and 2R from the fill; if there is none, 1.5R.
TGT2: the next level at least 0.5 ATR past TGT1, from the method's pool (e.g. a 1H/4H swing).
TGT3: the expected-move edge, or the method's own level (e.g. max pain).
Hard gates:
Locked on: Data fresh, and the new Plan valid.
Switchable: Spread, Perp at mark, Stop 0.3–2.5 ATR, R:R ≥ 1, HTF (chain only), Big move, Expected move, Settlement, and the method's own gate.
Result: any gate fails → NO TRADE; any step missing → WAIT; otherwise TRADE.
Paper log:
Fill: a limit at the zone edge, within 12 bars.
Exits: if one candle hits both stop and target, the stop counts. TGT1 exits the trade; the rest runs to TGT2/TGT3 with the stop at breakeven, until a 48-bar timeout.
No orders: nothing is traded.
Two entry styles:

At the close (74 methods): enter on the signal candle's close.
At a level (7 methods: #2–#7, #11): wait for price to pull back to the level.
All 81: entry, SL, TGT1 / TGT2
#	Method	Entry	SL (+0.25 ATR)	TGT1 / TGT2
1	Breakout	close	breakout candle's far end	swing / 1H-4H swing
2	Breakout + retest	level	retest extreme	swing / 1H-4H swing
3	Liquidity sweep	level	sweep extreme	nearest / 1H-4H swing
4	FVG retest	level	displacement origin	swing / next
5	Order-block retest	level	block's far edge	swing / 1H-4H swing
6	BOS	level	last HL / LH	swing / 1H-4H swing
7	MSS / CHoCH	level	post-sweep extreme	nearest / 1H-4H swing
8	Momentum	close	momentum candle's far end	nearest / next
9	Pullback	close	pullback extreme	swing / 1H-4H swing
10	VWAP mean reversion	close	2σ reversal extreme	VWAP / VWAP ±1σ
11	Order flow	level	absorption extreme	book wall / book wall
12	Options / derivatives	close	OI wall / rejection extreme	OI wall / OI wall (TGT3 max pain)
13	Compression break	close	box's far side	nearest / next (box projection)
14	Failed breakout (trap)	close	trap extreme	range middle / range edge
15	Opening-range breakout	close	range middle	nearest / next (OR projection)
16	Prev-day H/L rejection	close	sweep extreme	nearest / 1H-4H swing
17	Prev-day break & hold	close	retest extreme	nearest / 1H-4H swing
18	Prev-day range expansion	close	extreme bar's far end	nearest / 1H-4H swing
19	VWAP reclaim / loss	close	VWAP retest extreme	nearest / next
20	Anchored VWAP (week)	close	touch extreme	nearest / next
21	Value-area break	close	back inside value area	nearest / next
22	POC reclaim / loss	close	hold extreme	nearest / next
23	CVD divergence	close	divergent swing	nearest / next
24	Delta divergence	close	weak-delta extreme	nearest / next
25	Exhaustion reversal	close	climax bar's extreme	nearest / next
26	Equal H/L sweep	close	sweep extreme	nearest / 1H-4H swing
27	Session H/L sweep	close	sweep extreme	nearest / next
28	Funding + price divergence	close	new extreme	nearest / next
29	OI-confirmed breakout	close	break bar's far end	nearest / 1H-4H swing
30	OI flush reversal	close	turn extreme	nearest / next
31	Expected-move edge	close	edge touch extreme	own / next
32	Volatility regime transition	close	break bar's far end	nearest / next
33	Z-score reversion	close	stretch extreme	own / next
34	Multi-factor regime	close	break bar's far end	nearest / 1H-4H swing
35	Mid-range rejection	close	rejection extreme	own / next
36	Trendline break & retest	close	retest extreme	nearest / 1H-4H swing
37	Channel breakout	close	break bar's far end	nearest / next
38	Engulfing + structure	close	engulfing extreme	nearest / 1H-4H swing
39	NR7 / inside-bar break	close	narrow bar's far side	nearest / next
40	Dislocation reversion	close	turn extreme	own / next
41	Basis divergence (perp vs index)	close	turn extreme	own / next
42	Index leads, perp lags	close	four-bar extreme	nearest / next
43	Mark-perp divergence	close	turn extreme	own / next
44	Forced-flow (liquidation proxy)	close	break bar's far end	nearest / next
45	OI wall break & retest	close	retest extreme	nearest / OI wall
46	Funding flip	close	break bar's far end	nearest / next
47	IV expansion breakout	close	break bar's far end	nearest / next
48	IV crush reversion	close	stretch extreme	own / next
49	Options skew divergence	close	turn extreme	nearest / next
50	Gamma wall reaction	close	touch extreme	nearest / next
51	Expiry pin / max pain	close	turn extreme	own / next
52	Book imbalance breakout	close	break bar's far end	nearest / next
53	Microprice imbalance	close	bar's far end	nearest / next
54	Liquidity replenishment	close	past the wall	nearest / next
55	Pulled wall (spoof)	close	bar's far end	nearest / next
56	Big-print follow-through	close	print bar's far end	nearest / next
57	Aggression spike	close	spike's far end	nearest / next
58	CVD regime shift	close	six-bar extreme	nearest / next
59	Footprint stack: continuation	close	stack's far side	nearest / next
60	Footprint stack: reversal	close	bar's extreme	nearest / next
61	Naked POC reaction	close	touch extreme	nearest / next
62	Initial balance break	close	IB middle	nearest / next (IB projection)
63	IB failed break	close	failed-break extreme	IB middle / next
64	Prev-week H/L sweep	close	sweep extreme	nearest / 1H-4H swing
65	Prev-month H/L sweep	close	sweep extreme	nearest / 1H-4H swing
66	Weekly range expansion	close	extreme bar's far end	nearest / 1H-4H swing
67	Monthly range expansion	close	extreme bar's far end	nearest / 1H-4H swing
68	Prev-week break-reclaim	close	failed-break extreme	nearest / 1H-4H swing
69	Prev-month break-reclaim	close	failed-break extreme	nearest / 1H-4H swing
70	Option volume one-sided	close	break bar's far end	nearest / next
71	Call/put OI divergence	close	turn extreme	nearest / next
72	IV vs realised vol	close	bar's far end	nearest / next
73	Term-structure inversion	close	break bar's far end	nearest / next
74	Expiry OI migration	close	break bar's far end	nearest / next
75	Volatility z-spike	close	break bar's far end	nearest / next
76	Volume z-spike	close	bar's far end	nearest / next
77	Autocorrelation regime	close	bar's far end / stretch extreme	nearest / next
78	Range-efficiency entry	close	pullback extreme	nearest / 1H-4H swing
79	Trend-efficiency break	close	six-bar extreme	nearest / 1H-4H swing
80	BTC–ETH correlation break	close	break bar's far end	nearest / next
81	BTC vs ETH divergence	close	new extreme	nearest / next