---
layout: default
title: GitHub Pages Docs Source
description: Notes for publishing the Tantalum IDE docs folder on GitHub Pages.
---

# GitHub Pages Docs Source

This folder is a static documentation website for Tantalum IDE. GitHub Pages can serve it directly from the repository by selecting **Settings > Pages > Deploy from a branch > /docs**.

## Files

- `index.html` is the project documentation home page.
- `assets/styles.css` and `assets/site.js` provide the site shell.
- `assets/images/` and `assets/screenshots/` contain local visual assets used by the site.
- `_config.yml` and `_layouts/default.html` let GitHub Pages render Markdown files with the same navigation and styling.
- `azure-selfhost-appwrite.md` is the detailed Appwrite-on-Azure runbook and renders as `azure-selfhost-appwrite.html` on GitHub Pages.

## Local Preview

Open `index.html` directly in a browser for the main site. Markdown pages are rendered by GitHub Pages/Jekyll when published.
