---
title: "Meta Scribe"
description: "A web-based SEO auditing tool that analyzes metadata, structured data, and on-page content quality to provide actionable optimization recommendations."
tags: ["Web App", "SEO", "Developer Tool"]
branch: "main"
commit: "fbb32e6"
---

- GitHub Repository: https://github.com/SadeepaNHerath/MetaScribe
- Website: https://meta-scribe.vercel.app/

## Overview

MetaScribe is a full-stack SEO analysis platform that helps developers, marketers, and site owners evaluate how well a webpage is optimized for search and social sharing.

Given a URL, it fetches the page, parses its HTML, and generates a multi-dimensional SEO report including:
- Meta tag coverage
- Social sharing tags
- Best-practice checks
- Structured data validation
- Content quality analysis

The result is a practical, score-based report with concrete recommendations and copy-ready examples.

## The Problem

Many SEO tools are either too shallow (basic tag checkers) or too heavy (enterprise dashboards with noisy output). MetaScribe focuses on a useful middle ground: clear diagnostics, transparent scoring, and actionable fixes for technical SEO essentials.

## Key Features

- URL-based SEO scan with automatic protocol handling and robust fetch error messaging.
- Multi-category scoring system:
  - Overall score
  - Required tags
  - Social tags
  - Best practices
  - Content quality
  - Structured data
- Meta tag extraction across:
  - Essential tags (title, description, viewport)
  - Open Graph and Twitter card tags
  - Canonical, robots, language, and additional extended tags
- Structured data analyzer:
  - Detects JSON-LD blocks
  - Validates schema basics and common schema types
  - Flags missing required fields
- Content quality analyzer:
  - H1 and heading hierarchy checks
  - Image alt-text coverage
  - Word count depth analysis
- Platform preview simulation for:
  - Google
  - X/Twitter
  - Facebook
  - LinkedIn
- Recommendation engine with severity levels and optional code snippets.
- Raw head HTML inspection and copy support.
- Caching layer for recent analyses with a one-hour TTL.
- Dual runtime model:
  - Local Express API
  - Serverless API for Vercel deployment

## Technical Architecture

MetaScribe uses a React frontend with a Node/Express API for local development, plus a serverless function path for production deployment.

Core SEO analysis logic is centralized in shared modules so extraction, scoring, and recommendations remain consistent across environments.

```text
┌──────────────────────────────┐
│        React Frontend        │
│   (Vite + TypeScript + UI)   │
└──────────────┬───────────────┘
               │ HTTP /api/analyze
┌──────────────▼───────────────┐
│      API Execution Layer     │
│ Express (local) or Vercel Fn │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│    Shared Core Analyzers     │
│ Fetch + Parse + SEO Scoring  │
│ Structured Data + Content QA │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│  In-memory Analysis Storage  │
│      + Cache (TTL based)     │
└──────────────────────────────┘
```

## Stack

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript + Vite |
| UI System | Tailwind CSS + Radix UI + shadcn/ui |
| Data Fetching | TanStack Query |
| Backend (Local) | Node.js + Express |
| Backend (Deploy) | Vercel Serverless Functions |
| HTML Parsing | Cheerio |
| HTTP Client | Axios |
| Validation | Zod |
| Shared Core | TypeScript shared analyzers |
| Testing | Vitest |
| Data Layer | In-memory cache/storage (Drizzle/Postgres planned) |

## Status

MetaScribe is under active development with working end-to-end analysis, scoring, previews, and recommendations.  
It currently uses in-memory storage, with persistent database integration planned.

---
