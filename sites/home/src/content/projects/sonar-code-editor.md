---
title: "Sonar Code Editor"
banner: "/images/projects/sonar-code-editor/banner-6.png"
bannerLight: "/images/projects/sonar-code-editor/banner-light-3.png"
description: "A secure, real-time collaborative coding environment designed specifically for supervised exams and technical interviews."
tags: ["Desktop App", "Web"]
branch: "development"
commit: "78dc070"
license: "MIT"
---

- 🐙 **GitHub Repository**: [https://github.com/rkvishwa/Sonar-Code-Editor](https://github.com/rkvishwa/Sonar-Code-Editor)
- 🌐 **Webview**: [https://sonar.knurdz.org/](https://sonar.knurdz.org/)


## Overview

Sonar Code Editor is a purpose-built coding environment engineered for high-stakes scenarios — from university programming exams to technical hiring interviews. Unlike general-purpose IDEs, Sonar operates in a controlled, supervised mode that prevents candidates from accessing external resources while allowing proctors full visibility into in-progress code.

The editor supports real-time collaboration, meaning interviewers can observe and annotate code as it is being written, creating a natural and authentic interview experience.

## The Problem

Traditional coding interviews rely on screen-sharing hacks, locked-down browsers, or proprietary platforms that feel alien to developers. Sonar bridges the gap: it feels like a real editor — keyboard shortcuts, syntax highlighting, multi-file support — while giving institutions the control they need.

## Key Features

- **Real-time collaboration** — Google Docs-style live editing powered by Yjs (CRDT), featuring automated workspace sync and multi-colored shared cursors with conflict-free resolution.
- **Supervised Exam Mode** — Enforces academic integrity via an admin dashboard that can globally disable auto-complete and snippets. Includes a strict localhost-only preview panel that silently blocks external navigation.
- **Advanced Activity Monitoring** — Dual-layer monitoring tracks all restricted events (e.g., suspicious pastes, app blurring), syncing them to a real-time dashboard and allowing PDF exports of color-coded session logs.
- **Multi-language support** — Powered by the Monaco Editor engine, supporting multiple programming languages (e.g., HTML, CSS, PHP, JavaScript, TypeScript, Python) with out-of-the-box syntax highlighting.
- **Cross-platform Desktop App** — Ships as a secure, native desktop application (Electron-based) available for Windows, macOS, and Linux.

## Technical Architecture

Sonar is built on an **Electron + React** frontend with an **Appwrite** backend architecture. The Monaco Editor (the same engine powering VS Code) is embedded and surgically extended to support Sonar's proctoring hooks.

Real-time collaboration relies on **Yjs** for conflict-free replicated data types (CRDTs) to merge concurrent edits seamlessly across networks.

```
┌─────────────────────────────┐
│   Sonar Desktop App         │
│ (Electron + Monaco + Yjs)   │
└─────────────┬───────────────┘
              │
              │ WebSocket / REST
              ▼
┌─────────────────────────────┐
│    Appwrite Backend         │
│(Auth, Database, Functions)  │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│  Web Dashboard (Webview)    │
│      (SvelteKit)            │
└─────────────────────────────┘
```

## Stack

| Layer | Technology |
|---|---|
| Desktop Shell | Electron |
| Editor Engine | Monaco Editor + Yjs |
| Frontend | React + TypeScript + Vite |
| Backend & Auth| Appwrite |
| Real-Time Sync| y-websocket |
| Serverless | Node.js (Appwrite Functions) |
| Web Dashboard | SvelteKit + Tailwind CSS |

## Status

Sonar is currently under active development on the `main` branch. An open beta is available for anyone to install, test, and contribute.

## ⚖️ License

This project is licensed under the MIT License.
