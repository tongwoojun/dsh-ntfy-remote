// QR Code 编码器：把一段文本编码成模块矩阵，并可渲染成自包含 SVG。
//
// 纯函数、零依赖、不碰宿主。固定三件事，换取实现足够小：
//   · **字节模式**（UTF-8）——深链接里可能有非 ASCII 的自建域名；
//   · **纠错等级 M**（约 15% 冗余）——二维码贴在屏幕上给人扫，不需要 H 的抗污损；
//   · **版本 1–10 自动选择**——纠错等级 M + 字节模式下最多 213 字节，而
//     `ntfy://<host>/<topic>` 实测远小于此；超出返回 null，由调用方决定怎么报错。
//
// 掩码不写死：8 个掩码各算一遍惩罚分（规范里的四条规则），取最低分那个。
//
// 为什么编码器放在宿主侧而不是客户端 bundle：`lib/client.js` 是手写的 lazy-CJS
// factory，不能 require npm 包，塞一份编码器进去就是几百行没法单测的算法；放这里
// 则是纯函数，`probe/unit-check.mjs` 能拿真实数据逐位核对（见该文件的 QR 段）。
//
// 表格与位序都对照 ISO/IEC 18004；实现结构参考 Nayuki 的公开实现（MIT）后按本仓
// 的 (row, col) 约定重写。

/** 纠错等级 M 下，各版本的码字总数。 */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346]

/** 纠错等级 M 下，每个纠错块的纠错码字数。 */
const EC_CODEWORDS_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]

/** 纠错等级 M 下，各版本切分的纠错块数。 */
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]

/** 各版本对齐图案的中心坐标；版本 1 没有对齐图案。 */
const ALIGNMENT_POSITIONS = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

/** 支持的最高版本。 */
export const MAX_VERSION = 10

/**
 * 高版本（≥10）的字符计数指示符是 16 位，低版本是 8 位。
 *
 * @param {number} version 版本
 * @returns {number} 位数
 */
function countIndicatorBits(version) {
  return version >= 10 ? 16 : 8
}

/**
 * 某版本在纠错等级 M 下可用的数据码字数（码字总数减去纠错码字）。
 *
 * @param {number} version 版本
 * @returns {number} 数据码字数
 */
function dataCodewordsFor(version) {
  return TOTAL_CODEWORDS[version] - EC_CODEWORDS_PER_BLOCK[version] * NUM_BLOCKS[version]
}

// ── GF(2^8)：QR 用的有限域，本原多项式 0x11D ─────────────────────────────

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  // 后半段直接抄前半段：乘法时指数相加最多到 508，省掉一次取模。
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}

/**
 * 有限域乘法。
 *
 * @param {number} a 因子
 * @param {number} b 因子
 * @returns {number} 积
 */
function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/**
 * 生成多项式 g(x) = ∏(x − α^i)，i ∈ [0, degree)。
 *
 * 系数按降幂排列，最高次项恒为 1，长度为 degree + 1。
 *
 * @param {number} degree 纠错码字数
 * @returns {number[]} 多项式系数
 */
function generatorPolynomial(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      // GF(2^8) 上减法即异或：乘 (x + α^i)。
      next[j] ^= poly[j]
      next[j + 1] ^= gfMultiply(poly[j], GF_EXP[i])
    }
    poly = next
  }
  return poly
}

/**
 * 一个数据块的 Reed–Solomon 纠错码字。
 *
 * 即 m(x)·x^degree mod g(x) 的余式，用综合除法求，不实际构造整段多项式。
 *
 * @param {number[]} data 数据码字
 * @param {number} degree 纠错码字数
 * @returns {number[]} 纠错码字
 */
function rsEncode(data, degree) {
  const generator = generatorPolynomial(degree)
  const remainder = new Array(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.shift()
    remainder.push(0)
    for (let i = 0; i < degree; i++) remainder[i] ^= gfMultiply(generator[i + 1], factor)
  }
  return remainder
}

// ── 比特流与码字 ────────────────────────────────────────────────────────

/**
 * 往比特数组末尾压入 value 的低 bits 位（高位在前）。
 *
 * @param {number[]} bits 目标数组
 * @param {number} value 值
 * @param {number} length 位数
 */
function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
}

/**
 * 字符串 → UTF-8 字节。
 *
 * @param {string} text 文本
 * @returns {number[]} 字节
 */
function utf8Bytes(text) {
  return [...new TextEncoder().encode(text)]
}

/**
 * 选能装下这么多字节的最小版本。
 *
 * @param {number} byteLength 字节数
 * @returns {number | null} 版本；装不下返回 null
 */
function pickVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const capacity = dataCodewordsFor(version) * 8
    if (4 + countIndicatorBits(version) + byteLength * 8 <= capacity) return version
  }
  return null
}

/**
 * 组数据码字：模式指示符 + 字符计数 + 正文 + 终止符 + 字节对齐 + 填充。
 *
 * @param {number[]} bytes 正文的 UTF-8 字节
 * @param {number} version 版本
 * @returns {number[]} 数据码字
 */
function buildDataCodewords(bytes, version) {
  const capacity = dataCodewordsFor(version) * 8
  const bits = []
  pushBits(bits, 0b0100, 4) // 字节模式
  pushBits(bits, bytes.length, countIndicatorBits(version))
  for (const byte of bytes) pushBits(bits, byte, 8)
  // 终止符最多 4 位；剩余空间不足 4 位时能放几位放几位。
  pushBits(bits, 0, Math.min(4, capacity - bits.length))
  // 补到字节边界。
  pushBits(bits, 0, (8 - (bits.length % 8)) % 8)
  // 交替填充 0xEC / 0x11（规范指定的两个填充码字）。
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) pushBits(bits, pad, 8)

  const codewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }
  return codewords
}

/**
 * 切块、算纠错、再按规范交错成最终码字序列。
 *
 * @param {number[]} data 数据码字
 * @param {number} version 版本
 * @returns {number[]} 交错后的码字
 */
function addErrorCorrection(data, version) {
  const blocks = NUM_BLOCKS[version]
  const ecLength = EC_CODEWORDS_PER_BLOCK[version]
  const shortLength = Math.floor(data.length / blocks)
  // 规范里长块排在短块之后：v8-M 是「2 块 38 + 2 块 39」。
  const longBlocks = data.length % blocks

  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (let i = 0; i < blocks; i++) {
    const length = shortLength + (i >= blocks - longBlocks ? 1 : 0)
    const block = data.slice(offset, offset + length)
    offset += length
    dataBlocks.push(block)
    ecBlocks.push(rsEncode(block, ecLength))
  }

  const result = []
  const maxLength = shortLength + (longBlocks > 0 ? 1 : 0)
  for (let i = 0; i < maxLength; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i])
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) result.push(block[i])
  }
  return result
}

// ── 矩阵 ────────────────────────────────────────────────────────────────

/**
 * size × size 的方阵，用给定值填满。
 *
 * @param {number} size 边长
 * @param {number | boolean} fill 填充值
 * @returns {any[][]} 矩阵
 */
function grid(size, fill) {
  return Array.from({ length: size }, () => new Array(size).fill(fill))
}

/**
 * 画三个定位图案（含分隔符），并标记为功能模块。
 *
 * @param {number[][]} modules 模块矩阵
 * @param {boolean[][]} reserved 功能模块标记
 * @param {number} size 边长
 * @param {number} top 图案顶行
 * @param {number} left 图案左列
 */
function drawFinder(modules, reserved, size, top, left) {
  // 从 -1 开始：外圈那一条是分隔符（恒亮），必须一起占位。
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const row = top + dr
      const col = left + dc
      if (row < 0 || row >= size || col < 0 || col >= size) continue
      const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
      const dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6
        || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4))
      modules[row][col] = dark ? 1 : 0
      reserved[row][col] = true
    }
  }
}

/**
 * 画定位图案、定时图案、对齐图案、暗模块，并预留格式 / 版本信息区。
 *
 * 顺序：定位图案 → 定时图案 → 对齐图案 → 格式 / 版本信息占位 → 暗模块。
 * 对齐图案会故意盖掉穿过它的定时图案（相位一致，见下），格式位最后按掩码写，
 * 所以这里只占位、不写值。
 *
 * @param {number[][]} modules 模块矩阵
 * @param {boolean[][]} reserved 功能模块标记
 * @param {number} version 版本
 */
function drawFunctionPatterns(modules, reserved, version) {
  const size = version * 4 + 17

  drawFinder(modules, reserved, size, 0, 0)
  drawFinder(modules, reserved, size, 0, size - 7)
  drawFinder(modules, reserved, size, size - 7, 0)

  // 定时图案：第 6 行 / 第 6 列，从定位图案分隔符之后开始，黑白相间。
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0 ? 1 : 0
    modules[6][i] = dark
    reserved[6][i] = true
    modules[i][6] = dark
    reserved[i][6] = true
  }

  // 对齐图案：5×5，外圈亮、中圈暗、中心亮。只有压在三个定位图案上的那三个不画；
  // 其余全部要画——包括落在定时图案上的 (6,x)/(x,6)：对齐图案中轴的
  // 「暗亮暗亮暗」与定时图案的奇偶相位本来就对齐，画上去不会破坏定时线。
  const centers = ALIGNMENT_POSITIONS[version]
  const finderCorners = [[6, 6], [6, size - 7], [size - 7, 6]]
  for (const row of centers) {
    for (const col of centers) {
      if (finderCorners.some(([fr, fc]) => fr === row && fc === col)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          modules[row + dr][col + dc] = dark ? 1 : 0
          reserved[row + dr][col + dc] = true
        }
      }
    }
  }

  // 预留格式信息区（值随掩码变，最后写）；注意 (8,6) 与 (6,8) 是定时图案，
  // 虽然在这里被一并占位，写格式位时不会碰它们。
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = true
    reserved[i][8] = true
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true
    reserved[size - 1 - i][8] = true
  }

  // 暗模块：恒亮，位置固定。
  modules[size - 8][8] = 1
  reserved[size - 8][8] = true

  // 版本信息（版本 ≥7 才有）：18 位，右上与左下各一份。
  if (version >= 7) {
    let remainder = version
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    const bits = (version << 12) | remainder
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      modules[b][a] = bit
      reserved[b][a] = true
      modules[a][b] = bit
      reserved[a][b] = true
    }
  }
}

/**
 * 把码字按「从右下角起、每两列一折、蛇形向上」的规则填进数据区。
 *
 * @param {number[][]} modules 模块矩阵
 * @param {boolean[][]} reserved 功能模块标记
 * @param {number} size 边长
 * @param {number[]} codewords 交错后的码字
 */
function drawCodewords(modules, reserved, size, codewords) {
  const totalBits = codewords.length * 8
  let bitIndex = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    // 第 6 列是定时图案，整列跳过：把折返点提前一格。
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vertical : vertical
        if (!reserved[row][col] && bitIndex < totalBits) {
          modules[row][col] = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1
          bitIndex++
        }
      }
    }
  }
}

/**
 * 某掩码对某个模块是否取反。
 *
 * @param {number} mask 掩码编号 0–7
 * @param {number} row 行
 * @param {number} col 列
 * @returns {boolean} 是否取反
 */
function maskApplies(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return col % 3 === 0
    case 3: return (row + col) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

/**
 * 把掩码作用到数据模块上（XOR 自反，调用两次即还原）。
 *
 * @param {number[][]} modules 模块矩阵
 * @param {boolean[][]} reserved 功能模块标记
 * @param {number} mask 掩码编号
 */
function applyMask(modules, reserved, mask) {
  for (let row = 0; row < modules.length; row++) {
    for (let col = 0; col < modules.length; col++) {
      if (!reserved[row][col] && maskApplies(mask, row, col)) modules[row][col] ^= 1
    }
  }
}

/**
 * 格式信息：2 位纠错等级 + 3 位掩码，BCH(15,5) 校验后异或固定掩码。
 *
 * 纠错等级 M 的指示符是 00。
 *
 * @param {number} mask 掩码编号
 * @returns {number} 15 位格式信息
 */
function formatBits(mask) {
  const data = mask // 高 2 位固定 00（M）
  let remainder = data << 10
  for (let i = 14; i >= 10; i--) {
    if (((remainder >>> i) & 1) !== 0) remainder ^= 0x537 << (i - 10)
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412
}

/**
 * 把格式信息写进矩阵的两份副本。
 *
 * @param {number[][]} modules 模块矩阵
 * @param {number} size 边长
 * @param {number} mask 掩码编号
 */
function drawFormatBits(modules, size, mask) {
  const bits = formatBits(mask)
  const bit = (i) => (bits >>> i) & 1

  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i)
  modules[7][8] = bit(6)
  modules[8][8] = bit(7)
  modules[8][7] = bit(8)
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i)

  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i)
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i)
}

/**
 * 四条掩码惩罚规则之和，越小越好。
 *
 * @param {number[][]} modules 模块矩阵
 * @returns {number} 惩罚分
 */
function penaltyScore(modules) {
  const size = modules.length
  let score = 0

  // 规则 1：同色连续 5 个起罚，每多一个加 1。
  // `at(line, position)` 把「第几条线 / 线上第几个」映射到模块，行列两轮共用。
  const runScore = (at) => {
    for (let line = 0; line < size; line++) {
      let run = 1
      for (let pos = 1; pos < size; pos++) {
        if (at(line, pos) === at(line, pos - 1)) {
          run++
        } else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
  }
  runScore((row, col) => modules[row][col])
  runScore((col, row) => modules[row][col])

  // 规则 2：2×2 同色块，每个 +3。
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const value = modules[row][col]
      if (value === modules[row][col + 1] && value === modules[row + 1][col] && value === modules[row + 1][col + 1]) {
        score += 3
      }
    }
  }

  // 规则 3：1:1:3:1:1 的类定位图案（两侧各带 4 个亮模块），每处 +40。
  const PATTERNS = ['10111010000', '00001011101']
  const lineScore = (at) => {
    for (let line = 0; line < size; line++) {
      let text = ''
      for (let pos = 0; pos < size; pos++) text += at(line, pos)
      for (const pattern of PATTERNS) {
        let from = 0
        while ((from = text.indexOf(pattern, from)) !== -1) {
          score += 40
          from += 1
        }
      }
    }
  }
  lineScore((row, col) => modules[row][col])
  lineScore((col, row) => modules[row][col])

  // 规则 4：黑色占比偏离 50%，每 5 个百分点 +10。
  let dark = 0
  for (const row of modules) for (const value of row) if (value === 1) dark++
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10

  return score
}

// ── 对外接口 ────────────────────────────────────────────────────────────

/**
 * 把文本编码成 QR 模块矩阵。
 *
 * @param {string} text 待编码文本
 * @param {{mask?: number}} [options] options.mask 强制掩码（0–7），主要给测试用
 * @returns {{version: number, size: number, mask: number, modules: number[][]} | null}
 *   文本超出支持范围（纠错等级 M 下 213 字节）时返回 null
 */
export function qrMatrix(text, options = {}) {
  const bytes = utf8Bytes(text)
  const version = pickVersion(bytes.length)
  if (version === null) return null

  const size = version * 4 + 17
  const modules = grid(size, 0)
  const reserved = grid(size, false)
  drawFunctionPatterns(modules, reserved, version)
  drawCodewords(modules, reserved, size, addErrorCorrection(buildDataCodewords(bytes, version), version))

  const forced = options.mask
  const candidates = forced === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forced]
  let best = null
  for (const mask of candidates) {
    applyMask(modules, reserved, mask)
    drawFormatBits(modules, size, mask)
    const score = penaltyScore(modules)
    if (best === null || score < best.score) best = { mask, score, modules: modules.map((row) => row.slice()) }
    // 掩码是异或，再作用一次即还原，可以直接试下一个。
    applyMask(modules, reserved, mask)
  }

  return { version, size, mask: best.mask, modules: best.modules }
}

/**
 * 把文本渲染成自包含的 SVG 字符串。
 *
 * 只有一个 `<rect>`（白底）和一个 `<path>`（所有黑色模块，按行合并成横条），
 * 不含任何用户文本，因此不需要转义，也不会把深链接泄进 DOM 文本。
 *
 * @param {string} text 待编码文本
 * @param {{mask?: number, quietZone?: number, pixelSize?: number}} [options] 选项
 * @returns {string | null} SVG；文本超长时返回 null
 */
export function qrSvg(text, options = {}) {
  const matrix = qrMatrix(text, options)
  if (matrix === null) return null

  const quiet = options.quietZone ?? 4
  const total = matrix.size + quiet * 2
  let path = ''
  for (let row = 0; row < matrix.size; row++) {
    let col = 0
    while (col < matrix.size) {
      if (matrix.modules[row][col] !== 1) {
        col++
        continue
      }
      let run = 1
      while (col + run < matrix.size && matrix.modules[row][col + run] === 1) run++
      path += `M${col + quiet} ${row + quiet}h${run}v1h-${run}z`
      col += run
    }
  }

  const sizeAttr = options.pixelSize === undefined ? '' : ` width="${options.pixelSize}" height="${options.pixelSize}"`
  return '<svg xmlns="http://www.w3.org/2000/svg"'
    + ` viewBox="0 0 ${total} ${total}"${sizeAttr}`
    + ' shape-rendering="crispEdges" role="img">'
    + `<rect width="${total}" height="${total}" fill="#ffffff"/>`
    + `<path d="${path}" fill="#000000"/>`
    + '</svg>'
}
