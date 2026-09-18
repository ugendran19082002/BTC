"""btc-desk analytics: the display-only models, served to the Node API.

Nothing here can place, change or cancel an order. The trading engine, the
strategy runner and every gate they read stay in Node; this service only answers
questions the screen asks, and the screen falls back to Node's own figures when
it does not answer.
"""
