// 图层效果：描边、投影、内阴影、外发光、内发光、颜色叠加。
// 语义对齐 Compositor 的 Layer effects，但用 alpha 蒙版运算实现，避免依赖 GPU。

import {gaussianBlurAlpha, clamp, clamp255} from './imaging.js';

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);

const hexToRgb = hex => {
    const value = typeof hex === 'string' ? hex.replace('#', '') : '000000';
    const full = value.length === 3 ? value.split('').map(c => c + c)
        .join('') : value;
    const n = parseInt(full, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const extractAlpha = data => {
    const alpha = new Float32Array(data.length / 4);
    for (let i = 0; i < alpha.length; i++) {
        alpha[i] = data[i * 4 + 3];
    }
    return alpha;
};

/**
 * 在原图下方合成一层"外部"像素（阴影/外发光）。
 * @param {Uint8ClampedArray} source 原始 RGBA
 * @param {Float32Array} layerAlpha 效果层的 alpha 覆盖率 0..255
 * @param {number[]} color 效果颜色 RGB
 * @param {number} opacity 0..1
 */
const compositeUnderneath = (data, layerAlpha, color, opacity) => {
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0, p = 0; i < layerAlpha.length; i++, p += 4) {
        const srcA = data[p + 3] / 255;
        const fxA = clamp01(layerAlpha[i] / 255) * opacity;
        // 效果层在下，原图在上（标准 source-over 顺序反过来）
        const outA = fxA + srcA * (1 - fxA);
        if (outA <= 0) {
            out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 0;
            continue;
        }
        for (let c = 0; c < 3; c++) {
            const fx = color[c] * fxA;
            const sc = data[p + c] / 255 * srcA;
            out[p + c] = clamp255((fx + sc * (1 - fxA)) / outA * 255);
        }
        out[p + 3] = clamp255(outA * 255);
    }
    data.set(out);
    return data;
};

/**
 * 在原图上/内合成一层像素（颜色叠加/内阴影/内发光/描边内侧）。
 * @param {number} mode 0 = 正常叠加, 1 = 相乘（内阴影/描边更暗时用）
 */
const compositeOnTop = (data, layerAlpha, color, opacity, mode) => {
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0, p = 0; i < layerAlpha.length; i++, p += 4) {
        const srcA = data[p + 3] / 255;
        const fxA = clamp01(layerAlpha[i] / 255) * opacity * srcA;
        if (fxA <= 0) {
            out[p] = data[p];
            out[p + 1] = data[p + 1];
            out[p + 2] = data[p + 2];
            out[p + 3] = data[p + 3];
            continue;
        }
        for (let c = 0; c < 3; c++) {
            const src = data[p + c] / 255;
            const blended = mode === 1 ? src * (color[c] / 255) : (src + color[c] / 255) / 2;
            out[p + c] = clamp255((blended * fxA + src * (1 - fxA)) * 255);
        }
        out[p + 3] = data[p + 3];
    }
    data.set(out);
    return data;
};

/** 把 alpha 蒙版按 (dx, dy) 平移 */
const offsetAlpha = (alpha, width, height, dx, dy) => {
    const out = new Float32Array(alpha.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const sx = clamp(x - dx, 0, width - 1);
            const sy = clamp(y - dy, 0, height - 1);
            out[y * width + x] = alpha[sy * width + sx];
        }
    }
    return out;
};

/** 用形态学膨胀近似"描边"：对 alpha 做半径 r 的最大值扩散 */
const dilateAlpha = (alpha, width, height, radius) => {
    const r = Math.round(radius);
    if (r <= 0) return alpha;
    const horizontal = new Float32Array(alpha.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let max = 0;
            for (let k = -r; k <= r; k++) {
                const v = alpha[y * width + clamp(x + k, 0, width - 1)];
                if (v > max) max = v;
            }
            horizontal[y * width + x] = max;
        }
    }
    const out = new Float32Array(alpha.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let max = 0;
            for (let k = -r; k <= r; k++) {
                const v = horizontal[clamp(y + k, 0, height - 1) * width + x];
                if (v > max) max = v;
            }
            out[y * width + x] = max;
        }
    }
    return out;
};

/** alpha 取反 */
const invertAlpha = alpha => {
    const out = new Float32Array(alpha.length);
    for (let i = 0; i < alpha.length; i++) out[i] = 255 - alpha[i];
    return out;
};

const multiplyAlpha = (a, b) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i] / 255;
    return out;
};

/**
 * 应用一组图层效果。
 * @param {ImageData} imageData 输入（不修改）
 * @param {object} effects 见 EFFECT_DEFAULTS，只处理 enabled 的效果
 * @returns {ImageData}
 */
const applyEffects = (imageData, effects) => {
    const {width, height} = imageData;
    const out = new ImageData(width, height);
    out.data.set(imageData.data);

    const stroke = effects.stroke;
    if (stroke && stroke.enabled && stroke.size > 0) {
        const alpha = extractAlpha(out.data);
        const dilated = dilateAlpha(alpha, width, height, stroke.size);
        const color = hexToRgb(stroke.color);
        if (stroke.inside) {
            // 内侧描边 = 膨胀区域减去原图形
            const inner = new Float32Array(dilated.length);
            for (let i = 0; i < dilated.length; i++) inner[i] = Math.max(0, dilated[i] - alpha[i]);
            compositeOnTop(out.data, inner, color, stroke.opacity / 100, 0);
        } else {
            const outer = new Float32Array(dilated.length);
            for (let i = 0; i < dilated.length; i++) outer[i] = Math.max(0, dilated[i] - alpha[i]);
            compositeUnderneath(out.data, outer, color, stroke.opacity / 100);
        }
    }

    const dropShadow = effects.dropShadow;
    if (dropShadow && dropShadow.enabled && dropShadow.opacity > 0) {
        const alpha = extractAlpha(out.data);
        const distance = dropShadow.distance;
        const rad = ((dropShadow.angle || 0) * Math.PI) / 180;
        const dx = Math.round(Math.cos(rad) * distance);
        const dy = Math.round(Math.sin(rad) * distance);
        const shifted = offsetAlpha(alpha, width, height, dx, dy);
        const blurred = gaussianBlurAlpha(shifted, width, height, dropShadow.blur);
        // 阴影只应出现在原图形之外
        const outside = multiplyAlpha(blurred, invertAlpha(alpha));
        compositeUnderneath(out.data, outside, hexToRgb(dropShadow.color), dropShadow.opacity / 100);
    }

    const innerShadow = effects.innerShadow;
    if (innerShadow && innerShadow.enabled && innerShadow.opacity > 0) {
        const alpha = extractAlpha(out.data);
        const distance = innerShadow.distance;
        const rad = ((innerShadow.angle || 0) * Math.PI) / 180;
        const dx = Math.round(Math.cos(rad) * distance);
        const dy = Math.round(Math.sin(rad) * distance);
        const shifted = offsetAlpha(alpha, width, height, dx, dy);
        const blurred = gaussianBlurAlpha(shifted, width, height, innerShadow.blur);
        const inside = multiplyAlpha(blurred, invertAlpha(alpha));
        compositeOnTop(out.data, inside, hexToRgb(innerShadow.color), innerShadow.opacity / 100, 1);
    }

    const outerGlow = effects.outerGlow;
    if (outerGlow && outerGlow.enabled && outerGlow.size > 0) {
        const alpha = extractAlpha(out.data);
        const blurred = gaussianBlurAlpha(alpha, width, height, outerGlow.size / 2);
        const outside = multiplyAlpha(blurred, invertAlpha(alpha));
        compositeUnderneath(out.data, outside, hexToRgb(outerGlow.color), outerGlow.opacity / 100);
    }

    const innerGlow = effects.innerGlow;
    if (innerGlow && innerGlow.enabled && innerGlow.size > 0) {
        const alpha = extractAlpha(out.data);
        const blurred = gaussianBlurAlpha(alpha, width, height, innerGlow.size / 2);
        const inside = multiplyAlpha(invertAlpha(blurred), alpha);
        compositeOnTop(out.data, inside, hexToRgb(innerGlow.color), innerGlow.opacity / 100, 0);
    }

    const colorOverlay = effects.colorOverlay;
    if (colorOverlay && colorOverlay.enabled && colorOverlay.opacity > 0) {
        const color = hexToRgb(colorOverlay.color);
        const out2 = new Uint8ClampedArray(out.data.length);
        for (let p = 0; p < out.data.length; p += 4) {
            const a = out.data[p + 3] / 255;
            const k = (colorOverlay.opacity / 100) * a;
            out2[p] = clamp255(out.data[p] * (1 - k) + color[0] * k);
            out2[p + 1] = clamp255(out.data[p + 1] * (1 - k) + color[1] * k);
            out2[p + 2] = clamp255(out.data[p + 2] * (1 - k) + color[2] * k);
            out2[p + 3] = out.data[p + 3];
        }
        out.data.set(out2);
    }

    return out;
};

const EFFECT_DEFAULTS = {
    stroke: {enabled: false, size: 2, color: '#000000', opacity: 100, inside: false},
    dropShadow: {enabled: false, angle: 120, distance: 5, blur: 5, color: '#000000', opacity: 60},
    innerShadow: {enabled: false, angle: 120, distance: 5, blur: 5, color: '#000000', opacity: 60},
    outerGlow: {enabled: false, size: 10, color: '#ffffff', opacity: 75},
    innerGlow: {enabled: false, size: 10, color: '#000000', opacity: 50},
    colorOverlay: {enabled: false, color: '#4b6bfb', opacity: 30}
};

export {applyEffects, EFFECT_DEFAULTS, hexToRgb, dilateAlpha, extractAlpha};
