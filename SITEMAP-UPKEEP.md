# Sitemap upkeep

`sitemap.xml` covers every site on samoff.com, but it is built from the separate site repos. This repo (`timsamoff.github.io`) only holds the output.

## When to regenerate
Any time you add, remove, or rename a public page in any site repo, or edit a page you want Google to see as updated.

## Steps
1. In the site repo, add the new page with gtag, a canonical (`https://samoff.com/...`), and a description. Use `<meta name="robots" content="noindex">` for admin, draft, or template pages.
2. Commit the page change in that repo. `<lastmod>` comes from git history, so uncommitted edits don't count.
3. In this repo: `node generate-sitemap.js`
4. Commit `sitemap.xml` and push this repo.

The script lists every git-tracked `.html` file that has a `<head>` and no noindex tag. It warns if a page has no canonical, or if the canonical differs from the URL it derived.

## Pre-push gate
`.githooks/pre-push` runs `node generate-sitemap.js --check` and blocks the push if the sitemap is stale. Install it once per clone:

```
git config core.hooksPath .githooks
```

Limit: the gate only runs when you push **this** repo. Pushing a site repo doesn't trigger it, so after pushing page changes elsewhere, run the steps above, or the next push here will remind you.

## Adding a new site
Add `{ folder, urlPath }` to `SITES` in `generate-sitemap.js` (Ryewired and Sidequest are there, commented out), link it from `index.html` with a plain `<a href>`, then regenerate.

## Notes
- Sibling repos must sit next to this one in the same parent folder, under the names in `SITES`.
- This file is served as plain text at samoff.com/SITEMAP-UPKEEP.md. It isn't linked or in the sitemap. Move it out of the repo if you'd rather it not be public.
- Submit `https://samoff.com/sitemap.xml` in Google Search Console once. Google rereads it on its own after that.
