import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const resourcesDir = path.join(rootDir, "resources");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO_SIGNATURE = Buffer.from([0x00, 0x00, 0x01, 0x00]);
const ICNS_SIGNATURE = Buffer.from("icns", "ascii");

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE), "PNG signature is missing");
  let offset = 8;
  let header = null;
  const idatChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9)
      };
    } else if (type === "IDAT") {
      idatChunks.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4;
  }
  assert.ok(header, "IHDR chunk not found");
  assert.equal(header.bitDepth, 8, "Only 8-bit channels are supported by this smoke decoder");
  assert.equal(header.colorType, 6, "Icon PNG must be truecolor with alpha (color type 6)");

  const { width, height } = header;
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[pos];
    pos += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const left = x >= bytesPerPixel ? out[y * stride + x - bytesPerPixel] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= bytesPerPixel && y > 0 ? out[(y - 1) * stride + x - bytesPerPixel] : 0;
      let recon;
      switch (filterType) {
        case 0: recon = value; break;
        case 1: recon = value + left; break;
        case 2: recon = value + up; break;
        case 3: recon = value + Math.floor((left + up) / 2); break;
        case 4: recon = value + paeth(left, up, upLeft); break;
        default: throw new Error(`Unsupported PNG filter type ${filterType}`);
      }
      out[y * stride + x] = recon & 0xff;
    }
    pos += stride;
  }

  return {
    width,
    height,
    alphaAt(x, y) {
      return out[(y * width + x) * bytesPerPixel + 3] ?? 0;
    }
  };
}

function alphaBounds(image, minimumAlpha = 16) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.alphaAt(x, y) < minimumAlpha) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  assert.ok(maxX >= minX && maxY >= minY, "Icon image should contain visible pixels");
  return {
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function decodeIcoPngFrames(buffer) {
  assert.ok(buffer.subarray(0, 4).equals(ICO_SIGNATURE), "ICO signature is missing");
  const count = buffer.readUInt16LE(4);
  const frames = new Map();
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const width = buffer[entryOffset] || 256;
    const height = buffer[entryOffset + 1] || 256;
    const length = buffer.readUInt32LE(entryOffset + 8);
    const imageOffset = buffer.readUInt32LE(entryOffset + 12);
    const image = buffer.subarray(imageOffset, imageOffset + length);
    assert.equal(width, height, `ICO ${width}px frame should be square`);
    assert.ok(image.subarray(0, 8).equals(PNG_SIGNATURE), `ICO ${width}px frame should use PNG encoding`);
    frames.set(width, decodePng(image));
  }
  return frames;
}

function decodeIcnsPngFrames(buffer) {
  assert.ok(buffer.subarray(0, 4).equals(ICNS_SIGNATURE), "ICNS signature is missing");
  assert.equal(buffer.readUInt32BE(4), buffer.length, "ICNS declared length should match the file");
  const frames = new Map();
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= buffer.length, `ICNS ${type} chunk should be bounded`);
    const image = buffer.subarray(offset + 8, offset + length);
    if (image.subarray(0, 8).equals(PNG_SIGNATURE)) frames.set(type, decodePng(image));
    offset += length;
  }
  return frames;
}

const png = decodePng(await readFile(path.join(resourcesDir, "jasmine-logo.png")));
assert.equal(png.width, 1024, "Icon PNG width should be 1024");
assert.equal(png.height, 1024, "Icon PNG height should be 1024");
assert.equal(png.alphaAt(0, 0), 0, "Icon PNG top-left corner should be transparent");
assert.ok(
  png.alphaAt(Math.floor(png.width / 2), Math.floor(png.height / 2)) > 200,
  "Icon PNG center should be opaque"
);
const pngBounds = alphaBounds(png);
const pngExtent = Math.max(pngBounds.width, pngBounds.height) / png.width;
assert.ok(pngExtent >= 0.84, `Icon artwork should use the canvas instead of rendering undersized (extent ${pngExtent.toFixed(3)})`);
assert.ok(pngExtent <= 0.94, `Icon artwork should retain a safe transparent margin (extent ${pngExtent.toFixed(3)})`);

for (const icoName of ["jasmine-logo.ico", "jasmine-logo-desktop.ico"]) {
  const ico = await readFile(path.join(resourcesDir, icoName));
  assert.ok(ico.length > 0, `${icoName} should not be empty`);
  const frames = decodeIcoPngFrames(ico);
  for (const requiredSize of [16, 24, 32, 48, 256]) {
    assert.ok(frames.has(requiredSize), `${icoName} should contain the Windows ${requiredSize}px target size`);
  }
  for (const taskbarSize of [24, 32]) {
    const frame = frames.get(taskbarSize);
    const bounds = alphaBounds(frame);
    const extent = Math.max(bounds.width, bounds.height) / taskbarSize;
    assert.ok(extent >= 0.87, `${icoName} ${taskbarSize}px artwork should fill its taskbar slot (extent ${extent.toFixed(3)})`);
  }
}

const icns = decodeIcnsPngFrames(await readFile(path.join(resourcesDir, "jasmine-logo.icns")));
const macFrame = icns.get("ic10");
assert.ok(macFrame, "macOS ICNS should contain a 1024px representation");
const macBounds = alphaBounds(macFrame);
const macExtent = Math.max(macBounds.width, macBounds.height) / macFrame.width;
assert.ok(macExtent >= 0.84, `macOS icon artwork should not render undersized in the Dock (extent ${macExtent.toFixed(3)})`);
assert.ok(macExtent <= 0.94, `macOS icon artwork should retain its safe margin (extent ${macExtent.toFixed(3)})`);

console.log("icon-assets-smoke: OK");
