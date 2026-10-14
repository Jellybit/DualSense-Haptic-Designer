// CRC-32 (IEEE, reflected, poly 0xEDB88320) as used by DualSense Bluetooth reports.
// Bluetooth output/feature reports are checksummed over a 1-byte "seed" prefix
// (0xA2 for output, 0xA3 for feature-get, 0xA1 for input) followed by the report bytes
// starting at the report ID.

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32Update(crc: number, data: ArrayLike<number>, start = 0, end = data.length): number {
  let c = crc
  for (let i = start; i < end; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return c >>> 0
}

/** CRC-32 of `[seed, ...data[start..end)]`. */
export function crc32Seeded(seed: number, data: ArrayLike<number>, start = 0, end = data.length): number {
  let c = crc32Update(0xffffffff, [seed])
  c = crc32Update(c, data, start, end)
  return (c ^ 0xffffffff) >>> 0
}

export function crc32(data: ArrayLike<number>): number {
  return (crc32Update(0xffffffff, data) ^ 0xffffffff) >>> 0
}
