# blog.tobyrogers.pm

Astro static site. Posts are written in Obsidian, synced here, published to your
Atmosphere account with Sequoia, and deployed to Cloudflare Pages.

The vault copy of a post is the original. `src/content/posts/` and `public/images/`
are generated output: never edit them by hand.

## One-off set-up

1. `npm install`
2. `npx sequoia login` (OAuth with your Bluesky account).
3. `npx sequoia init`. Use these answers: site URL `https://blog.tobyrogers.pm`,
   content directory `src/content/posts`, public directory `public`,
   build output `dist`, path prefix `/posts`, date field `date`. Choose to create a new
   publication record. This writes `publicationUri` into `sequoia.json` and
   creates `public/.well-known/site.standard.publication`.
4. Commit everything, including `sequoia.json` and `.sequoia-state.json`
   (once it exists). `inject` needs the state file at build time.
5. Create a Cloudflare Pages project from the repository:
   build command `npm run build:cloudflare`, output directory `dist`,
   environment variable `NODE_VERSION=22`.
6. Add `blog.tobyrogers.pm` as the custom domain (see the cut-over notes below).

## Writing a post

1. In your vault's blog folder, add a note with front matter:

   ```yaml
   ---
   title: My post
   description: One sentence for previews and the feed.
   date: 2026-10-20
   tags: [product]
   draft: false      # true keeps it out of the site and the network
   ---
   ```

2. Run `BLOG_VAULT_DIR="/path/to/vault/Blog" npm run release`. This syncs the folder
   (read-only on the vault side), then `sequoia publish` writes the records to your account.
3. `git add -A && git commit && git push`. Cloudflare builds the site and `sequoia inject`
   adds the verification link tags.

Run `node scripts/sync-vault.mjs "/path/to/vault/Blog" --dry-run` first to see what
would change. Images: put them in an `attachments` folder inside the blog folder, or set
`BLOG_ATTACHMENT_DIRS` (path-separator separated) to your vault attachment folders.

## What the sync script converts

Wikilinks (links only if the target is a post, otherwise plain text), image embeds,
callouts (to a bold title in a blockquote), `==highlights==`, `%%comments%%`.
Anything else Obsidian-specific (Dataview, embeds of other notes, canvas) is not handled.
Notes without `title` and `date`, and notes with `draft: true`, are skipped.

## Cut-over notes

- Old write.as URLs stop working when the domain moves. This build starts fresh, so
  nothing redirects. Either keep write.as live on its own `*.write.as` address,
  or add a Cloudflare redirect rule later.
- Remove the custom domain from write.as before attaching it in Cloudflare.
- `bluesky.enabled` in `sequoia.json` is `false`. Setting it to `true` makes `publish`
  also post each new article to Bluesky.
- Everything published is public on the network. Keep drafts in the vault with
  `draft: true`.
- If a post is edited, `sequoia publish` updates the existing record (it tracks hashes in
  `.sequoia-state.json`). Never delete that file; `sequoia sync` restores it from your account.
