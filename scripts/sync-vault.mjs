#!/usr/bin/env node
// Copies blog posts (and the Start here / Now / Links pages) from Obsidian
// folders into src/content/posts and src/content/pages, converting
// Obsidian-only syntax to standard markdown.
// The vault is only ever READ. The repository copy is generated output.
//
// Usage: node scripts/sync-vault.mjs "<path to vault blog folder>" [--dry-run]
//   or set BLOG_VAULT_DIR in the environment, or in a local .env file (gitignored).
// Pages sync from PAGES_VAULT_DIR the same way, if that's set; it's optional.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

try { process.loadEnvFile(); } catch { /* no .env file, fine */ }

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const src = args.find((a) => !a.startsWith('--')) ?? process.env.BLOG_VAULT_DIR;
const pagesSrc = process.env.PAGES_VAULT_DIR;
if (!src) {
  console.error('Give the vault blog folder as an argument or set BLOG_VAULT_DIR.');
  process.exit(1);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const postsDir = path.join(root, 'src/content/posts');
const pagesDir = path.join(root, 'src/content/pages');
const imagesDir = path.join(root, 'public/images');
const attachmentDirs = (process.env.BLOG_ATTACHMENT_DIRS ?? '').split(path.delimiter).filter(Boolean);

const imageExt = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Shrink anything wider than this before it's copied in - a full-res phone
// photo has no business shipping untouched to a 40rem-wide text column.
const MAX_IMAGE_WIDTH = 1600;
const noResizeExt = /\.(gif|svg)$/i; // animated/vector - resizing would do more harm than good

async function writeImage(from, to) {
  if (noResizeExt.test(from)) { await fs.copyFile(from, to); return; }
  const img = sharp(from).resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true });
  switch (path.extname(to).toLowerCase()) {
    case '.jpg': case '.jpeg': img.jpeg({ quality: 82 }); break;
    case '.png': img.png({ compressionLevel: 9 }); break;
    case '.webp': img.webp({ quality: 82 }); break;
    case '.avif': img.avif({ quality: 60 }); break;
  }
  await img.toFile(to);
}

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

// A post's `image:` frontmatter field names a header image, the same way an
// embed names one - resolve and copy it the same way, in place in the
// frontmatter. A value that's already a URL or an absolute path is left alone.
async function resolveHeaderImage(text, notePath, files) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = fm?.[1].match(/^image:\s*(.+)$/m);
  if (!line) return text;
  const value = line[1].trim().replace(/^['"]|['"]$/g, '');
  if (/^https?:\/\//.test(value) || value.startsWith('/')) return text;
  const found = await findImage(value, notePath);
  if (!found) {
    console.warn(`  ! header image not found: ${value} (in ${path.basename(notePath)})`);
    return text;
  }
  const outName = slugify(path.basename(value, path.extname(value))) + path.extname(value).toLowerCase();
  files.images.set(outName, found);
  return text.replace(/^image:\s*.+$/m, `image: /images/${outName}`);
}

// sequoia publish writes atUri into the generated post after publishing, but
// the vault source never has it - so a plain resync would wipe it every time
// and make every post look "changed" forever. Carry it over from whatever's
// already on disk if the freshly-synced version doesn't have one.
async function preserveAtUri(newContent, existingPath) {
  const fm = newContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm && /^atUri:/m.test(fm[1])) return newContent;
  let existing;
  try { existing = await fs.readFile(existingPath, 'utf8'); } catch { return newContent; }
  const atUriLine = existing.match(/^atUri:.*$/m);
  if (!atUriLine) return newContent;
  return newContent.replace(/^(---\r?\n[\s\S]*?)(\r?\n---)/, (_, head, close) => `${head}\n${atUriLine[0]}${close}`);
}

const notes = (await walk(src)).filter((f) => f.endsWith('.md'));
const slugs = new Set(notes.map((n) => slugify(path.basename(n, '.md'))));
const files = { posts: new Map(), pages: new Map(), images: new Map() };
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
  const withHeaderImage = await resolveHeaderImage(raw, note, files);
  const body = await preserveAtUri(await convert(withHeaderImage, note, files, slugs), path.join(postsDir, `${slug}.md`));
  files.posts.set(`${slug}.md`, body);
}

// Pages (Start here, Now, Links): same conversion, but no date/draft needed -
// they're always-on nav pages, not posts.
if (pagesSrc) {
  const pageNotes = (await walk(pagesSrc)).filter((f) => f.endsWith('.md'));
  for (const note of pageNotes) {
    const raw = await fs.readFile(note, 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const name = path.basename(note);
    if (!fm || !/^title:/m.test(fm[1])) {
      problems.push(`${name}: needs title in front matter, skipped`); continue;
    }
    const slug = slugify(path.basename(note, '.md'));
    files.pages.set(`${slug}.md`, await convert(raw, note, files, slugs));
  }
}

console.log(`${files.posts.size} post(s), ${files.pages.size} page(s), ${files.images.size} image(s)`);
problems.forEach((p) => console.warn(`  ! ${p}`));
if (dryRun) { console.log('Dry run: nothing written.'); process.exit(0); }

await fs.mkdir(postsDir, { recursive: true });
await fs.mkdir(pagesDir, { recursive: true });
await fs.mkdir(imagesDir, { recursive: true });
// Remove generated posts that no longer exist in the vault (repository copy is output only)
for (const existing of await fs.readdir(postsDir)) {
  if (existing.endsWith('.md') && !files.posts.has(existing)) {
    await fs.rm(path.join(postsDir, existing));
    console.log(`- removed stale: ${existing}`);
  }
}
for (const [name, body] of files.posts) await fs.writeFile(path.join(postsDir, name), body);
// Pages are never removed automatically: losing a vault note shouldn't blank
// out a live nav page. Delete the generated file by hand if one's retired.
for (const [name, body] of files.pages) await fs.writeFile(path.join(pagesDir, name), body);
for (const [name, from] of files.images) await writeImage(from, path.join(imagesDir, name));
console.log('Synced.');
