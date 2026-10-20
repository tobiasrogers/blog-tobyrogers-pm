#!/usr/bin/env node
// Copies blog posts from an Obsidian folder into src/content/posts,
// converting Obsidian-only syntax to standard markdown.
// The vault is only ever READ. The repository copy is generated output.
//
// Usage: node scripts/sync-vault.mjs "<path to vault blog folder>" [--dry-run]
//   or set BLOG_VAULT_DIR in the environment.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const src = args.find((a) => !a.startsWith('--')) ?? process.env.BLOG_VAULT_DIR;
if (!src) {
  console.error('Give the vault blog folder as an argument or set BLOG_VAULT_DIR.');
  process.exit(1);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const postsDir = path.join(root, 'src/content/posts');
const imagesDir = path.join(root, 'public/images');
const attachmentDirs = (process.env.BLOG_ATTACHMENT_DIRS ?? '').split(path.delimiter).filter(Boolean);

const imageExt = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function findImage(name, notePath) {
  const candidates = [
    path.join(path.dirname(notePath), name),
    path.join(src, name),
    path.join(src, 'attachments', name),
    ...attachmentDirs.map((d) => path.join(d, name)),
  ];
  for (const c of candidates) {
    try { await fs.access(c); return c; } catch {}
  }
  return null;
}

async function convert(text, notePath, files, slugs) {
  // Obsidian comments
  text = text.replace(/%%[\s\S]*?%%/g, '');
  // Image embeds: ![[img.png|alt]]
  const embeds = [...text.matchAll(/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g)];
  for (const m of embeds) {
    const [full, target, alt = ''] = m;
    if (!imageExt.test(target)) { text = text.replace(full, ''); continue; }
    const found = await findImage(target.trim(), notePath);
    if (!found) { console.warn(`  ! image not found: ${target} (in ${path.basename(notePath)})`); continue; }
    const outName = slugify(path.basename(target, path.extname(target))) + path.extname(target).toLowerCase();
    files.images.set(outName, found);
    text = text.replace(full, `![${/^\d+$/.test(alt) ? '' : alt}](/images/${outName})`);
  }
  // Wikilinks: [[Note|Text]] / [[Note#Heading]] -> link if it is a post, else plain text
  text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, target, label) => {
    const slug = slugify(target.trim());
    const display = label ?? target.trim();
    return slugs.has(slug) ? `[${display}](/posts/${slug})` : display;
  });
  // Callouts: > [!note] Title -> bold title in a blockquote
  text = text.replace(/^(>\s*)\[!(\w+)\][+-]?\s*(.*)$/gm, (_, q, type, title) =>
    `${q}**${title || type[0].toUpperCase() + type.slice(1)}**`);
  // Highlights ==text== -> <mark>
  text = text.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  return text;
}

const notes = (await walk(src)).filter((f) => f.endsWith('.md'));
const slugs = new Set(notes.map((n) => slugify(path.basename(n, '.md'))));
const files = { posts: new Map(), images: new Map() };
const problems = [];

for (const note of notes) {
  const raw = await fs.readFile(note, 'utf8');
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const name = path.basename(note);
  if (!fm) { problems.push(`${name}: no front matter, skipped`); continue; }
  if (!/^title:/m.test(fm[1]) || !/^(date|pubDate|publishDate):/m.test(fm[1])) {
    problems.push(`${name}: needs title and date in front matter, skipped`); continue;
  }
  if (/^draft:\s*true/m.test(fm[1])) { console.log(`- draft, skipping: ${name}`); continue; }
  const slug = slugify(path.basename(note, '.md'));
  files.posts.set(`${slug}.md`, await convert(raw, note, files, slugs));
}

console.log(`${files.posts.size} post(s), ${files.images.size} image(s)`);
problems.forEach((p) => console.warn(`  ! ${p}`));
if (dryRun) { console.log('Dry run: nothing written.'); process.exit(0); }

await fs.mkdir(postsDir, { recursive: true });
await fs.mkdir(imagesDir, { recursive: true });
// Remove generated posts that no longer exist in the vault (repository copy is output only)
for (const existing of await fs.readdir(postsDir)) {
  if (existing.endsWith('.md') && !files.posts.has(existing)) {
    await fs.rm(path.join(postsDir, existing));
    console.log(`- removed stale: ${existing}`);
  }
}
for (const [name, body] of files.posts) await fs.writeFile(path.join(postsDir, name), body);
for (const [name, from] of files.images) await fs.copyFile(from, path.join(imagesDir, name));
console.log('Synced.');
