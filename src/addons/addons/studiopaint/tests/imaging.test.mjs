// 在 Node 里跑一遍像素算法的冒烟测试：只测纯计算部分（imaging / effects）。
// 用法：node src/addons/addons/studiopaint/tests/imaging.test.mjs
import assert from 'node:assert';


class FakeImageData {
    constructor (width, height) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
    }
}
globalThis.ImageData = FakeImageData;

const base = new URL('../lib/', import.meta.url).href;
const imaging = await import(`${base}imaging.js`);
const effects = await import(`${base}effects.js`);

const makeImage = (w, h, fill) => {
    const img = new FakeImageData(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const color = fill(x, y);
            img.data[i] = color[0];
            img.data[i + 1] = color[1];
            img.data[i + 2] = color[2];
            img.data[i + 3] = color[3] === undefined ? 255 : color[3];
        }
    }
    return img;
};

const px = (img, x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

let passed = 0;
const test = (name, fn) => {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
};

/* 1. 反相 */
test('invert 翻转颜色且保留 alpha', () => {
    const img = makeImage(2, 2, () => [10, 20, 30, 128]);
    imaging.applyInvert(img.data);
    assert.deepStrictEqual(px(img, 0, 0), [245, 235, 225, 128]);
});

/* 2. 色阶 */
test('levels 黑场/白场裁剪正确', () => {
    const img = makeImage(1, 1, () => [128, 128, 128]);
    imaging.applyLevels(img.data, {rgb: [64, 192, 1, 0, 1]});
    // 128 -> (128-64)/(192-64) = 0.5 -> 127.5
    assert.ok(Math.abs(px(img, 0, 0)[0] - 128) <= 1, `got ${px(img, 0, 0)[0]}`);
});

/* 3. 曲线端点 */
test('curves 端点映射正确', () => {
    const lut = imaging.buildCurveLut([{x: 0, y: 20}, {x: 255, y: 240}]);
    assert.strictEqual(lut[0], 20);
    assert.strictEqual(lut[255], 240);
    const mid = lut[128];
    assert.ok(mid > 20 && mid < 240, `mid=${mid}`);
});

/* 4. 高斯模糊：均匀图不变、边缘不出现黑边 */
test('gaussian blur 保持均匀色且 alpha 不塌陷', () => {
    const img = makeImage(16, 16, () => [120, 130, 140]);
    imaging.gaussianBlurData(img.data, 16, 16, 3);
    const [r, g, b, a] = px(img, 8, 8);
    assert.ok(Math.abs(r - 120) <= 1 && Math.abs(g - 130) <= 1 && Math.abs(b - 140) <= 1, `${r},${g},${b}`);
    assert.strictEqual(a, 255);
});

test('gaussian blur 具备转置对称性（可抓垂直/水平索引错误）', () => {
    // A 是竖直分界，B 是其转置；可分离模糊必须满足 blur(A)(x,y) === blur(B)(y,x)
    const a = makeImage(16, 16, (x, y) => (x < 8 ? [0, 0, 0] : [255, 255, 255]));
    const b = makeImage(16, 16, (x, y) => (y < 8 ? [0, 0, 0] : [255, 255, 255]));
    imaging.gaussianBlurData(a.data, 16, 16, 2);
    imaging.gaussianBlurData(b.data, 16, 16, 2);
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            const fromA = a.data[(y * 16 + x) * 4];
            const fromB = b.data[(x * 16 + y) * 4];
            assert.ok(Math.abs(fromA - fromB) <= 1,
                `(${x},${y}) A=${fromA} B 转置=${fromB} 差异过大`);
        }
    }
});

test('gaussian blur 会把黑白竖条边界抹平', () => {
    const img = makeImage(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255]));
    imaging.gaussianBlurData(img.data, 16, 16, 2);
    const left = px(img, 1, 8)[0];
    const middle = px(img, 8, 8)[0];
    const right = px(img, 14, 8)[0];
    assert.ok(left < 10, `远离边界的黑区应保持黑色，实际 ${left}`);
    assert.ok(middle > 100 && middle < 160, `边界应呈过渡灰，实际 ${middle}`);
    assert.ok(right > 245, `白区应保持白色，实际 ${right}`);
});

/* 5. 动感模糊 */
test('motion blur 抹平竖条纹', () => {
    const img = makeImage(32, 32, (x, y) => ((x + y) % 8 < 4 ? [0, 0, 0] : [255, 255, 255]));
    imaging.applyMotionBlur(img.data, 32, 32, {angle: 45, distance: 12});
    const center = px(img, 16, 16);
    assert.ok(center[0] > 40 && center[0] < 215, `中心灰度 ${center[0]} 应介于黑白之间`);
});

/* 6. 辉光只提亮高光 */
test('bloom 提亮亮部且不压暗暗部', () => {
    const img = makeImage(16, 16, (x, y) => (x < 8 ? [20, 20, 20] : [250, 250, 250]));
    const before = px(img, 2, 8);
    imaging.applyBloom(img.data, 16, 16, {threshold: 0.8, radius: 3, intensity: 0.5});
    const after = px(img, 2, 8);
    assert.ok(after[0] >= before[0], `暗部不应变暗: ${before[0]} -> ${after[0]}`);
    assert.ok(px(img, 12, 8)[0] >= 250);
});

/* 7. 锐化 */
test('sharpen 不改变平坦区域', () => {
    const img = makeImage(16, 16, () => [100, 100, 100]);
    imaging.applySharpen(img.data, 16, 16, {amount: 1, radius: 2});
    assert.ok(Math.abs(px(img, 8, 8)[0] - 100) <= 1);
});

/* 8. 暗角 */
test('vignette 压暗四角、保持中心', () => {
    const img = makeImage(32, 32, () => [200, 200, 200]);
    imaging.applyVignette(img.data, 32, 32, {amount: 0.8, midpoint: 0.2, feather: 0.6});
    assert.strictEqual(px(img, 16, 16)[0], 200);
    assert.ok(px(img, 0, 0)[0] < 160, `角落应被压暗，实际 ${px(img, 0, 0)[0]}`);
});

/* 9. 颗粒可复现 */
test('grain 同一 seed 结果一致', () => {
    const a = makeImage(8, 8, () => [128, 128, 128]);
    const b = makeImage(8, 8, () => [128, 128, 128]);
    imaging.applyGrain(a.data, {amount: 20, seed: 7, monochromatic: true, gaussian: true});
    imaging.applyGrain(b.data, {amount: 20, seed: 7, monochromatic: true, gaussian: true});
    assert.deepStrictEqual(Array.from(a.data), Array.from(b.data));
});

/* 10. 色相饱和度 */
test('hue shift 把红色转成绿色', () => {
    const img = makeImage(1, 1, () => [255, 0, 0]);
    imaging.applyHueSaturation(img.data, {hue: 120, saturation: 0, lightness: 0});
    const [r, g] = px(img, 0, 0);
    assert.ok(g > 200 && r < 60, `得到 ${r},${g},${px(img, 0, 0)[2]}`);
});

/* 11. 曝光 */
test('exposure +1EV 提亮中间调', () => {
    const img = makeImage(1, 1, () => [128, 128, 128]);
    imaging.applyExposure(img.data, {exposure: 1, offset: 0, gamma: 1});
    assert.ok(px(img, 0, 0)[0] > 160, `实际 ${px(img, 0, 0)[0]}`);
});

/* 12. 直方图 */
test('histogram 统计桶数量正确且忽略全透明像素', () => {
    const img = makeImage(2, 2, (x, y) => (x === 0 && y === 0 ? [10, 10, 10, 255] : [0, 0, 0, 0]));
    const hist = imaging.computeHistogram(img.data);
    assert.strictEqual(hist.r[10], 1);
    assert.strictEqual(hist.r.reduce((sum, v) => sum + v, 0), 1);
});

/* 13. 像素化 */
test('pixelate 把棋盘压成纯色块', () => {
    const img = makeImage(16, 16, (x, y) => ((x + y) % 2 ? [0, 0, 0] : [255, 255, 255]));
    imaging.applyPixelate(img.data, 16, 16, {size: 8});
    assert.strictEqual(px(img, 0, 0)[0], px(img, 3, 0)[0]);
});

/* 14. 图层效果：描边在外侧生成新像素 */
test('stroke 在图形外侧长出一圈', () => {
    const img = makeImage(24, 24, (x, y) => (x >= 8 && x < 16 && y >= 8 && y < 16 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const out = effects.applyEffects(img, {
        stroke: {enabled: true, size: 3, color: '#0000ff', opacity: 100, inside: false}
    });
    const at = (x, y) => [out.data[(y * 24 + x) * 4], out.data[(y * 24 + x) * 4 + 1], out.data[(y * 24 + x) * 4 + 2], out.data[(y * 24 + x) * 4 + 3]];
    // 正方形左侧 3 像素处：应为不透明蓝色描边
    assert.deepStrictEqual(at(5, 12), [0, 0, 255, 255], `描边应为纯蓝，实际 ${at(5, 12)}`);
    // 更远处应保持透明
    assert.deepStrictEqual(at(2, 12), [0, 0, 0, 0], `描边范围外应透明，实际 ${at(2, 12)}`);
    // 原像素保持红色
    assert.deepStrictEqual(at(12, 12), [255, 0, 0, 255], `原图应不变，实际 ${at(12, 12)}`);
});

/* 15. 投影在右下方出现 */
test('drop shadow 落在指定角度的一侧', () => {
    const img = makeImage(40, 40, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    const out = effects.applyEffects(img, {
        dropShadow: {enabled: true, angle: 0, distance: 6, blur: 2, color: '#ff0000', opacity: 100}
    });
    const shadowX = out.data[(14 * 40 + 24) * 4 + 3];
    assert.ok(shadowX > 20, `投影应出现在右侧，实际 alpha=${shadowX}`);
    const leftSide = out.data[(14 * 40 + 2) * 4 + 3];
    assert.ok(leftSide < 20, `左侧不应有投影，实际 alpha=${leftSide}`);
});

/* 16. 颜色叠加 */
test('color overlay 按不透明度混色且不破坏 alpha', () => {
    const img = makeImage(2, 2, () => [0, 0, 0, 255]);
    const out = effects.applyEffects(img, {
        colorOverlay: {enabled: true, color: '#ffffff', opacity: 50}
    });
    const [r, g, b, a] = px(out, 0, 0);
    assert.ok(Math.abs(r - 128) <= 2 && g === r && b === r, `50% 白叠加到黑应得约 128，实际 ${r}`);
    assert.strictEqual(a, 255, 'alpha 不应改变');
});

test('color overlay 在半透明像素上按 alpha 收敛（避免硬边光晕）', () => {
    const img = makeImage(2, 2, () => [0, 0, 0, 128]);
    const out = effects.applyEffects(img, {
        colorOverlay: {enabled: true, color: '#ffffff', opacity: 100}
    });
    const [r, , , a] = px(out, 0, 0);
    assert.ok(r < 130, `半透明处不应被涂满，实际 ${r}`);
    assert.strictEqual(a, 128);
});

/* 17. 渲染管线端到端 */
test('renderPipeline 串起调整 + 滤镜', () => {
    const img = makeImage(16, 16, () => [100, 120, 140]);
    const pipeline = JSON.parse(JSON.stringify(imaging.IMAGE_DEFAULTS));
    pipeline.invert.enabled = true;
    pipeline.exposure.enabled = true;
    pipeline.exposure.exposure = 1;
    pipeline.tone.gaussianBlur.enabled = true;
    pipeline.tone.gaussianBlur.radius = 2;
    const out = imaging.renderPipeline(img, pipeline);
    assert.ok(out.data[0] > img.data[0], `反相+曝光后应更亮：${img.data[0]} -> ${out.data[0]}`);
    assert.strictEqual(out.width, 16);
});

console.log(`\n全部 ${passed} 项通过`);
