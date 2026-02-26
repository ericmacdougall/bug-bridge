#!/usr/bin/env node

/**
 * Generates placeholder PNG icons for the Bug Bridge Chrome extension.
 * Creates 16x16, 48x48, and 128x128 PNGs with "BB" text.
 *
 * Uses raw PNG generation (no dependencies) to create minimal valid PNGs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Creates a minimal PNG file buffer.
 * @param {number} width
 * @param {number} height
 * @param {function} pixelFn - (x, y) => [r, g, b, a]
 * @returns {Buffer}
 */
function createPNG(width, height, pixelFn) {
  // Build raw pixel data (filter byte + RGBA for each row)
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // Filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      rawData.push(r, g, b, a);
    }
  }

  const rawBuf = Buffer.from(rawData);
  const compressed = zlib.deflateSync(rawBuf);

  // Build chunks
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // IDAT
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Creates a PNG chunk with CRC.
 * @param {string} type - 4-char chunk type
 * @param {Buffer} data - Chunk data
 * @returns {Buffer}
 */
function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcInput);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/**
 * CRC32 calculation for PNG chunks.
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320;
      } else {
        crc >>>= 1;
      }
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Renders "BB" text at the given size.
 * @param {number} size - Icon size
 * @returns {function} Pixel function (x, y) => [r, g, b, a]
 */
function bbIcon(size) {
  // Background: dark blue (#1a1a2e)
  const bgR = 0x1a, bgG = 0x1a, bgB = 0x2e;
  // Text: green (#22c55e)
  const fgR = 0x22, fgG = 0xc5, fgB = 0x5e;

  // Simple bitmap font for "BB" — 5x7 per character
  const bitmapB = [
    '1111 ',
    '1   1',
    '1   1',
    '1111 ',
    '1   1',
    '1   1',
    '1111 '
  ];

  // Combine two B characters with a space
  const textBitmap = bitmapB.map((row, i) => row + ' ' + bitmapB[i]);
  const textWidth = textBitmap[0].length;
  const textHeight = textBitmap.length;

  // Scale text to fit icon (with padding)
  const padding = Math.max(1, Math.floor(size * 0.15));
  const availW = size - padding * 2;
  const availH = size - padding * 2;
  const scaleX = availW / textWidth;
  const scaleY = availH / textHeight;
  const scale = Math.floor(Math.min(scaleX, scaleY));

  const offsetX = Math.floor((size - textWidth * scale) / 2);
  const offsetY = Math.floor((size - textHeight * scale) / 2);

  return (x, y) => {
    // Border radius effect
    const cx = size / 2, cy = size / 2;
    const radius = size / 2;
    const cornerRadius = size * 0.2;
    const dx = Math.abs(x - cx + 0.5);
    const dy = Math.abs(y - cy + 0.5);
    const maxD = radius - cornerRadius;
    if (dx > maxD && dy > maxD) {
      const dist = Math.sqrt((dx - maxD) ** 2 + (dy - maxD) ** 2);
      if (dist > cornerRadius) return [0, 0, 0, 0];
    }

    // Check if pixel is in text
    const tx = Math.floor((x - offsetX) / scale);
    const ty = Math.floor((y - offsetY) / scale);

    if (tx >= 0 && tx < textWidth && ty >= 0 && ty < textHeight) {
      const row = textBitmap[ty];
      if (row && row[tx] && row[tx] !== ' ') {
        return [fgR, fgG, fgB, 255];
      }
    }

    return [bgR, bgG, bgB, 255];
  };
}

// Generate icons
const iconsDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

[16, 48, 128].forEach((size) => {
  const png = createPNG(size, size, bbIcon(size));
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Generated ${filePath} (${png.length} bytes)`);
});

console.log('Done!');
