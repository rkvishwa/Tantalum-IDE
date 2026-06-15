---
title: "Diss-Master"
description: "A real-time multiplayer word game inspired by Codenames, designed for groups who want the fun without the cardboard."
tags: ["Web", "Game"]
branch: "main"
commit: "da34852"
---

- **[Play the Game](https://diss-master.knurdz.org)**
- **[GitHub Repository](https://github.com/knurdz/diss-master)**

## Overview

Diss-Master is a real-time multiplayer word game inspired by **Codenames**, the beloved board game designed by Vlaada Chvátil and published by Czech Games Edition. It brings the entire Codenames experience to the browser — no physical cards, no app store, no account required. Create a room, share a link, and start playing in under 30 seconds.

The game supports up to 8 players across two teams, with a dedicated Spymaster view and an Operative view rendered simultaneously — all kept in perfect sync via Appwrite Realtime.

## Gameplay

Two teams of players compete to identify their secret words on a shared grid. One player per team — the **Spymaster** — can see which words belong to which team. They give one-word clues to guide their teammates (Operatives) to guess the right words while avoiding the opposing team's words and the deadly **Assassin** word.

The first team to correctly identify all their words wins.

## Features

- **Real-time multiplayer** — Fluid state sync across all connected clients using Appwrite Realtime.
- **Room system** — Generate unique room codes; no account needed to join.
- **Spymaster / Operative views** — Role-based UI rendering so Spymasters see the colour map and Operatives see only the neutral grid.
- **Word lists** — Choose from built-in word packs or generate them randomly.
- **Animated game board** — Smooth card-flip animations when words are revealed, with team-coloured feedback.
- **Game history** — Review the full sequence of clues and guesses.
- **Mobile-friendly** — Fully responsive layout for phone and tablet players.

## Architecture

Diss-Master uses a **Next.js** frontend paired with **Appwrite** for its backend and real-time event propagation. All game state is maintained in Appwrite's databases, with clients receiving state updates in real-time.

```text
Browser (Next.js)

     │
     │  Appwrite Realtime Subscriptions
     ▼

Appwrite Server

     │
     │  Read/Write
     ▼

Database (Appwrite Collections)
```

A room's game state (board, teams, clues, guesses) is stored in **Appwrite** documents, enabling fast reads and seamless real-time syncing.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js + React |
| State | Zustand |
| Styling | Tailwind CSS |
| Backend & Real-time | Appwrite |
| Icons | Lucide React |

## Status

Core gameplay is complete and stable, running fully on Appwrite with Next.js App Router.
