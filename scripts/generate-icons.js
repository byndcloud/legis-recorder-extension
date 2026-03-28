#!/usr/bin/env node
/**
 * Gera ícones PNG para a extensão Legis - Gravador de Fluxos.
 * Cria um ícone com fundo arredondado azul da marca (#2A4DDD)
 * e um círculo de gravação branco no centro.
 *
 * Uso: node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// =========================================================================
// CRC32
// =========================================================================

let crcTable = null;

function makeCRCTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}

function crc32(buf) {
  if (!crcTable) crcTable = makeCRCTable();
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([lenBuf, typeAndData, crcBuf]);
}

// =========================================================================
// Geração do ícone
// =========================================================================

function createIconPNG(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawData = [];
  const center = size / 2;
  const bgRadius = size * 0.46;      // Raio do fundo arredondado
  const recRadius = size * 0.22;     // Raio do círculo de gravação
  const borderSoftness = 1.5;

  // Cores da marca
  const bgR = 42, bgG = 77, bgB = 221;   // #2A4DDD (azul)
  const recR = 255, recG = 255, recB = 255; // branco

  for (let y = 0; y < size; y++) {
    rawData.push(0); // filtro None
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= recRadius) {
        // Círculo de gravação branco (centro)
        rawData.push(recR, recG, recB, 255);
      } else if (dist <= recRadius + borderSoftness) {
        // Transição suave do rec para o fundo
        const t = (dist - recRadius) / borderSoftness;
        rawData.push(
          Math.round(recR + (bgR - recR) * t),
          Math.round(recG + (bgG - recG) * t),
          Math.round(recB + (bgB - recB) * t),
          255
        );
      } else if (dist <= bgRadius - borderSoftness) {
        // Fundo azul
        rawData.push(bgR, bgG, bgB, 255);
      } else if (dist <= bgRadius) {
        // Borda suave do fundo para transparente
        const alpha = Math.max(0, 1 - (dist - (bgRadius - borderSoftness)) / borderSoftness);
        rawData.push(bgR, bgG, bgB, Math.round(alpha * 255));
      } else {
        // Transparente
        rawData.push(0, 0, 0, 0);
      }
    }
  }

  const compressed = zlib.deflateSync(Buffer.from(rawData), { level: 9 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// =========================================================================
// Gerar ícones
// =========================================================================

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach(size => {
  const png = createIconPNG(size);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`[Legis] Ícone ${size}x${size} gerado: ${filePath} (${png.length} bytes)`);
});

console.log('\n[Legis] Todos os ícones gerados com sucesso!');
