# Tantalum IDE Renderer

This is the React + TypeScript renderer for the Electron desktop app.

Run all local development commands from the repository root:

```bash
npm install
npm run dev
```

The root npm workspace installs this renderer's Vite, React, TypeScript, and lint dependencies. The Electron main process loads the Vite dev server at `http://127.0.0.1:5173` during `npm run dev`, so renderer edits should update live through Vite HMR.
