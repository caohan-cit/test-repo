'use strict';
// Shear sweep worker — run via child_process.fork() from scanner.js.
// Receives { imageBuf, shearCombos } via process.send(), returns { found } back.
const sharp = require('sharp');
const { createCanvas } = require('canvas');
const {
  MultiFormatReader, BinaryBitmap, HybridBinarizer,
  HTMLCanvasElementLuminanceSource, DecodeHintType, BarcodeFormat, NotFoundException,
} = require('@zxing/library');

function createReader() {
  const hints = new Map();
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  return reader;
}

process.once('message', async ({ imagePath, shearCombos, maxCodes }) => {
  const imageBuffer = require('fs').readFileSync(imagePath);
  const TILE_PX = 120, SCALE = 6;
  const MAX = maxCodes || 10;
  const found = [];
  const seen = new Set();

  for (let ci = 0; ci < shearCombos.length; ci++) {
    if (found.length >= MAX) break;
    const [shx, shy] = shearCombos[ci];
    // First combo gets fine step (40) for maximum coverage; subsequent combos use coarser step (60)
    // since they are complementary fallbacks and finer coverage would take too long.
    const TILE_STEP = ci === 0 ? 40 : 60;
    let shearedBuf;
    try {
      shearedBuf = await sharp(imageBuffer)
        .affine([[1, shx], [shy, 1]], { background: { r: 128, g: 128, b: 128 } })
        .toBuffer();
    } catch (_) { continue; }
    const shearedMeta = await sharp(shearedBuf).metadata();

    for (let ty = 0; ty < shearedMeta.height; ty += TILE_STEP) {
      for (let tx = 0; tx < shearedMeta.width; tx += TILE_STEP) {
        const cropW = Math.min(TILE_PX, shearedMeta.width - tx);
        const cropH = Math.min(TILE_PX, shearedMeta.height - ty);
        if (cropW < 20 || cropH < 20) continue;
        try {
          const { data, info } = await sharp(shearedBuf)
            .extract({ left: tx, top: ty, width: cropW, height: cropH })
            .resize(cropW * SCALE, cropH * SCALE)
            .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          const canvas = createCanvas(info.width, info.height);
          const ctx = canvas.getContext('2d');
          const imageData = ctx.createImageData(info.width, info.height);
          imageData.data.set(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength));
          ctx.putImageData(imageData, 0, 0);
          const reader = createReader();
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              const result = reader.decode(new BinaryBitmap(new HybridBinarizer(new HTMLCanvasElementLuminanceSource(canvas))));
              const text = result.getText();
              const format = BarcodeFormat[result.getBarcodeFormat()];
              const key = format + ':' + text;
              if (!seen.has(key)) {
                seen.add(key);
                found.push({ text, format, duration_ms: 0 });
              }
            } catch (e) {
              if (e instanceof NotFoundException) break;
            }
          }
        } catch (_) {}
      }
    }
  }
  process.send({ found });
});
