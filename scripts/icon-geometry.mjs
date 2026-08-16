import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * Just enough PNG to measure our own icons: 8-bit, non-interlaced, either RGB
 * (colour type 2) or RGBA (colour type 6). Always returns RGBA, filling in an
 * opaque alpha for the RGB case. Deliberately dependency-free — this runs in
 * CI, and pulling `sharp` (a native binary an order of magnitude larger than
 * the files it would inspect) to read four numbers out of two images is a
 * poor trade.
 *
 * Both colour types are needed and the reason is the point of the whole
 * exercise: the `any` icons have transparent rounded corners, so they carry
 * an alpha channel, while a correct **maskable** icon is full-bleed opaque
 * and Chromium therefore writes it with no alpha channel at all. Supporting
 * only RGBA meant the generator crashed on its own correct output.
 *
 * It throws rather than coerces on any other PNG shape, because a decoder
 * that quietly mis-reads a format it does not support would make the checks
 * built on it worse than useless.
 */
export function decodePng(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${path}: not a PNG`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const hasAlpha = colorType === 6;
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(
      `${path}: expected 8-bit RGB or RGBA, non-interlaced (depth 8, colour type 2 or 6, ` +
        `interlace 0), got depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}`,
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = hasAlpha ? 4 : 3;
  const stride = width * bytesPerPixel;
  const filtered = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec §9.2).
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = raw.subarray(read, read + stride);
    read += stride;

    const cur = filtered.subarray(y * stride, (y + 1) * stride);
    const prev = y ? filtered.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);

    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? cur[x - bytesPerPixel] : 0;
      const b = prev[x];
      const c = x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0;
      let value = line[x];

      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = value & 0xff;
    }
  }

  if (hasAlpha) {
    return { width, height, pixels: filtered, hadAlphaChannel: true };
  }

  // Widen RGB to RGBA so callers have one shape to reason about. No alpha
  // channel means every pixel is opaque, which is precisely the property the
  // maskable check is looking for.
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0, o = 0; i < filtered.length; i += 3, o += 4) {
    pixels[o] = filtered[i];
    pixels[o + 1] = filtered[i + 1];
    pixels[o + 2] = filtered[i + 2];
    pixels[o + 3] = 255;
  }
  return { width, height, pixels, hadAlphaChannel: false };
}

/**
 * The fraction of the canvas an Android adaptive-icon mask is guaranteed to
 * keep: a centred circle of 80% diameter, so a 40% radius. Anything outside
 * it may be cropped, and which parts are cropped depends on the OEM's mask
 * (circle, squircle, rounded square, teardrop).
 *
 * The familiar "10% padding" shorthand is this same number read along an
 * axis, and it only holds for artwork that is widest on an axis. A glyph with
 * weight in the corners needs materially more inset, so measure rather than
 * assume.
 */
export const MASKABLE_SAFE_RADIUS_FRACTION = 0.4;

/**
 * Measures one icon: how far the light-coloured glyph reaches from the
 * centre, and whether the canvas is fully opaque.
 *
 * Both matter for a maskable icon and for different reasons. Content outside
 * the safe circle gets cropped; a transparent corner shows the launcher's own
 * background through, producing the "icon floating inside an icon" artefact
 * that maskable exists to remove.
 */
export function measureIcon(path) {
  const { width, height, pixels } = decodePng(path);
  const centreX = width / 2;
  const centreY = height / 2;

  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
  };

  let maxGlyphRadius = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      // The mark is a white glyph on emerald (#059669). Anything appreciably
      // lighter than the ground is glyph; the threshold is loose enough to
      // include antialiased edges, which is the conservative direction.
      if (a > 8 && r > 160 && g > 190 && b > 160) {
        const d = Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY);
        if (d > maxGlyphRadius) maxGlyphRadius = d;
      }
    }
  }

  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ].map(([x, y]) => at(x, y));

  return {
    width,
    height,
    maxGlyphRadius,
    glyphRadiusFraction: maxGlyphRadius / width,
    corners,
    transparentCorners: corners.filter(([, , , a]) => a < 255).length,
  };
}
