# Vocabulatrix

A zero-dependency random-word explorer. Pull 1–10 random English words, each
fetched live from a dictionary API and rendered into a liquid-glass card with a
matrix-style reveal, an organically drifting animated border, and a localized
hover-scramble effect that trails the cursor and winds down with a twitchy tail.

Pure HTML / CSS / vanilla JS — no build step, no frameworks.

## Run locally

A static server is all it needs (the included one disables caching so edits show
up on refresh):

```bash
python serve.py
# then open http://localhost:8765/
```

On Windows you can also just double-click `start.bat`.

## Files

- `index.html` — markup
- `style.css` — styling and the liquid-glass border (`@property`-driven gradient)
- `app.js` — word fetching, masonry layout, and all the animation engines
- `words_alpha.txt` — the source word list (~370k words) randomly sampled from
- `serve.py` / `start.bat` — tiny no-cache dev server

## How it works

- **Random words** are sampled from `words_alpha.txt`, then defined via a
  dictionary API; words with no definition are retried.
- **Masonry layout** drops each card into the currently-shortest column.
- **Intro reveal** scrambles every text node through a wide glyph pool and
  resolves it top-to-bottom.
- **Liquid-glass border** is a masked conic gradient whose angle is driven
  per-card from JS with randomized direction and organically varying speed.
- **Hover scramble** hit-tests each character against the cursor; a per-character
  "heat" value drives the cycling and decays with a heavy-tailed wind-down so a
  couple of characters glitch out last.
- **Stable boxes** — card and paragraph heights are locked to their natural size
  so wider scramble glyphs never reflow or shift the layout.
