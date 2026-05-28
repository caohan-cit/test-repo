'use strict';

const { createCanvas } = require('canvas');
const sharp = require('sharp');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MultiFormatReader,
  BinaryBitmap,
  HybridBinarizer,
  HTMLCanvasElementLuminanceSource,
  DecodeHintType,
  NotFoundException,
  BarcodeFormat,
} = require('@zxing/library');

const MAX_CODES = 10;
const MASK_PADDING_PX = 10;
const TILE_SOURCE_PX = 400;
const TILE_OVERLAP_PX = 80;

// Rotations tried on the full image.
// ZXing TRY_HARDER does not reliably detect upside-down barcodes,
// so we rotate the image explicitly instead.
// IMPORTANT: landscape rotations (0 deg, 180 deg) must be tried before portrait rotations
// (90 deg, 270 deg). Processing a portrait-dimensioned canvas before a landscape one
// corrupts ZXing/HybridBinarizer state and causes subsequent landscape scans to miss codes.
const ROTATIONS = [0, 180, 90, 270];

// Fraction of image width to trim from the left in the inverted edge-trim pass.
// Handles barcodes where the left edge is obscured (e.g. by plastic wrapping),
// causing the start pattern to be unreadable from the normal left-to-right direction.
const INVERT_LEFT_TRIM = 0.20;

class InvalidImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidImageError';
  }
}

/**
 * Decode all barcodes/QR codes found in an image buffer.
 *
 * Strategy 1 - Full image, four rotations (landscape before portrait):
 *   Handles barcodes at any orientation (including upside-down labels).
 *
 * Strategy 2 - Inverted image, 0 deg and 180 deg, with optional left-edge trim:
 *   Handles white-on-black barcodes (inverted contrast). The left-trim pass
 *   additionally handles barcodes whose start pattern is obscured at the left
 *   edge (e.g. by plastic wrapping); trimming reveals the intact interior start.
 *
 * Strategy 3 - Tiled 2x upscale, 0 deg only (run only when Strategies 1+2 find nothing):
 *   Handles small codes scattered across large photos (e.g. iPhone shots).
 *   QR codes are rotationally symmetric so one rotation suffices.
 *
 * @param {Buffer} imageBuffer - Raw image bytes (JPG, PNG, etc.)
 * @returns {Promise<Array<{text: string, format: string, duration_ms: number}>>}
 *   duration_ms is the ZXing decode time per result, excluding preprocessing.
 */
async function scanImage(imageBuffer) {
  let meta;
  try {
    meta = await sharp(imageBuffer).metadata();
  } catch (err) {
    throw new InvalidImageError('Invalid or unsupported image format');
  }

  // Resize to max 1200px on the longest side before any processing.
  // Mobile camera crops can be large; this makes every subsequent sharp operation
  // significantly faster without losing barcode readability.
  const MAX_DIM = 1200;
  if (meta.width > MAX_DIM || meta.height > MAX_DIM) {
    imageBuffer = await sharp(imageBuffer)
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    meta = await sharp(imageBuffer).metadata();
  }

  // Convert to grayscale. Removes colour noise and improves HybridBinarizer contrast.
  // Must encode as PNG first: calling .grayscale().raw() produces 1-channel data which
  // is incompatible with buildCanvas (expects 4-channel RGBA). Saving as PNG and
  // re-reading causes sharp to output proper 4-channel data via .ensureAlpha().raw().
  imageBuffer = await sharp(imageBuffer).grayscale().png().toBuffer();

  const isLargeImage = meta.width > 2000 || meta.height > 2000;

  const seen = new Set();
  const results = [];

  function addUnique(newResults) {
    for (const r of newResults) {
      const key = `${r.format}:${r.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(r);
      }
    }
  }

  // Strategy 0: far-right inverted strip scan, run FIRST with completely clean ZXing state.
  // Handles barcodes on the rightmost portion of an image where adjacent content to the left
  // (e.g. the white side of a neighbouring box) confuses HybridBinarizer when included in
  // the strip. Starting at 62% of image width removes the confusing left region entirely.
  // Must run before Strategy 1 to preserve the cleanest possible ZXing state for this pass.
  // Only applies to non-large images with rotW <= 2000px (same constraint as Strategy 1.5 pass-b/c).
  if (!isLargeImage && meta.width <= 2000) {
    const rotW = meta.width, rotH = meta.height;
    const INV_STRIP_W = Math.floor(rotW * 0.38);
    const INV_STEP_X = Math.floor(INV_STRIP_W * 0.50);
    const INV_X_START = Math.floor(rotW * 0.62);
    const INV_STRIP_H = 120, INV_STRIP_STEP_Y = 60;
    for (let tx = INV_X_START; tx + INV_STRIP_W <= rotW; tx += INV_STEP_X) {
      for (let ty = 0; ty + 30 <= rotH; ty += INV_STRIP_STEP_Y) {
        const h = Math.min(INV_STRIP_H, rotH - ty);
        if (h < 30) break;
        try {
          const { data, info } = await sharp(imageBuffer)
            .extract({ left: tx, top: ty, width: INV_STRIP_W, height: h })
            .negate({ alpha: false })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          addUnique(decodeCanvasSingle(buildCanvas(data, info.width, info.height), createReader()));
        } catch (err) {
          if (err instanceof InvalidImageError) throw err;
        }
      }
    }
  }

  // Strategy 1: full image at 0 deg, 180 deg, 90 deg, 270 deg (landscape first).
  // A fresh reader is used for each rotation because MultiFormatReader accumulates
  // state across decode() calls; reusing it across different canvases causes missed detections.
  for (const angle of ROTATIONS) {
    try {
      const { data, info } = await sharp(imageBuffer)
        .rotate(angle)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      addUnique(decodeCanvas(buildCanvas(data, info.width, info.height), info.width, info.height, createReader()));
    } catch (err) {
      if (err instanceof InvalidImageError) throw err;
    }
  }

  // Record how many codes Strategy 1 found (before inverted passes).
  // Used to decide whether tile strategies should run even after finding codes:
  // if Strategy 1 found codes, additional barcodes (inverted or different scale) may exist.
  // if Strategy 1 found nothing, the image's primary code is inverted; tile strategies
  // are not expected to find additional non-inverted codes and would waste time.
  const strategy1Count = results.length;

  // Strategy 1.5: inverted horizontal strip scan at all four rotations, run BEFORE full-image
  // inverted passes.
  // A full-image inverted pass (Strategy 2) finds the most prominent barcode (UPC_A) but
  // leaves ZXing in a state where less prominent barcodes (CODE_128) are no longer detectable.
  // Running narrow inverted strips HERE — after Strategy 1 has "primed" ZXing state positively
  // but before Strategy 2 corrupts it — allows finding additional white-on-black barcodes.
  //
  // Two x-trim passes per angle:
  //   a) 5% left trim: covers left/center barcodes.
  //   b) 52% left trim: starts at the right half, covers barcodes whose start pattern
  //      is only within the right half of the image (e.g. two side-by-side boxes where
  //      the right box's CODE_128 start pattern is unreachable from a left-anchored strip).
  // Strip width = 50% of rotated image width; step = 40% of strip width for denser coverage.
  // y-step = 40px instead of 60px for better vertical coverage.
  // All four rotations are tried (landscape first to preserve ZXing state).
  // Skipped for large images (width or height > 2000px): a 5712×4284 image generates 668+
  // strip crops causing 60+ second runtimes; Strategy 3 tile scanning already covers those.
  // Strategy 1.5 relies on Strategy 1 having "primed" ZXing state with at least one
  // normal code. When Strategy 1 found nothing the state is unprimed and the strip scan
  // is both slow and ineffective — skip it and let Strategy 2 (full inverted image) run
  // directly instead. Strategy 2 finds inverted codes in a single sharp+decode pass.
  if (!isLargeImage && results.length > 0) strategy15: for (const angle of [0, 180, 90, 270]) {
    const rotW = (angle === 90 || angle === 270) ? meta.height : meta.width;
    const rotH = (angle === 90 || angle === 270) ? meta.width : meta.height;
    const INV_STRIP_H = 120;
    const INV_STRIP_STEP_Y = 60;

    // Pass a: 5% left trim, 50%-wide strips — covers left/centre barcodes.
    // Pass b: 53% left trim, 43%-wide strips — starts in the right half; covers barcodes
    //   whose start pattern is only reachable from the right half of the image
    //   (e.g. two side-by-side boxes where the right box's CODE_128 start pattern
    //   is obscured when the strip spans both boxes).
    //   Only run pass b for smaller images (rotW <= 2000px) to avoid excessive processing
    //   of high-resolution photos where this case does not arise.
    // Pass c: 62% left trim, 38%-wide strips — further right trim; handles cases where
    //   two side-by-side boxes leave a large white region at x=53%-62% that confuses
    //   HybridBinarizer when the target barcode only occupies the rightmost 38%.
    //   Only run for smaller images (rotW <= 2000px).
    // For smaller images (rotW <= 2000px), add right-half passes BEFORE the normal 5%-trim
    // pass. Running them first gives clean ZXing state (only primed by Strategy 1's
    // non-inverted barcodes). The normal left-anchored pass runs last; if it finds UPC_A
    // first it may corrupt state for subsequent passes, but by then the right-half passes
    // have already found any right-side barcodes.
    const xTrimPasses = rotW <= 2000
      ? [[0.53, 0.43], [0.05, 0.50]]
      : [[0.05, 0.50]];
    for (const [xTrimFrac, stripFrac] of xTrimPasses) {
      const INV_STRIP_W = Math.floor(rotW * stripFrac);
      const INV_STEP_X = Math.floor(INV_STRIP_W * 0.50);
      const INV_X_START = Math.floor(rotW * xTrimFrac);
      for (let tx = INV_X_START; tx + INV_STRIP_W <= rotW; tx += INV_STEP_X) {
        for (let ty = 0; ty + 30 <= rotH; ty += INV_STRIP_STEP_Y) {
          const h = Math.min(INV_STRIP_H, rotH - ty);
          if (h < 30) break;
          try {
            const { data, info } = await sharp(imageBuffer)
              .rotate(angle)
              .extract({ left: tx, top: ty, width: INV_STRIP_W, height: h })
              .negate({ alpha: false })
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            addUnique(decodeCanvas(buildCanvas(data, info.width, info.height), info.width, info.height, createReader()));
          } catch (err) {
            if (err instanceof InvalidImageError) throw err;
          }
        }
      }
    }
  }

  // Strategy 2: inverted image (handles white-on-black barcodes) at all four rotations.
  // Two passes per angle:
  //   a) full width - catches cleanly-printed inverted codes
  //   b) 20% left-trim - catches codes whose start pattern is obscured at the left
  //      edge (e.g. by plastic wrapping); trimming reveals the intact interior start.
  // All four rotations needed because white-on-black barcodes may also be physically
  // rotated 90° in the photo (e.g. contact lens boxes photographed in portrait).
  // Landscape angles (0, 180) tried before portrait (90, 270) to preserve ZXing state.
  for (const angle of [0, 180, 90, 270]) {
    for (const leftTrim of [0, INVERT_LEFT_TRIM]) {
      try {
        let pipeline = sharp(imageBuffer).rotate(angle);
        if (leftTrim > 0) {
          const trimmedW = Math.floor(meta.width * (1 - leftTrim));
          pipeline = pipeline.extract({
            left: Math.floor(meta.width * leftTrim),
            top: 0,
            width: trimmedW,
            height: meta.height,
          });
        }
        const { data, info } = await pipeline
          .negate({ alpha: false })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        addUnique(decodeCanvas(buildCanvas(data, info.width, info.height), info.width, info.height, createReader()));
      } catch (err) {
        if (err instanceof InvalidImageError) throw err;
      }
    }
  }

  // Early exit when tile strategies are unlikely to help:
  // - Large images: tile strategies are slow and Strategy 1+2 already found codes.
  // - Strategy 1 found nothing (strategy1Count == 0): the primary barcode is inverted
  //   (found by Strategy 2); normal tile strategies won't find additional codes and
  //   would waste 80+ seconds on small images like test1.png.
  // Continue to tile strategies only when Strategy 1 found at least one code (meaning
  // there may be additional barcodes at different scales or positions).
  if (results.length > 0 && (isLargeImage || strategy1Count === 0)) return results;

  // Strategy 2.5: fresh full-image re-scan at 0 deg with clean ZXing state.
  // If Strategy 1 found at least one code but fewer than MAX_CODES, ZXing may have
  // been left in a degraded state (accumulated internal buffers, binarizer artefacts).
  // A second pass with a brand-new reader and a freshly-decoded canvas gives the
  // full image another chance to surface codes that were missed the first time.
  // addUnique() prevents duplicates; decodeCanvas masking prevents re-detecting
  // the same spatial region within this pass.
  if (results.length > 0 && results.length < MAX_CODES) {
    try {
      const { data, info } = await sharp(imageBuffer)
        .rotate(0)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      addUnique(decodeCanvas(buildCanvas(data, info.width, info.height), info.width, info.height, createReader()));
    } catch (err) {
      if (err instanceof InvalidImageError) throw err;
    }
  }

  // Record state after Strategies 1+2 — used to gate Strategy 6.
  // If Strategies 1+2 found standard 1D barcodes (UPC/EAN/CODE_128) but no DataMatrix,
  // the image geometry is normal and the affine shear sweep is very unlikely to help.
  // Only run Strategy 6 when nothing was found yet, OR when the codes found so far include
  // DataMatrix (suggesting a product label where some distorted DataMatrix codes may remain).
  const resultsAfterStr12 = results.slice();
  const hasOnlyNonMatrixCodes = resultsAfterStr12.length > 0 &&
    resultsAfterStr12.every(r => r.format !== 'DATA_MATRIX' && r.format !== 'QR_CODE' && r.format !== 'AZTEC');

  // Strategy 3: tiled 2x upscale at 0 deg.
  // For small images (<=20 tiles) always runs — handles screenshots or composite images
  // that contain multiple barcodes at different scales (e.g. a small barcode alongside
  // a large one that Strategy 1 already found).
  // For large images (>20 tiles, e.g. iPhone photos) only runs when nothing was found yet,
  // to avoid the significant processing time of tiling a multi-megapixel image.
  if (meta.width > TILE_SOURCE_PX || meta.height > TILE_SOURCE_PX) {
    const step = TILE_SOURCE_PX - TILE_OVERLAP_PX;
    const totalTiles = Math.ceil(meta.width / step) * Math.ceil(meta.height / step);
    const shouldTile = results.length < MAX_CODES;

    if (shouldTile) {
      for (let ty = 0; ty < meta.height; ty += step) {
        for (let tx = 0; tx < meta.width; tx += step) {
          const cropW = Math.min(TILE_SOURCE_PX, meta.width - tx);
          const cropH = Math.min(TILE_SOURCE_PX, meta.height - ty);
          if (cropW < 30 || cropH < 30) continue;

          try {
            const { data, info } = await sharp(imageBuffer)
              .extract({ left: tx, top: ty, width: cropW, height: cropH })
              .resize(cropW * 2, cropH * 2)
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            addUnique(decodeCanvas(buildCanvas(data, info.width, info.height), info.width, info.height, createReader()));
          } catch (_) { /* skip bad tiles */ }
        }
      }
    }
  }

  // Strategy 4: horizontal strip scan at 2x upscale, for small images only (W and H <= 1500px).
  // Runs after Strategy 1 has primed ZXing state. Handles barcodes embedded in screenshots
  // or composite images where a small barcode coexists with larger UI elements. Narrow strips
  // (150px tall) keep each strip focused on one barcode row at a time; the 10% inner margin
  // trims window chrome that would otherwise confuse ZXing's binarizer.
  if (meta.width <= 1500 && meta.height <= 1500) {
    const STRIP_H = 150;
    const STRIP_STEP = 75;
    const INNER_MARGIN = Math.floor(meta.width * 0.10);
    const stripW = meta.width - INNER_MARGIN * 2;

    if (stripW >= 30) {
      for (let ty = 0; ty + 30 <= meta.height; ty += STRIP_STEP) {
        const h = Math.min(STRIP_H, meta.height - ty);
        if (h < 30) break;

        try {
          const { data, info } = await sharp(imageBuffer)
            .extract({ left: INNER_MARGIN, top: ty, width: stripW, height: h })
            .resize(stripW * 2, h * 2)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          addUnique(decodeCanvas(buildCanvas(data, info.width, info.height), info.width, info.height, createReader()));
        } catch (_) { /* skip bad strips */ }
      }
    }
  }

  // Strategy 5: multi-scale small-tile upscale, for images with tiny QR/DataMatrix codes.
  // Two passes at different tile/scale combinations to cover a wider range of code densities:
  //   Pass A: 160×160 tiles at 4× zoom — catches medium-small codes.
  //   Pass B: 100×100 tiles at 6× zoom — catches very small codes (e.g. DataMatrix on product boxes).
  // Only runs when codes are still missing to avoid redundant work.
  // Skipped for large images (width or height > 2000px): Strategy 3's 400px tiles already cover
  // them, and the small tile passes would generate 1000s of crops causing multi-minute runtimes.
  if (results.length < MAX_CODES && !isLargeImage) {
    for (const [SMALL_TILE_PX, SMALL_TILE_OVERLAP_PX, SMALL_TILE_SCALE] of [
      [160, 40, 4],
      [100, 25, 6],
    ]) {
      const smallStep = SMALL_TILE_PX - SMALL_TILE_OVERLAP_PX;

      for (let ty = 0; ty < meta.height; ty += smallStep) {
        for (let tx = 0; tx < meta.width; tx += smallStep) {
          const cropW = Math.min(SMALL_TILE_PX, meta.width - tx);
          const cropH = Math.min(SMALL_TILE_PX, meta.height - ty);
          if (cropW < 20 || cropH < 20) continue;

          try {
            const { data, info } = await sharp(imageBuffer)
              .extract({ left: tx, top: ty, width: cropW, height: cropH })
              .resize(cropW * SMALL_TILE_SCALE, cropH * SMALL_TILE_SCALE)
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            addUnique(decodeCanvas(buildCanvas(data, info.width, info.height), info.width, info.height, createReader()));
          } catch (_) { /* skip bad tiles */ }
        }
      }
    }
  }

  // Strategy 6: affine shear sweep for perspective-distorted codes, run in isolated worker threads.
  // Handles barcodes on angled surfaces (e.g. product boxes on a shelf viewed from the side).
  // ZXing assumes near-rectangular codes; shearing the image corrects the parallelogram distortion
  // caused by the camera angle, making otherwise-undecodable codes readable.
  //
  // CRITICAL: @zxing/library has global static state that accumulates across MultiFormatReader
  // instances and decode() calls. After Strategies 1-5 run, this state prevents the shear tile
  // scan from finding codes it would find in a clean process. Each shear is therefore run in a
  // separate worker_thread, which has its own isolated module registry (fresh ZXing state).
  //
  // Only runs on small images (width and height <= 1500px) when codes are still missing.
  //
  // Shear pairs cover the four quadrants of typical box-face distortion:
  //   negative shx = box leans left (as viewed by camera)
  //   positive shy = bottom of box further away (viewed from above)
  // [-0.1, 0.3] is placed first: it is the broadest combo and covers the most common
  // perspective distortion patterns (boxes on a shelf, viewed slightly from above and the side).
  // Running it first ensures it gets clean ZXing state within the worker.
  const SHEAR_COMBOS = [
    [-0.1, 0.3], [-0.1, -0.3],
    [-0.2, 0.2], [0.2, 0.2],
    [-0.3, 0.1], [0.3, 0.1],
  ];

  if (meta.width <= 1500 && meta.height <= 1500 && !hasOnlyNonMatrixCodes) {
    // Run all shear combos in a child process (child_process.fork) so that native addons
    // (sharp, canvas) load fresh without conflict with the parent's already-loaded modules.
    // worker_threads with eval:true cannot load canvas.node after the parent process has
    // already loaded it. A forked child process has a completely separate address space.
    // Write image to a temp file so the child process can read it directly (avoids JSON
    // serialization of large binary buffers over IPC which is very slow).
    const tmpPath = path.join(os.tmpdir(), `zxing-shear-${process.pid}-${Date.now()}.bin`);
    fs.writeFileSync(tmpPath, imageBuffer);
    const shearResults = await new Promise((resolve) => {
      const child = fork(require.resolve('./shear-worker'), [], { silent: true });
      child.once('message', ({ found }) => { child.kill(); resolve(found || []); });
      child.once('error', () => { child.kill(); resolve([]); });
      child.once('exit', (code) => { if (code !== 0) resolve([]); });
      child.send({ imagePath: tmpPath, shearCombos: SHEAR_COMBOS, maxCodes: MAX_CODES });
    }).finally(() => { try { fs.unlinkSync(tmpPath); } catch (_) {} });
    addUnique(shearResults);
  }

  return results;
}

// --- Helpers ---

function createReader() {
  const hints = new Map();
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  return reader;
}

/**
 * Single-shot decode using decodeWithState (preserves hints without resetting reader internals).
 * Strategy 0 uses this instead of decodeCanvas because reader.decode() resets internal ZXing
 * state on each call in a way that causes false negatives when called sequentially across many
 * empty strips. decodeWithState avoids that reset while still honouring TRY_HARDER.
 */
function decodeCanvasSingle(canvas, reader) {
  try {
    const luminanceSource = new HTMLCanvasElementLuminanceSource(canvas);
    const bitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
    const result = reader.decodeWithState(bitmap);
    return [{ text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()], duration_ms: 0 }];
  } catch (e) {
    if (e instanceof NotFoundException) return [];
    throw e;
  }
}

function buildCanvas(data, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  // sharp returns a Node.js Buffer; canvas imageData.data expects Uint8ClampedArray.
  // Passing the Buffer directly loses the byteOffset, resulting in silent pixel corruption.
  imageData.data.set(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength));
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Run the masking decode loop on a canvas.
 * After each find, paint the found region white so the next pass finds a different code.
 * No deduplication needed - masking prevents re-detection of the same spatial region.
 */
function decodeCanvas(canvas, width, height, reader) {
  const ctx = canvas.getContext('2d');
  const results = [];

  for (let attempt = 0; attempt < MAX_CODES; attempt++) {
    try {
      const luminanceSource = new HTMLCanvasElementLuminanceSource(canvas);
      const bitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
      const decodeStart = Date.now();
      const result = reader.decode(bitmap);

      results.push({
        text: result.getText(),
        format: BarcodeFormat[result.getBarcodeFormat()],
        duration_ms: Date.now() - decodeStart,
      });

      const points = result.getResultPoints();
      if (points && points.length >= 2) {
        const xs = points.map(p => p.getX());
        const ys = points.map(p => p.getY());
        const minX = Math.max(0, Math.floor(Math.min(...xs)) - MASK_PADDING_PX);
        const minY = Math.max(0, Math.floor(Math.min(...ys)) - MASK_PADDING_PX);
        const maxX = Math.min(width, Math.ceil(Math.max(...xs)) + MASK_PADDING_PX);
        const maxY = Math.min(height, Math.ceil(Math.max(...ys)) + MASK_PADDING_PX);
        ctx.fillStyle = 'white';
        ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
      } else if (points && points.length === 1) {
        const y = points[0].getY();
        const minY = Math.max(0, Math.floor(y) - MASK_PADDING_PX);
        const maxY = Math.min(height, Math.ceil(y) + MASK_PADDING_PX);
        ctx.fillStyle = 'white';
        ctx.fillRect(0, minY, width, maxY - minY);
      } else {
        break;
      }
    } catch (e) {
      if (e instanceof NotFoundException) break;
      throw e;
    }
  }

  return results;
}

module.exports = { scanImage, InvalidImageError };
