# Treejs Generator

Upload reference photos, let system plan every detail, approve, and get an interactive 3D model you can iterate on and export as GLB.

## Run

```bash
cd treejs-generator
npm install
# put your key in .env  ->  ANTHROPIC_API_KEY=sk-ant-...   (use "mock" to test without the API)
npm run dev        # API :8787 + web http://localhost:5174
```

The key is re-read on every request, so you can edit `.env` without restarting.
Model IDs are configurable in `.env` (`MODEL_OPUS`, `MODEL_SONNET`, `MODEL_HAIKU`).

## Flow

1. Attach photo(s) + prompt -> **Planner** (Opus 5.5 or Sonnet 5.5) writes a forensic plan (component counts, geometry, scale, colors, details).
2. Reply to revise the plan, or pick a **Builder** (Sonnet 5.5 or Haiku 5.5) and press **Start**.
3. The generated code runs in the right-hand viewer (v1, v2, ...). Click the model to use its interactions, **Export GLB** to download.
4. Keep prompting / attaching new references to refine or extend (e.g. add roads, fireworks on click). Each change builds on the latest version.
5. **+ New chat** starts another object. Chats are saved in `data/sessions/` and listed in the sidebar as "<Object> model".

## Layout

- `server/server.mjs` - HTTP API, SSE streaming proxy to Anthropic, session storage
- `server/prompts.mjs` - planner and builder system prompts
- `src/` - UI (`main.js`), 3D viewer + GLB export (`viewer.js`)

