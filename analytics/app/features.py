"""
The Outlook card's state features, in one place.

`measure_outlook.py` counts history with these and `outlook_parity.py` writes
test vectors from them, which the Node server's tests must reproduce to the
digit. That is the whole contract between the two languages: the live desk
labels "now" exactly the way history was labelled, or the measured odds do not
apply to it.
"""


def ema_series(xs, p):
    """EMA seeded with the simple mean of the first `p` values, like the server's."""
    k = 2 / (p + 1)
    out, e = [], None
    for i, x in enumerate(xs):
        if i < p - 1:
            out.append(None)
            continue
        e = sum(xs[i - p + 1:i + 1]) / p if e is None else x * k + e * (1 - k)
        out.append(e)
    return out


def rsi_series(xs, p=14):
    """Wilder's RSI, seeded with the average of the first `p` changes."""
    out = [None] * len(xs)
    g = l = 0.0
    for i in range(1, len(xs)):
        d = xs[i] - xs[i - 1]
        if i <= p:
            g += max(d, 0)
            l += max(-d, 0)
            if i == p:
                g /= p
                l /= p
                out[i] = 100.0 if l == 0 else 100 - 100 / (1 + g / l)
        else:
            g = (g * (p - 1) + max(d, 0)) / p
            l = (l * (p - 1) + max(-d, 0)) / p
            out[i] = 100.0 if l == 0 else 100 - 100 / (1 + g / l)
    return out


def stack_bucket(e9, e21, e50):
    if e9 is None or e21 is None or e50 is None:
        return None
    return 'rising' if e9 > e21 > e50 else 'falling' if e9 < e21 < e50 else 'mixed'


def rsi_bucket(r):
    if r is None:
        return None
    return 'overbought' if r > 70 else 'oversold' if r < 30 else 'neutral'


def momentum_bucket(move, tau):
    """`move` and `tau` as fractions: the prior window's return against the Side band."""
    return 'down' if move < -tau else 'up' if move > tau else 'flat'
