// 变换类操作：旋转、缩放、翻转、裁剪、画布尺寸、裁掉透明边。
// 全部以 Canvas 为输入输出，保留原始像素以便随时重算。

const createCanvas = (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
};

const getContext = canvas => canvas.getContext('2d', {willReadFrequently: true});

/**
 * 旋转 + 缩放 + 翻转。旋转以画布中心为轴，角度为顺时针。
 * @param {HTMLCanvasElement} source - 输入画布
 * @param {object} options - rotate 度, scale 百分比, flipH, flipV, resample 取 smooth 或 pixelated
 * @returns {HTMLCanvasElement} 变换后的新画布
 */
const transformCanvas = (source, options) => {
    const rotate = ((options.rotate || 0) % 360 + 360) % 360;
    const scale = (options.scale === undefined ? 100 : options.scale) / 100;
    const flipH = Boolean(options.flipH);
    const flipV = Boolean(options.flipV);
    if (!rotate && scale === 1 && !flipH && !flipV) return source;

    const rad = (rotate * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const srcW = source.width;
    const srcH = source.height;
    // 先按缩放后的尺寸算外接矩形，再套用旋转
    const scaledW = srcW * scale;
    const scaledH = srcH * scale;
    const outW = Math.max(1, Math.round(scaledW * cos + scaledH * sin));
    const outH = Math.max(1, Math.round(scaledW * sin + scaledH * cos));

    const target = createCanvas(outW, outH);
    const ctx = getContext(target);
    ctx.imageSmoothingEnabled = options.resample !== 'pixelated';
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate(rad);
    ctx.scale(flipH ? -scale : scale, flipV ? -scale : scale);
    ctx.drawImage(source, -srcW / 2, -srcH / 2);
    ctx.restore();
    return target;
};

/**
 * 裁剪。rect 为像素坐标，超出部分自动裁到画布内。
 */
const cropCanvas = (source, rect) => {
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const width = Math.max(1, Math.min(source.width - x, Math.round(rect.width)));
    const height = Math.max(1, Math.min(source.height - y, Math.round(rect.height)));
    const target = createCanvas(width, height);
    const ctx = getContext(target);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
    return target;
};

/**
 * 改变画布尺寸，anchor 为 [0..1, 0..1] 表示原图在新画布中的相对位置。
 */
const resizeCanvas = (source, width, height, anchor) => {
    const target = createCanvas(width, height);
    const ctx = getContext(target);
    ctx.imageSmoothingQuality = 'high';
    const [ax, ay] = anchor || [0.5, 0.5];
    const x = Math.round((width - source.width) * ax);
    const y = Math.round((height - source.height) * ay);
    ctx.drawImage(source, x, y);
    return target;
};

/**
 * 裁掉四周透明像素。
 * @param {number} threshold 容差 0..255
 */
const trimTransparent = (source, threshold) => {
    const ctx = getContext(source);
    const data = ctx.getImageData(0, 0, source.width, source.height).data;
    const tol = threshold || 0;
    let minX = source.width;
    let minY = source.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < source.height; y++) {
        for (let x = 0; x < source.width; x++) {
            if (data[(y * source.width + x) * 4 + 3] > tol) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return source; // 全透明，保持原样
    return cropCanvas(source, {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1
    });
};

/** 90 度步进的旋转，导出为无损像素搬移 */
const rotateCanvas90 = (source, direction) => {
    const turns = ((direction % 4) + 4) % 4;
    if (turns === 0) return source;
    const swap = turns % 2 === 1;
    const target = createCanvas(swap ? source.height : source.width, swap ? source.width : source.height);
    const ctx = getContext(target);
    ctx.imageSmoothingEnabled = false;
    ctx.translate(target.width / 2, target.height / 2);
    ctx.rotate((turns * Math.PI) / 2);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    return target;
};

export {createCanvas, getContext, transformCanvas, cropCanvas, resizeCanvas, trimTransparent, rotateCanvas90};
