// DXGI_FORMAT values (the renderer's formats, gpu/rhi.h) -> WebGPU. Only those crashott-pc's
// renderer uses (xenos_renderer.cpp, texture_decode.cpp).

export interface FormatInfo {
  format: GPUTextureFormat;
  /** bytes per block and the block size (4x4 for BC) */
  bytes: number;
  block: number;
  depth?: boolean;
  stencil?: boolean;
  /** WebGPU feature it needs */
  feature?: GPUFeatureName;
}

const F = (format: GPUTextureFormat, bytes: number, extra: Partial<FormatInfo> = {}): FormatInfo => ({ format, bytes, block: 1, ...extra });
const BC = (format: GPUTextureFormat, bytes: number): FormatInfo => ({ format, bytes, block: 4, feature: 'texture-compression-bc' });

export const DXGI: Record<number, FormatInfo> = {
  2: F('rgba32float', 16),
  10: F('rgba16float', 8),
  11: F('rgba16unorm' as GPUTextureFormat, 8, { feature: 'texture-formats-tier1' as GPUFeatureName }),
  13: F('rgba16snorm' as GPUTextureFormat, 8, { feature: 'texture-formats-tier1' as GPUFeatureName }),
  16: F('rg32float', 8),
  20: F('depth32float-stencil8', 8, { depth: true, stencil: true, feature: 'depth32float-stencil8' }),
  24: F('rgb10a2unorm', 4),
  26: F('rg11b10ufloat', 4),
  28: F('rgba8unorm', 4),
  29: F('rgba8unorm-srgb', 4),
  31: F('rgba8snorm', 4),
  34: F('rg16float', 4),
  35: F('rg16unorm' as GPUTextureFormat, 4, { feature: 'texture-formats-tier1' as GPUFeatureName }),
  37: F('rg16snorm' as GPUTextureFormat, 4, { feature: 'texture-formats-tier1' as GPUFeatureName }),
  40: F('depth32float', 4, { depth: true }),
  41: F('r32float', 4),
  45: F('depth24plus-stencil8', 4, { depth: true, stencil: true }),
  49: F('rg8unorm', 2),
  51: F('rg8snorm', 2),
  54: F('r16float', 2),
  56: F('r16unorm' as GPUTextureFormat, 2, { feature: 'texture-formats-tier1' as GPUFeatureName }),
  58: F('r16snorm' as GPUTextureFormat, 2, { feature: 'texture-formats-tier1' as GPUFeatureName }),
  61: F('r8unorm', 1),
  63: F('r8snorm', 1),
  71: BC('bc1-rgba-unorm', 8), 72: BC('bc1-rgba-unorm-srgb', 8),
  74: BC('bc2-rgba-unorm', 16), 75: BC('bc2-rgba-unorm-srgb', 16),
  77: BC('bc3-rgba-unorm', 16), 78: BC('bc3-rgba-unorm-srgb', 16),
  80: BC('bc4-r-unorm', 8), 81: BC('bc4-r-snorm', 8),
  83: BC('bc5-rg-unorm', 16), 84: BC('bc5-rg-snorm', 16),
  87: F('bgra8unorm', 4),
  91: F('bgra8unorm-srgb', 4),
};

/** The format to use on this device (a missing feature falls back to a format of the same size). */
export function formatOf(dxgi: number, features: ReadonlySet<string>): FormatInfo | null {
  const info = DXGI[dxgi];
  if (!info) return null;
  if (info.feature && !features.has(info.feature)) {
    if (info.depth) return DXGI[45];                 // D32S8 -> D24S8
    if (info.bytes === 2 && info.block === 1) return F('r16float', 2);
    if (info.bytes === 4 && info.block === 1) return F('rg16float', 4);
    if (info.bytes === 8 && info.block === 1) return F('rgba16float', 8);
    return null;
  }
  return info;
}
