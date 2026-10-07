// 图像处理核心：把 Compositor 的调整/滤镜语义移植到浏览器 Canvas。
// 所有函数都在 ImageData 上原地操作，避免频繁分配。

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const clamp255 = value => clamp(value, 0, 255);
const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = (a, b, t) => a + (b - a) * t;

// sRGB <-> 线性空间，用于亮度/曝光等符合物理直觉的计算
const srgbToLinear = c => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const linearToSrgb = v => {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return clamp255((c * 255) + 0.5);
};

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// 稳定的伪随机数，保证噪点/颗粒在多次预览之间不跳动
const mulberry32 = seed => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/* ------------------------------------------------------------------ *
 * 色阶 Levels
 * ------------------------------------------------------------------ */

const buildLevelsLut = (inLow, inHigh, gamma, outLow, outHigh) => {
    const lut = new Uint8ClampedArray(256);
    const span = Math.max(1, inHigh - inLow);
    for (let i = 0; i < 256; i++) {
        let v = (i - inLow) / span;
        v = clamp01(v);
        v = Math.pow(v, 1 / Math.max(0.01, gamma));
        lut[i] = clamp255((outLow + v * (outHigh - outLow)) * 255);
    }
    return lut;
};

/**
 * 色阶：支持 RGB 合并通道或单通道。
 * channels: {rgb, r, g, b}，每项为 {inLow, inWhite, gamma, outLow, outHigh}
 */
const applyLevels = (data, channels) => {
    const luts = {};
    for (const key of Object.keys(channels)) luts[key] = buildLevelsLut(...channels[key]);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = luts.rgb[data[i]];
        data[i + 1] = luts.rgb[data[i + 1]];
        data[i + 2] = luts.rgb[data[i + 2]];
        if (channels.r) data[i] = luts.r[data[i]];
        if (channels.g) data[i + 1] = luts.g[data[i + 1]];
        if (channels.b) data[i + 2] = luts.b[data[i + 2]];
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 曲线 Curves：控制点插值成 256 项查找表
 * ------------------------------------------------------------------ */

const CURVE_IDENTITY = [{x: 0, y: 0}, {x: 255, y: 255}];

/**
 * @param {Array<{x: number, y: number}>} points 控制点，需按 x 升序
 */
const buildCurveLut = points => {
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    const lut = new Uint8ClampedArray(256);
    let seg = 0;
    for (let i = 0; i < 256; i++) {
        while (seg < sorted.length - 2 && i > sorted[seg + 1].x) seg++;
        const a = sorted[seg];
        const b = sorted[Math.min(seg + 1, sorted.length - 1)];
        const span = Math.max(1e-6, b.x - a.x);
        const t = clamp01((i - a.x) / span);
        lut[i] = clamp255(lerp(a.y, b.y, t));
    }
    return lut;
};

/**
 * @param {object} curves {rgb, r, g, b}，每项为控制点数组
 */
const applyCurves = (data, curves) => {
    const luts = {};
    for (const key of Object.keys(curves)) {
        const points = curves[key];
        luts[key] = (points && points.length > 1) ? buildCurveLut(points) : null;
    }
    for (let i = 0; i < data.length; i += 4) {
        data[i] = luts.rgb ? luts.rgb[data[i]] : data[i];
        data[i + 1] = luts.rgb ? luts.rgb[data[i + 1]] : data[i + 1];
        data[i + 2] = luts.rgb ? luts.rgb[data[i + 2]] : data[i + 2];
        if (luts.r) data[i] = luts.r[data[i]];
        if (luts.g) data[i + 1] = luts.g[data[i + 1]];
        if (luts.b) data[i + 2] = luts.b[data[i + 2]];
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 色相/饱和度 Hue / Saturation
 * ------------------------------------------------------------------ */

const rgbToHsv = (r, g, b, out) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    out[0] = h;
    out[1] = max === 0 ? 0 : d / max;
    out[2] = max / 255;
    return out;
};

const hsvToRgb = (h, s, v, out) => {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    out[0] = clamp255((r + m) * 255);
    out[1] = clamp255((g + m) * 255);
    out[2] = clamp255((b + m) * 255);
    return out;
};

/**
 * @param {object} params - hue -180..180, saturation/lightness -100..100, colorize 及 colorizeHue/colorizeSat
 * @returns {Uint8ClampedArray} 传入的 data，原地修改后返回
 */
const applyHueSaturation = (data, params) => {
    const hueShift = params.hue || 0;
    const satScale = 1 + (params.saturation || 0) / 100;
    const lightScale = 1 + (params.lightness || 0) / 100;
    const colorize = Boolean(params.colorize);
    const hsv = [0, 0, 0];
    const rgb = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        rgbToHsv(r, g, b, hsv);
        let [h, s, v] = hsv;
        if (colorize) {
            h = params.colorizeHue || 0;
            s = clamp01((typeof params.colorizeSat === 'number' ? params.colorizeSat : 50) / 100);
        } else {
            h = (h + hueShift + 360) % 360;
            s = clamp01(s * satScale);
        }
        if (lightScale >= 1) v = lerp(v, 1, lightScale - 1);
        else v *= lightScale;
        hsvToRgb(h, s, v, rgb);
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 曝光 Exposure
 * ------------------------------------------------------------------ */

/** @param {object} params {exposure: stops, offset: -1..1, gamma: 0.1..4} */
const applyExposure = (data, params) => {
    const stops = params.exposure || 0;
    const gain = Math.pow(2, stops);
    const offset = params.offset || 0;
    const gamma = Math.max(0.05, params.gamma === undefined ? 1 : params.gamma);
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
        const linear = srgbToLinear(i) * gain + offset;
        lut[i] = clamp255(Math.pow(clamp01(linearToSrgb(linear) / 255), 1 / gamma) * 255);
    }
    for (let i = 0; i < data.length; i += 4) {
        data[i] = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 黑白 Black & White
 * ------------------------------------------------------------------ */

/** @param {object} params {reds, yellows, greens, cyans, blues, magentas, tint, tintColor:[r,g,b]} */
const applyBlackWhite = (data, params) => {
    const w = {
        r: params.reds !== undefined ? params.reds / 100 : 0.4,
        y: params.yellows !== undefined ? params.yellows / 100 : 0.6,
        g: params.greens !== undefined ? params.greens / 100 : 0.4,
        c: params.cyans !== undefined ? params.cyans / 100 : 0.6,
        b: params.blues !== undefined ? params.blues / 100 : 0.2,
        m: params.magentas !== undefined ? params.magentas / 100 : 0.8
    };
    const tint = params.tint ? (params.tintColor || [0, 0, 0]) : null;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let gray;
        if (max === min) {
            gray = max;
        } else {
            // 按色相落在哪个原色-间色区间，插值两个通道权重
            // 按色相落在哪个原色-间色区间，插值两个通道权重
            const span = max - min;
            let weight;
            if (max === r) {
                weight = g === max ?
                    lerp(w.y, w.r, (max - b) / span) :
                    lerp(w.m, w.r, (max - g) / span);
            } else if (max === g) {
                weight = b === max ?
                    lerp(w.c, w.g, (max - r) / span) :
                    lerp(w.y, w.g, (max - b) / span);
            } else {
                weight = r === max ?
                    lerp(w.b, w.m, (max - g) / span) :
                    lerp(w.c, w.b, (max - r) / span);
            }
            gray = clamp255(weight * (max + min) / 2);
        }
        if (tint) {
            const t = clamp01(gray / 255);
            data[i] = clamp255(gray * (1 - t) + tint[0] * t);
            data[i + 1] = clamp255(gray * (1 - t) + tint[1] * t);
            data[i + 2] = clamp255(gray * (1 - t) + tint[2] * t);
        } else {
            data[i] = data[i + 1] = data[i + 2] = gray;
        }
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 色彩平衡 Color Balance（阴影 / 中间调 / 高光）
 * ------------------------------------------------------------------ */

/** @param {object} params {shadows:{r,g,b}, midtones:{r,g,b}, highlights:{r,g,b}, preserveLuminosity} */
const applyColorBalance = (data, params) => {
    const shadows = params.shadows || {r: 0, g: 0, b: 0};
    const mid = params.midtones || {r: 0, g: 0, b: 0};
    const highlights = params.highlights || {r: 0, g: 0, b: 0};
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const lum = luminance(r, g, b) / 255;
        // 三个区间的权重，阴影/高光以半宽重叠
        const wShadow = clamp01(1 - lum / 0.5) ** 2;
        const wHigh = clamp01((lum - 0.5) / 0.5) ** 2;
        const wMid = 1 - wShadow - wHigh;
        const dr = (shadows.r * wShadow + mid.r * wMid + highlights.r * wHigh) / 100;
        const dg = (shadows.g * wShadow + mid.g * wMid + highlights.g * wHigh) / 100;
        const db = (shadows.b * wShadow + mid.b * wMid + highlights.b * wHigh) / 100;
        let nr = clamp01(r + dr);
        let ng = clamp01(g + dg);
        let nb = clamp01(b + db);
        if (params.preserveLuminosity) {
            const before = luminance(r, g, b);
            const after = luminance(nr, ng, nb);
            if (after > 0) {
                const k = before / after;
                nr = clamp01(nr * k);
                ng = clamp01(ng * k);
                nb = clamp01(nb * k);
            }
        }
        data[i] = nr * 255;
        data[i + 1] = ng * 255;
        data[i + 2] = nb * 255;
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 渐变映射 Gradient Map
 * ------------------------------------------------------------------ */

/** @param {object} params {shadows:[r,g,b], midtones:[r,g,b], highlights:[r,g,b], reversed} */
const applyGradientMap = (data, params) => {
    const shadows = params.shadows || [0, 0, 0];
    const mid = params.midtones || [128, 128, 128];
    const highlights = params.highlights || [255, 255, 255];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
        let t = i / 255;
        if (params.reversed) t = 1 - t;
        let rgb;
        if (t < 0.5) {
            const k = t * 2;
            rgb = [lerp(shadows[0], mid[0], k), lerp(shadows[1], mid[1], k), lerp(shadows[2], mid[2], k)];
        } else {
            const k = (t - 0.5) * 2;
            rgb = [lerp(mid[0], highlights[0], k), lerp(mid[1], highlights[1], k), lerp(mid[2], highlights[2], k)];
        }
        lut[i * 3] = rgb[0];
        lut[i * 3 + 1] = rgb[1];
        lut[i * 3 + 2] = rgb[2];
    }
    for (let i = 0; i < data.length; i += 4) {
        const idx = (Math.round(luminance(data[i], data[i + 1], data[i + 2]) / 255 * 255) | 0) * 3;
        data[i] = lut[idx];
        data[i + 1] = lut[idx + 1];
        data[i + 2] = lut[idx + 2];
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 颗粒 Grain / 添加噪点 Add Noise
 * ------------------------------------------------------------------ */

/**
 * @param {object} params {amount, monochromatic, seed, gaussian}
 */
const applyGrain = (data, params) => {
    const amount = (params.amount || 0) * 2.55;
    if (amount <= 0) return data;
    const random = mulberry32(params.seed || 1);
    const mono = Boolean(params.monochromatic);
    const gaussian = Boolean(params.gaussian);
    for (let i = 0; i < data.length; i += 4) {
        let n = random();
        if (gaussian) n = (n + random() + random()) / 3;
        const delta = (n - 0.5) * amount;
        data[i] = clamp255(data[i] + delta);
        data[i + 1] = clamp255(data[i + 1] + (mono ? delta : (random() - 0.5) * amount));
        data[i + 2] = clamp255(data[i + 2] + (mono ? delta : (random() - 0.5) * amount));
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 反相 Invert
 * ------------------------------------------------------------------ */

const applyInvert = data => {
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 模糊：三次盒式模糊近似高斯（O(n)，与 Compositor 的高斯半径语义一致）
 * ------------------------------------------------------------------ */

const boxBlurPass = (src, dst, width, height, radius, horizontal) => {
    const outer = horizontal ? height : width;
    const inner = horizontal ? width : height;
    const window = radius * 2 + 1;
    // 水平方向按行扫描（索引 y*width+x），垂直方向按列扫描，同一个线性索引公式
    const at = (o, i, c) => (horizontal ? (o * width + i) : (i * width + o)) * 4 + c;
    for (let o = 0; o < outer; o++) {
        for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (let k = -radius; k <= radius; k++) {
                sum += src[at(o, clamp(k, 0, inner - 1), c)];
            }
            for (let i = 0; i < inner; i++) {
                dst[at(o, i, c)] = sum / window;
                const add = src[at(o, clamp(i + radius + 1, 0, inner - 1), c)];
                const sub = src[at(o, clamp(i - radius, 0, inner - 1), c)];
                sum += add - sub;
            }
        }
    }
};

/**
 * 对 RGB 做高斯模糊（可分离盒式三次近似），alpha 置不透明以避免边缘出现黑边。
 * @param {number} radius - 半径（像素），<=0 时原样返回
 * @returns {Uint8ClampedArray} 传入的 data，原地修改后返回
 */
const gaussianBlurData = (data, width, height, radius) => {
    const r = Math.round(radius);
    if (r <= 0) return data;
    const len = width * height * 4;
    const a = new Float32Array(len);
    const b = new Float32Array(len);
    for (let i = 0; i < len; i++) a[i] = data[i];
    for (let pass = 0; pass < 3; pass++) {
        boxBlurPass(a, b, width, height, r, true);
        boxBlurPass(b, a, width, height, r, false);
    }
    for (let i = 0; i < len; i += 4) {
        data[i] = a[i];
        data[i + 1] = a[i + 1];
        data[i + 2] = a[i + 2];
        data[i + 3] = 255;
    }
    return data;
};

/**
 * 模糊单个通道的 alpha 蒙版（供发光/阴影/描边使用）
 * @returns {Float32Array} 模糊后的 0..255 覆盖率
 */
const gaussianBlurAlpha = (alpha, width, height, radius) => {
    const r = Math.round(radius);
    if (r <= 0) return alpha;
    const len = width * height;
    const a = new Float32Array(len);
    const b = new Float32Array(len);
    for (let i = 0; i < len; i++) a[i] = alpha[i];
    for (let pass = 0; pass < 3; pass++) {
        // 水平
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) sum += a[y * width + clamp(k, 0, width - 1)];
            for (let x = 0; x < width; x++) {
                b[y * width + x] = sum / (r * 2 + 1);
                sum += a[y * width + clamp(x + r + 1, 0, width - 1)] - a[y * width + clamp(x - r, 0, width - 1)];
            }
        }
        // 垂直
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) sum += b[clamp(k, 0, height - 1) * width + x];
            for (let y = 0; y < height; y++) {
                a[y * width + x] = sum / (r * 2 + 1);
                sum += b[clamp(y + r + 1, 0, height - 1) * width + x] - b[clamp(y - r, 0, height - 1) * width + x];
            }
        }
    }
    return a;
};

/* ------------------------------------------------------------------ *
 * 动感模糊 Motion Blur
 * ------------------------------------------------------------------ */

/** @param {object} params {angle: -90..90（度）, distance: 像素} */
const applyMotionBlur = (data, width, height, params) => {
    const distance = Math.round(params.distance || 0);
    if (distance <= 0) return data;
    const rad = ((params.angle || 0) * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const samples = Math.min(64, Math.max(2, distance));
    const len = data.length;
    const out = new Uint8ClampedArray(len);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let s = 0; s < samples; s++) {
                const t = (s / (samples - 1) - 0.5) * distance;
                const sx = clamp(Math.round(x + dx * t), 0, width - 1);
                const sy = clamp(Math.round(y + dy * t), 0, height - 1);
                const idx = (sy * width + sx) * 4;
                r += data[idx];
                g += data[idx + 1];
                b += data[idx + 2];
                a += data[idx + 3];
            }
            const idx = (y * width + x) * 4;
            out[idx] = r / samples;
            out[idx + 1] = g / samples;
            out[idx + 2] = b / samples;
            out[idx + 3] = a / samples;
        }
    }
    data.set(out);
    return data;
};

/* ------------------------------------------------------------------ *
 * 暗角 Vignette
 * ------------------------------------------------------------------ */

/** @param {object} params {amount: 0..1, midpoint: 0..1, roundness: -1..1, feather: 0..1} */
const applyVignette = (data, width, height, params) => {
    const amount = params.amount || 0;
    if (amount <= 0) return data;
    const midpoint = params.midpoint === undefined ? 0.5 : params.midpoint;
    const feather = params.feather === undefined ? 0.5 : Math.max(0.01, params.feather);
    const cx = width / 2;
    const cy = height / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / maxDist;
            const start = midpoint;
            const end = Math.min(1, start + feather);
            let t = (dist - start) / Math.max(1e-6, end - start);
            t = clamp01(t);
            const factor = 1 - t * t * (3 - 2 * t) * amount;
            const idx = (y * width + x) * 4;
            data[idx] *= factor;
            data[idx + 1] *= factor;
            data[idx + 2] *= factor;
        }
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 辉光 Bloom / Glow：亮部提取 -> 模糊 -> 滤色叠加
 * ------------------------------------------------------------------ */

/** @param {object} params {threshold: 0..1, radius: 像素, intensity: 0..2} */
const applyBloom = (data, width, height, params) => {
    const threshold = params.threshold === undefined ? 0.7 : params.threshold;
    const intensity = params.intensity === undefined ? 0.5 : params.intensity;
    const radius = params.radius === undefined ? 10 : params.radius;
    if (intensity <= 0) return data;
    const len = data.length;
    const bright = new Uint8ClampedArray(len);
    for (let i = 0; i < len; i += 4) {
        const l = luminance(data[i], data[i + 1], data[i + 2]) / 255;
        const k = clamp01((l - threshold) / Math.max(0.01, 1 - threshold));
        const v = k * k * 255;
        bright[i] = v;
        bright[i + 1] = v;
        bright[i + 2] = v;
        bright[i + 3] = 255;
    }
    gaussianBlurData(bright, width, height, radius);
    for (let i = 0; i < len; i += 4) {
        // 滤色（screen）
        const dst = [data[i], data[i + 1], data[i + 2]];
        const src = [bright[i] * intensity, bright[i + 1] * intensity, bright[i + 2] * intensity];
        for (let c = 0; c < 3; c++) {
            data[i + c] = 255 - ((255 - dst[c]) * (255 - src[c])) / 255;
        }
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 锐化 Unsharp Mask
 * ------------------------------------------------------------------ */

/** @param {object} params {amount: 0..3, radius: 像素} */
const applySharpen = (data, width, height, params) => {
    const amount = params.amount || 0;
    const radius = params.radius === undefined ? 1 : params.radius;
    if (amount <= 0) return data;
    const len = data.length;
    const copy = new Uint8ClampedArray(data);
    gaussianBlurData(copy, width, height, radius);
    for (let i = 0; i < len; i += 4) {
        data[i] = data[i] + amount * (data[i] - copy[i]);
        data[i + 1] = data[i + 1] + amount * (data[i + 1] - copy[i + 1]);
        data[i + 2] = data[i + 2] + amount * (data[i + 2] - copy[i + 2]);
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 色调对比 Tonal Contrast（简化的 S 曲线）
 * ------------------------------------------------------------------ */

/** @param {object} params {shadows, highlights} 均为 -100..100 */
const applyTonalContrast = (data, params) => {
    const shadows = (params.shadows || 0) / 100;
    const highlights = (params.highlights || 0) / 100;
    if (!shadows && !highlights) return data;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let v = t;
        // 暗部 S 曲线
        if (shadows > 0) {
            const w = clamp01(1 - t / 0.5);
            v += shadows * w * (0.5 - Math.abs(t - 0.25)) * 0.8;
        } else if (shadows < 0) {
            const w = clamp01(1 - t / 0.5);
            v += shadows * w * w * 0.25;
        }
        // 亮部 S 曲线
        if (highlights > 0) {
            const w = clamp01((t - 0.5) / 0.5);
            v += highlights * w * (0.5 - Math.abs(t - 0.75)) * 0.8;
        } else if (highlights < 0) {
            const w = clamp01((t - 0.5) / 0.5);
            v += highlights * w * w * 0.25;
        }
        lut[i] = clamp255(clamp01(v) * 255);
    }
    for (let i = 0; i < data.length; i += 4) {
        data[i] = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 镜头校正 Lens Correction：桶形畸变 + 色散 + 暗角
 * ------------------------------------------------------------------ */

/** @param {object} params {distortion: -1..1, chromatic: 像素, vignette: 0..1} */
const applyLensCorrection = (data, width, height, params) => {
    const distortion = params.distortion || 0;
    const chromatic = params.chromatic || 0;
    const vignetting = params.vignette || 0;
    if (!distortion && !chromatic && !vignetting) return data;
    const cx = width / 2;
    const cy = height / 2;
    const len = data.length;
    const out = new Uint8ClampedArray(len);
    const sample = (x, y, channelShift) => {
        let sx = x + channelShift;
        let sy = y;
        if (distortion !== 0) {
            const dx = (x - cx) / cx;
            const dy = (y - cy) / cy;
            const r2 = dx * dx + dy * dy;
            const factor = 1 + distortion * 0.35 * r2;
            sx = cx + dx * factor * cx;
            sy = cy + dy * factor * cy;
        }
        sx = clamp(Math.round(sx), 0, width - 1);
        sy = clamp(Math.round(sy), 0, height - 1);
        const idx = (sy * width + sx) * 4;
        return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            let factor = 1;
            if (vignetting > 0) {
                const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / Math.sqrt(cx * cx + cy * cy);
                factor = 1 - vignetting * Math.pow(clamp01((dist - 0.4) / 0.6), 2);
            }
            const red = sample(x, y, chromatic);
            const green = sample(x, y, 0);
            const blue = sample(x, y, -chromatic);
            out[idx] = clamp255(red[0] * factor);
            out[idx + 1] = clamp255(green[1] * factor);
            out[idx + 2] = clamp255(blue[2] * factor);
            out[idx + 3] = green[3];
        }
    }
    data.set(out);
    return data;
};

/* ------------------------------------------------------------------ *
 * 像素化 Pixelate
 * ------------------------------------------------------------------ */

/** @param {object} params {size: 像素} */
const applyPixelate = (data, width, height, params) => {
    const size = Math.max(1, Math.round(params.size || 4));
    if (size <= 1) return data;
    for (let by = 0; by < height; by += size) {
        for (let bx = 0; bx < width; bx += size) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;
            for (let y = by; y < Math.min(by + size, height); y++) {
                for (let x = bx; x < Math.min(bx + size, width); x++) {
                    const idx = (y * width + x) * 4;
                    r += data[idx];
                    g += data[idx + 1];
                    b += data[idx + 2];
                    a += data[idx + 3];
                    n++;
                }
            }
            r /= n;
            g /= n;
            b /= n;
            a /= n;
            for (let y = by; y < Math.min(by + size, height); y++) {
                for (let x = bx; x < Math.min(bx + size, width); x++) {
                    const idx = (y * width + x) * 4;
                    data[idx] = r;
                    data[idx + 1] = g;
                    data[idx + 2] = b;
                    data[idx + 3] = a;
                }
            }
        }
    }
    return data;
};

/* ------------------------------------------------------------------ *
 * 直方图
 * ------------------------------------------------------------------ */

/** @returns {{r: number[], g: number[], b: number[], l: number[]}} 每项 256 桶 */
const computeHistogram = data => {
    const r = new Array(256).fill(0);
    const g = new Array(256).fill(0);
    const b = new Array(256).fill(0);
    const l = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        r[data[i]]++;
        g[data[i + 1]]++;
        b[data[i + 2]]++;
        l[Math.round(luminance(data[i], data[i + 1], data[i + 2]))]++;
    }
    return {r, g, b, l};
};

/* ------------------------------------------------------------------ *
 * 统一入口：把一组设置跑成新的 ImageData
 * ------------------------------------------------------------------ */

/**
 * 调整类操作可以合并成查找表，逐像素只走一遍；空间类算子各自独立。
 * @param {ImageData} imageData 输入（不会被修改）
 * @param {object} pipeline 见 userscript 中的默认设置
 * @returns {ImageData} 新的 ImageData
 */
const renderPipeline = (imageData, pipeline) => {
    const {width, height} = imageData;
    const out = new ImageData(width, height);
    out.data.set(imageData.data);

    if (pipeline.invert && pipeline.invert.enabled) applyInvert(out.data);
    if (pipeline.levels && pipeline.levels.enabled) applyLevels(out.data, pipeline.levels.channels);
    if (pipeline.curves && pipeline.curves.enabled) applyCurves(out.data, pipeline.curves.channels);
    if (pipeline.exposure && pipeline.exposure.enabled) applyExposure(out.data, pipeline.exposure);
    if (pipeline.hueSaturation && pipeline.hueSaturation.enabled) applyHueSaturation(out.data, pipeline.hueSaturation);
    if (pipeline.blackWhite && pipeline.blackWhite.enabled) applyBlackWhite(out.data, pipeline.blackWhite);
    if (pipeline.colorBalance && pipeline.colorBalance.enabled) applyColorBalance(out.data, pipeline.colorBalance);
    if (pipeline.gradientMap && pipeline.gradientMap.enabled) applyGradientMap(out.data, pipeline.gradientMap);
    if (pipeline.tone) {
        if (pipeline.tone.toneCurve && pipeline.tone.toneCurve.enabled) {
            applyTonalContrast(out.data, pipeline.tone.toneCurve);
        }
        if (pipeline.tone.sharpen && pipeline.tone.sharpen.enabled) {
            applySharpen(out.data, width, height, pipeline.tone.sharpen);
        }
        if (pipeline.tone.pixelate && pipeline.tone.pixelate.enabled) {
            applyPixelate(out.data, width, height, pipeline.tone.pixelate);
        }
        if (pipeline.tone.bloom && pipeline.tone.bloom.enabled) {
            applyBloom(out.data, width, height, pipeline.tone.bloom);
        }
        if (pipeline.tone.motionBlur && pipeline.tone.motionBlur.enabled) {
            applyMotionBlur(out.data, width, height, pipeline.tone.motionBlur);
        }
        if (pipeline.tone.gaussianBlur && pipeline.tone.gaussianBlur.enabled) {
            gaussianBlurData(out.data, width, height, pipeline.tone.gaussianBlur.radius);
        }
        if (pipeline.tone.vignette && pipeline.tone.vignette.enabled) {
            applyVignette(out.data, width, height, pipeline.tone.vignette);
        }
        if (pipeline.tone.lensCorrection && pipeline.tone.lensCorrection.enabled) {
            applyLensCorrection(out.data, width, height, pipeline.tone.lensCorrection);
        }
        if (pipeline.tone.addNoise && pipeline.tone.addNoise.enabled) {
            applyGrain(out.data, {
                amount: pipeline.tone.addNoise.amount,
                monochromatic: pipeline.tone.addNoise.monochromatic,
                gaussian: pipeline.tone.addNoise.gaussian,
                seed: pipeline.tone.addNoise.seed
            });
        }
        if (pipeline.tone.grain && pipeline.tone.grain.enabled) {
            applyGrain(out.data, pipeline.tone.grain);
        }
    }
    return out;
};

const IMAGE_DEFAULTS = {
    invert: {enabled: false},
    levels: {enabled: false, channels: {}},
    curves: {enabled: false, channels: {}},
    exposure: {enabled: false, exposure: 0, offset: 0, gamma: 1},
    hueSaturation: {enabled: false, hue: 0, saturation: 0, lightness: 0},
    blackWhite: {
        enabled: false, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80
    },
    colorBalance: {
        enabled: false,
        shadows: {r: 0, g: 0, b: 0},
        midtones: {r: 0, g: 0, b: 0},
        highlights: {r: 0, g: 0, b: 0}
    },
    gradientMap: {enabled: false, shadows: [0, 0, 0], midtones: [128, 128, 128], highlights: [255, 255, 255]},
    tone: {
        gaussianBlur: {enabled: false, radius: 2},
        motionBlur: {enabled: false, angle: 0, distance: 10},
        bloom: {enabled: false, threshold: 0.7, radius: 10, intensity: 0.5},
        sharpen: {enabled: false, amount: 0.5, radius: 1},
        vignette: {enabled: false, amount: 0.4, midpoint: 0.5, feather: 0.5},
        toneCurve: {enabled: false, shadows: 0, highlights: 0},
        addNoise: {enabled: false, amount: 10, monochromatic: false, gaussian: false, seed: 12345},
        grain: {enabled: false, amount: 10, monochromatic: true, gaussian: true, seed: 12345},
        lensCorrection: {enabled: false, distortion: 0, chromatic: 0, vignette: 0},
        pixelate: {enabled: false, size: 4}
    }
};

export {
    applyLevels,
    applyCurves,
    applyExposure,
    applyHueSaturation,
    applyBlackWhite,
    applyColorBalance,
    applyGradientMap,
    applyGrain,
    applyInvert,
    gaussianBlurData,
    gaussianBlurAlpha,
    applyMotionBlur,
    applyVignette,
    applyBloom,
    applySharpen,
    applyTonalContrast,
    applyLensCorrection,
    applyPixelate,
    computeHistogram,
    renderPipeline,
    buildCurveLut,
    CURVE_IDENTITY,
    IMAGE_DEFAULTS,
    luminance,
    mulberry32,
    clamp,
    clamp255,
    lerp
};
