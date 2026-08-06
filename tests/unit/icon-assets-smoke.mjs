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

const png = decodePng(await readFile(path.join(resourcesDir, "jasmine-logo.png")));
assert.equal(png.width, 1024, "Icon PNG width should be 1024");
assert.equal(png.height, 1024, "Icon PNG height should be 1024");
assert.equal(png.alphaAt(0, 0), 0, "Icon PNG top-left corner should be transparent");
assert.ok(
  png.alphaAt(Math.floor(png.width / 2), Math.floor(png.height / 2)) > 200,
  "Icon PNG center should be opaque"
);

for (const icoName of ["jasmine-logo.ico", "jasmine-logo-desktop.ico"]) {
  const ico = await readFile(path.join(resourcesDir, icoName));
  assert.ok(ico.length > 0, `${icoName} should not be empty`);
  assert.ok(ico.subarray(0, 4).equals(ICO_SIGNATURE), `${icoName} should be a valid ICO file`);
}

console.log("icon-assets-smoke: OK");
