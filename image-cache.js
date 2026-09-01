// ─── Local thumbnail cache for character splash art ────────────────────────
//
// enka-network-api builds image URLs against a priority list of CDN mirrors,
// with homdgcat.wiki as the DEFAULT top-priority host - and that host is
// unreliable from here. Previously /analyze fetched the full-size splash art
// over the network on every single analysis (browser-UA fetch + retries to
// get around hotlink protection).
//
// This module replaces that with a local disk cache of tiny thumbnails:
//   - disk hit: read file, zero network, zero latency
//   - miss: fetch once (multi-mirror fallback), resize down, save, serve
//
// Thumbnails are ~320px JPEGs (~10-25 KB each). That's deliberately small:
// OpenAI's vision pipeline downsamples inputs internally anyway (low-detail
// mode caps around 512px), and the analysis prompt only needs the image to
// answer "which character is this" - the structured stat JSON carries all
// the real numbers. At this size the ENTIRE roster costs a few MB, which
// also makes prewarming every character viable (see prewarm-images.js).
//
// Cache files are keyed by Enka avatarId (stable across CDN mirror changes),
// so a game-data refresh that swaps the URL source does NOT invalidate them.

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'image-cache');
const TARGET_WIDTH = 320;
const JPEG_QUALITY = 80;

// Same browser UA trick as before - these CDNs block default/bot UAs.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Mirror candidates for a given UI asset file name (e.g.
// "UI_Gacha_AvatarImg_Cyno"), same set of hosts enka-network-api defaults
// to. Order notes:
//   - enka.network goes FIRST even though the library ranks homdgcat.wiki
//     higher: homdgcat was observed completely unreachable on 2026-08-23
//     (every request failed at connect time), so putting it first just
//     burns two timeouts before every successful fallback fetch.
//   - hakush.in serves WEBP - sharp handles it fine, same cache format.
const IMAGE_MIRRORS = [
    name => `https://enka.network/ui/${name}.png`,
    name => `https://homdgcat.wiki/homdgcat-res/${name}.png`,
    name => `https://gi.yatta.moe/assets/UI/${name}.png`,
    name => `https://api.hakush.in/gi/UI/${name}.webp`,
];

// Builds the mirror URL chain from an existing image URL (any of the
// mirrors) by extracting its base file name. Returns [] for non-UI URLs,
// where the mirror naming scheme doesn't apply. Query strings/fragments
// (e.g. a CDN cache-busting "?v=123") are stripped first so they can't
// silently break the match.
function mirrorUrlsFor(imageUrl) {
    const clean = (imageUrl || '').split(/[?#]/)[0];
    const match = /\/(UI_[A-Za-z0-9_]+)\.(png|webp|jpg)$/i.exec(clean);
    return match ? IMAGE_MIRRORS.map(build => build(match[1])) : [];
}

function cachePath(key) {
    return path.join(CACHE_DIR, `${key}.jpg`);
}

function bufferToDataUrl(buffer) {
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

// Fetches one URL to a Buffer with timeout + retry. Kept from the old
// analyze-command.js implementation - it's the proven cold-path fetcher.
async function fetchBuffer(url, log, { timeoutMs = 15000, retries = 1 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': BROWSER_UA, 'Accept': 'image/*' },
            });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buffer = Buffer.from(await res.arrayBuffer());
            if (log) log(`Fetched image (${buffer.length} bytes, attempt ${attempt + 1}).`);
            return buffer;
        } catch (err) {
            clearTimeout(timer);
            if (attempt === retries) {
                console.error(`[image-cache] Fetch failed after ${retries + 1} attempts (${url}):`, err.message);
                if (log) log(`Image fetch failed after ${retries + 1} attempts: ${err.message}`);
                return null;
            }
            if (log) log(`Image fetch attempt ${attempt + 1} failed (${err.message}), retrying...`);
        }
    }
    return null;
}

// Resizes raw image bytes down to the thumbnail size and saves it into the
// cache. Returns the thumbnail Buffer, or null if sharp is missing or the
// bytes aren't processable - callers decide their own fallback then.
async function shrinkAndSave(key, originalBytes) {
    let sharp;
    try {
        sharp = require('sharp');
    } catch {
        console.error('[image-cache] sharp is not installed - cannot resize. Run: npm install sharp');
        return null;
    }
    try {
        const tiny = await sharp(originalBytes)
            .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
            .jpeg({ quality: JPEG_QUALITY })
            .toBuffer();
        await fs.promises.mkdir(CACHE_DIR, { recursive: true });
        await fs.promises.writeFile(cachePath(key), tiny);
        return tiny;
    } catch (err) {
        console.error(`[image-cache] Resize/save failed for ${key}:`, err.message);
        return null;
    }
}

// Core cold-path routine: try each candidate URL in order until one yields
// a cached thumbnail. Returns the thumbnail Buffer or null.
async function cacheThumbnail(key, urls, log) {
    for (const url of urls) {
        const original = await fetchBuffer(url, log);
        if (!original) continue;
        const tiny = await shrinkAndSave(key, original);
        if (tiny) {
            if (log) log(`Cached thumbnail for ${key} (${tiny.length} bytes) from ${new URL(url).hostname}.`);
            return tiny;
        }
        // Resize failed but the download worked - no point trying other
        // mirrors for the same unprocessable image; bail and let the caller
        // fall back to sending original bytes.
        return null;
    }
    return null;
}

// Core runtime API: returns the raw thumbnail Buffer for this character's
// splash art, serving from the local cache when possible. `key` should be
// the Enka avatarId. Returns null if nothing usable is cached or fetchable
// - deliberately no full-size fallback here; callers attaching this to a
// Discord message want the small cached thumbnail, never a multi-MB raw.
async function getCachedImageBuffer({ key, url, log }) {
    // Disk hit - the common case after first use or a prewarm run.
    try {
        return await fs.promises.readFile(cachePath(key));
    } catch { /* miss - normal */ }

    // Cold miss: derive the full mirror chain from the URL's file name so a
    // dead mirror (homdgcat) doesn't kill the fetch when the others are up.
    const urls = mirrorUrlsFor(url);
    return cacheThumbnail(key, urls, log);
}

// Vision-input variant of the above: same cache, but falls back to the
// uncached full-size image (base64 data URL) when no thumbnail could be
// built, since the model benefits from having something over nothing.
async function getCachedImageDataUrl({ key, url, log }) {
    const cached = await getCachedImageBuffer({ key, url, log });
    if (cached) return bufferToDataUrl(cached);

    // Couldn't build a thumbnail (no sharp, corrupt image, all mirrors down)
    // but we DO have original bytes from the first mirror? Send those raw -
    // same behavior as before this cache existed, just uncached.
    const urls = mirrorUrlsFor(url);
    if (urls.length > 0) {
        const original = await fetchBuffer(urls[0], log, { retries: 0 });
        if (original) {
            if (log) log(`Proceeding with full-size uncached image for ${key}.`);
            const contentType = original[0] === 0x89 ? 'image/png' : 'image/jpeg';
            return `data:${contentType};base64,${original.toString('base64')}`;
        }
    }

    if (log) log(`No usable image for ${key} (${url || 'no source'}) - proceeding without vision input.`);
    return null;
}

module.exports = { getCachedImageDataUrl, getCachedImageBuffer, cacheThumbnail, mirrorUrlsFor, IMAGE_MIRRORS, CACHE_DIR, TARGET_WIDTH, fetchBuffer };
