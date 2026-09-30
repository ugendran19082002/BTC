# Strategy ideas

A map of trading strategy families worth researching, written in Tamil and
English (29 Sep 2026). A list of candidates, not findings: what has been tested
and what it showed is in [findings.md](findings.md), and SMC / ICT / CRT
variants have been tested and did not hold. Open research is in
[TODO.md](../TODO.md).

---

ஆம். நீ “CRT மாதிரி இருக்கும் strategies மட்டும் இல்லாமல், trading-ல் R&D செய்யக்கூடிய major strategy/model families எல்லாம்” கேட்கிறாய். Literally எல்லா strategy-யும் list பண்ணுவது முடியாது; ஆனால் practical-ஆ R&D universe-ஐ இப்படி map பண்ணலாம்.

CRT itself is commonly framed around a higher-timeframe candle range, one-side sweep/reclaim, and move toward the opposite side; related community frameworks explicitly connect it with liquidity sweeps, Turtle Soup, and Power of Three/AMD.

1. SMC / ICT / Liquidity Strategies
BOS Strategy
CHoCH Strategy
MSS Strategy
MSB Strategy
Liquidity Sweep
Liquidity Grab
BSL Sweep
SSL Sweep
EQH Sweep
EQL Sweep
PDH Sweep
PDL Sweep
PWH Sweep
PWL Sweep
Premium/Discount
OTE
Draw on Liquidity (DOL)
Internal Liquidity
External Liquidity
Inducement
Judas Swing
Power of 3 / PO3
AMD
ICT Killzone
Session Sweep
Asian Range Sweep
London Sweep
New York Sweep
Order Block
Breaker Block
Mitigation Block
Rejection Block
Flip Zone
FVG
IFVG
BPR
Unicorn Model
Liquidity Void
Displacement
CISD
2. CRT Family
Classic CRT
3-Candle CRT
2-Candle CRT
Multi-Candle CRT
HTF CRT
LTF CRT
Macro CRT
Micro CRT
CRT + OB
CRT + FVG
CRT + Turtle Soup
CRT + AMD
CRT + SMT
CRT + PD Arrays
CRT + Session

Some current CRT references explicitly describe 3-candle, 2-candle and multiple-candle variants, with HTF range selection and LTF entries.

3. Failed Breakout / Reversal Strategies

இது CRT-க்கு மிகவும் அருகிலுள்ள family.

Turtle Soup
Turtle Body Soup
SFP — Swing Failure Pattern
False Breakout
Failed Breakout
Breakout Failure
Spring
Upthrust
UTAD
Failed Auction
Range Failure
Stop Hunt Reversal
Liquidity Sweep Reversal
Sweep + Reclaim
Sweep + MSS
Sweep + CHoCH

Turtle Soup is commonly described as fading failed breakouts of prior extremes; SFP and CRT overlap with the same broad sweep/reclaim behavior, though their reference levels and rules differ.

4. Wyckoff Strategies
Accumulation
Distribution
Reaccumulation
Redistribution
Spring
Upthrust
SOS — Sign of Strength
SOW — Sign of Weakness
SC — Selling Climax
BC — Buying Climax
AR — Automatic Rally/Reaction
ST — Secondary Test
LPS
LPSY
UTAD
Creek Break
Jump Across the Creek
Wyckoff Composite Man
Wyckoff Phase A/B/C/D/E
5. Price Action / Candlestick Strategies
Support / Resistance
Breakout
Breakdown
Retest
Range Trading
Trendline Break
Channel Break
Horizontal Breakout
Inside Bar
Outside Bar
Pin Bar
Engulfing
Doji Reversal
Morning Star
Evening Star
Hammer
Shooting Star
Three-Bar Reversal
Three-Bar Play
Two-Bar Reversal
NR7
NR4
Hikkake
Opening Range
Gap Fill
Gap-and-Go
Island Reversal
6. Classical Chart Pattern Strategies
Head & Shoulders
Inverse H&S
Double Top
Double Bottom
Triple Top
Triple Bottom
Ascending Triangle
Descending Triangle
Symmetrical Triangle
Bull Flag
Bear Flag
Bull Pennant
Bear Pennant
Wedge Breakout
Rising Wedge
Falling Wedge
Rectangle Breakout
Cup & Handle
Inverse Cup & Handle
Rounded Bottom
Rounded Top
Broadening Formation
Diamond Top
Diamond Bottom
Megaphone
7. Trend Following Strategies
Moving Average Trend
EMA Crossover
SMA Crossover
EMA Pullback
MA Ribbon
ADX Trend
Donchian Breakout
Channel Breakout
Parabolic SAR Trend
Supertrend
ATR Trend
Trendline Continuation
Higher-High/Higher-Low Trend
Lower-High/Lower-Low Trend
Momentum Breakout
Volatility Expansion
8. Breakout Strategies
Opening Range Breakout (ORB)
Initial Balance Breakout
Asia Range Breakout
London Range Breakout
NY Range Breakout
Previous Day Breakout
Previous Week Breakout
Previous Month Breakout
Donchian Breakout
Bollinger Breakout
Volatility Breakout
Range Compression Breakout
Inside Bar Breakout
NR7 Breakout
High/Low Breakout
Volume Breakout
9. Mean Reversion Strategies
VWAP Mean Reversion
Bollinger Band Mean Reversion
Keltner Mean Reversion
Z-Score Reversion
Distance-from-Mean
ATR Extension Reversion
RSI Mean Reversion
Statistical Mean Reversion
Session Extreme Reversion
Range High/Low Fade
POC Reversion
Value Area Reversion
HVN Reversion
LVN Reversion
10. Volume / Market Profile Strategies
Volume Profile
Session Volume Profile
Fixed Range Volume Profile
Anchored Volume Profile
POC Reversion
POC Breakout
VAH Rejection
VAL Rejection
Value Area Breakout
HVN Rejection
HVN Acceptance
LVN Rejection
LVN Traversal
TPO
Market Profile
Initial Balance
Failed Auction
Excess High
Excess Low
Single Prints
Poor High
Poor Low
Value Migration

Volume Profile specifically provides POC, VAH, VAL, HVN and LVN-style references.

11. Order Flow Strategies
Footprint
Bid/Ask Imbalance
Stacked Imbalance
Delta
CVD
Delta Divergence
CVD Divergence
Absorption
Exhaustion
Aggressor Flow
Large Trade
Whale Trade
Trade Velocity
Trade Count Spike
Volume Burst
Volume Dry-up
Iceberg Detection
Liquidity Replenishment
Liquidity Pull
Spoof Detection*
Book Imbalance
Order Book Pressure

* Spoof-related detection needs particularly careful handling; a visible cancellation pattern is not automatically proof of manipulation.

12. Liquidity / Order Book Strategies
Liquidity Heatmap
Resting Liquidity
Persistent Liquidity
Liquidity Wall
Bid Wall
Ask Wall
Wall Pull
Wall Replenishment
Liquidity Cluster
Sweep of Wall
Absorption at Wall
Book Imbalance
Depth Imbalance
Spread Expansion
Spread Compression
Microstructure Breakout
Orderbook Reversion
Orderbook Momentum
13. Derivatives / Futures Strategies
OI + Price
OI + CVD
OI + Volume
Price/OI Divergence
Long Build-up
Short Build-up
Long Unwinding
Short Covering
Funding Reversion
Funding Momentum
Basis Trading
Basis Arbitrage
Perpetual vs Spot
Perpetual Premium/Discount
Liquidation Cascade
Liquidation Sweep
Liquidation Reversal
OI Flush
OI Expansion Breakout
14. Liquidation Strategies
Long Liquidation Cluster
Short Liquidation Cluster
Long Squeeze
Short Squeeze
Liquidation Cascade
Post-Liquidation Reversal
Liquidation Sweep + Reclaim
Liquidation Magnet
Liquidation Run
15. Volatility Strategies
ATR Expansion
ATR Compression
Volatility Breakout
Volatility Contraction
Squeeze
Bollinger Squeeze
Keltner Squeeze
Historical Volatility Regime
Realized Volatility Regime
Volatility Percentile
Volatility Mean Reversion
Range Expansion
Range Contraction
16. VWAP Family
Session VWAP
Anchored VWAP
Weekly VWAP
Monthly VWAP
VWAP Reversion
VWAP Breakout
VWAP Pullback
VWAP Reclaim
VWAP Rejection
VWAP + Liquidity
VWAP + Volume
VWAP + CVD
17. Momentum Strategies
ROC Momentum
RSI Momentum
MACD Momentum
ADX Momentum
EMA Momentum
Price Velocity
Volume Momentum
Delta Momentum
CVD Momentum
Momentum Continuation
Momentum Exhaustion
Momentum Breakout
Displacement Continuation
18. Divergence Strategies
Price vs RSI
Price vs MACD
Price vs Volume
Price vs Delta
Price vs CVD
Price vs OI
Price vs VWAP
BTC vs ETH SMT
BTC vs Total Market
Spot vs Perpetual
Options vs Spot
19. Statistical / Quant Strategies
Z-Score
Mean Reversion
Pairs Trading
Statistical Arbitrage
Cointegration
Correlation Reversion
Momentum Factor
Value Factor
Volatility Factor
Trend Factor
Seasonality
Autocorrelation
Regime Switching
Hidden Markov Model
Kalman Filter
State-Space Models
ARIMA
GARCH
Monte Carlo
Bootstrap
Bayesian Trading
20. Machine Learning Strategies
Classification
Regression
Probability Forecasting
Multi-class Direction
Return Prediction
Volatility Prediction
Regime Classification
Trade / No-Trade Classification
Meta-Labeling
Stacked Models
Ensemble Models
Random Forest
XGBoost
LightGBM
CatBoost
SVM
Neural Network
LSTM
Transformer
Temporal CNN
Reinforcement Learning

உன் existing LightGBM CE / PE / NO_TRADE model இந்த family-க்குள் வரும்.

21. Options Strategies
Long Call
Long Put
Short Call
Short Put
Covered Call
Cash-Secured Put
Bull Call Spread
Bear Put Spread
Bull Put Spread
Bear Call Spread
Call Ratio Spread
Put Ratio Spread
Straddle
Strangle
Iron Condor
Iron Butterfly
Calendar Spread
Diagonal Spread
Butterfly
Broken Wing Butterfly
Christmas Tree
Jade Lizard
Risk Reversal
Collar
Gamma Scalping
Delta Hedging
Volatility Trading
IV Mean Reversion
IV Rank
IV Percentile
IV Crush
IV Expansion
Skew Trading
Term Structure Trading
22. Expiry-Day Strategies

உன் BTC/options expiry use caseக்கு especially:

Gamma Expansion
Gamma Scalping
Theta Decay
Expiry Pin
Max Pain* 
Strike Magnet
Strike Liquidity
OI Wall
Call Wall
Put Wall
ATM Gamma
0DTE Momentum
0DTE Mean Reversion
Expiry Breakout
Expiry Range Fade
Expiry Liquidity Sweep

* Max Pain is a commonly used market heuristic, not a guaranteed price target.

23. Scalping Strategies
1m Breakout
1m Retest
1m Liquidity Sweep
1m CHoCH
1m Micro BOS
VWAP Scalping
Orderbook Scalping
Footprint Scalping
Delta Scalping
CVD Scalping
Heatmap Scalping
Spread Scalping
Momentum Scalping
Reversion Scalping
24. Intraday Session Strategies
Asia Range
London Open
London Killzone
London Sweep
NY Open
NY Killzone
NY Reversal
Opening Range
First 15m
First 30m
Lunch Reversion
Power Hour
Close Momentum
Session High Sweep
Session Low Sweep
25. Gap Strategies
Gap Fill
Gap-and-Go
Opening Gap Breakout
Opening Gap Fade
Common Gap
Breakaway Gap
Runaway Gap
Exhaustion Gap
Weekly Gap
Daily Gap
Session Gap
26. Arbitrage Strategies
Spot/Futures Arbitrage
Perpetual/Spot Arbitrage
Cross-Exchange Arbitrage
Funding Arbitrage
Basis Arbitrage
Triangular Arbitrage
Statistical Arbitrage
Calendar Spread Arbitrage
Options Arbitrage
Put-Call Parity
Conversion
Reversal
Box Spread
27. Market-Neutral Strategies
Pairs Trading
Delta Neutral
Beta Neutral
Dollar Neutral
Market Neutral
Statistical Neutral
Options Delta Neutral
Gamma Neutral
Vega Neutral
28. Market Regime Strategies
Trending Market Strategy
Range Market Strategy
High Volatility Strategy
Low Volatility Strategy
Expansion Regime
Compression Regime
Risk-On Regime
Risk-Off Regime
Bull Regime
Bear Regime
Neutral Regime
Transition Regime
29. Hybrid Models — R&Dக்கு மிகவும் interesting

இதுதான் உன் systemக்கு அதிக value தரக்கூடும்:

SMC + CRT
SMC + PO3
SMC + Turtle Soup
SMC + SFP
SMC + Volume Profile
SMC + Heatmap
SMC + Footprint
SMC + CVD
SMC + OI
SMC + Liquidations
SMC + VWAP
SMC + Volatility Regime

CRT + SFP
CRT + Turtle Soup
CRT + SMT
CRT + Volume Profile
CRT + Heatmap
CRT + CVD
CRT + OI

PO3 + Liquidity
PO3 + Session
PO3 + VWAP

Order Block + FVG
Order Block + Volume
Order Block + Absorption
FVG + Liquidity
FVG + CVD
FVG + VWAP

Breakout + Volume
Breakout + OI
Breakout + CVD
Breakout + Heatmap
Breakout + Footprint
30. Entry-model strategies

உன் current researchக்கு இது particularly important:

Break Entry
Retest Entry
Limit Entry
Close Confirmation
Momentum Entry
Pullback Entry
Micro-Structure Entry
Sweep Entry
Reclaim Entry
Break-and-Retest
Sweep-and-Reclaim
OB Retest
FVG Retest
VWAP Reclaim
POC Reclaim
Range Reclaim

உன் current study already break / close / limit / hybrid modes compare செய்திருக்கிறது.

31. Exit strategies
Fixed R
Liquidity Target
Swing Target
POC Target
VAH/VAL Target
Opposite Zone Target
ATR Target
Trailing Swing
ATR Trailing
Chandelier Exit
Break-even
Partial TP
Scale-out
Time Exit
Structure Exit
Opposite Signal Exit
Momentum Exhaustion Exit