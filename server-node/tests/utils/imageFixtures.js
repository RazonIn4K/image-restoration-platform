import sharp from 'sharp';

const DEFAULT_SIZE = { width: 128, height: 128 };

async function createBaseImage({ width = DEFAULT_SIZE.width, height = DEFAULT_SIZE.height, color = { r: 180, g: 180, b: 180 } } = {}) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  }).jpeg({ quality: 95 }).toBuffer();
}

export async function createBlurredImage(options = {}) {
  const base = await createBaseImage(options);
  return sharp(base).blur(4).jpeg({ quality: 60 }).toBuffer();
}

export async function createNoisyImage({ width = DEFAULT_SIZE.width, height = DEFAULT_SIZE.height } = {}) {
  const channels = 3;
  const data = new Uint8ClampedArray(width * height * channels);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.floor(Math.random() * 256);
  }

  return sharp(Buffer.from(data), {
    raw: {
      width,
      height,
      channels,
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export async function createDarkImage(options = {}) {
  return createBaseImage({ ...options, color: { r: 10, g: 10, b: 10 } });
}

export async function createColorShiftedImage(options = {}) {
  return createBaseImage({ ...options, color: { r: 220, g: 80, b: 40 } });
}

export async function createCompressedImage(options = {}) {
  const base = await createBaseImage(options);
  // Re-encode with very low quality to amplify blocking artifacts
  return sharp(base).jpeg({ quality: 15 }).toBuffer();
}

export async function createScratchedImage({ width = DEFAULT_SIZE.width, height = DEFAULT_SIZE.height } = {}) {
  const base = await createBaseImage();
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const distanceFromLine = Math.abs(x - width / 2 + y * 0.1);
      if (distanceFromLine < 1) {
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        data[offset + 3] = 255;
      } else {
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        data[offset + 3] = 0;
      }
    }
  }

  const line = await sharp(Buffer.from(data), {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();

  return sharp(base)
    .composite([{ input: line, blend: 'overlay' }])
    .jpeg({ quality: 80 })
    .toBuffer();
}

export async function createCleanImage(options = {}) {
  return createBaseImage(options);
}
