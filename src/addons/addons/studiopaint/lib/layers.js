// 轻量图层堆栈。
// scratch-paint 内部只有一张位图，没有多图层概念，所以本插件自己维护图层栈：
// 每个图层是一张与画板等大的离屏 canvas，最终按混合模式合成回位图。

import {createCanvas, getContext} from './transform.js';

const BLEND_MODES = [
    {value: 'source-over', label: '正常'},
    {value: 'multiply', label: '正片叠底'},
    {value: 'screen', label: '滤色'},
    {value: 'overlay', label: '叠加'},
    {value: 'darken', label: '变暗'},
    {value: 'lighten', label: '变亮'},
    {value: 'color-dodge', label: '颜色减淡'},
    {value: 'color-burn', label: '颜色加深'},
    {value: 'hard-light', label: '强光'},
    {value: 'soft-light', label: '柔光'},
    {value: 'difference', label: '差值'},
    {value: 'exclusion', label: '排除'},
    {value: 'hue', label: '色相'},
    {value: 'saturation', label: '饱和度'},
    {value: 'color', label: '颜色'},
    {value: 'luminosity', label: '明度'}
];

let layerIdSeed = 1;

const createLayer = (width, height, name) => {
    const canvas = createCanvas(width, height);
    return {
        id: `layer-${layerIdSeed++}`,
        name: name || `图层 ${layerIdSeed}`,
        canvas,
        visible: true,
        opacity: 1,
        blendMode: 'source-over',
        locked: false
    };
};

/**
 * 用当前画布内容初始化图层栈。
 * @param {HTMLCanvasElement} baseCanvas 当前 costume 的像素
 * @returns {{layers: Array, selectedId: string, width: number, height: number}}
 */
const createStack = baseCanvas => {
    const base = createLayer(baseCanvas.width, baseCanvas.height, '背景');
    getContext(base.canvas).drawImage(baseCanvas, 0, 0);
    return {
        layers: [base],
        selectedId: base.id,
        width: baseCanvas.width,
        height: baseCanvas.height
    };
};

const getSelectedLayer = stack =>
    stack.layers.find(l => l.id === stack.selectedId) || stack.layers[stack.layers.length - 1];

const selectLayer = (stack, id) => {
    if (stack.layers.some(l => l.id === id)) stack.selectedId = id;
    return stack;
};

/** 从当前选区内容新建一个图层 */
const addLayerFromCanvas = (stack, sourceCanvas, name) => {
    const layer = createLayer(stack.width, stack.height, name);
    if (sourceCanvas) getContext(layer.canvas).drawImage(sourceCanvas, 0, 0);
    const index = stack.layers.findIndex(l => l.id === stack.selectedId);
    stack.layers.splice(index + 1, 0, layer);
    stack.selectedId = layer.id;
    return layer;
};

const duplicateLayer = stack => {
    const source = getSelectedLayer(stack);
    if (!source) return null;
    const layer = createLayer(stack.width, stack.height, `${source.name} 副本`);
    getContext(layer.canvas).drawImage(source.canvas, 0, 0);
    layer.opacity = source.opacity;
    layer.blendMode = source.blendMode;
    layer.visible = source.visible;
    const index = stack.layers.indexOf(source);
    stack.layers.splice(index + 1, 0, layer);
    stack.selectedId = layer.id;
    return layer;
};

const deleteLayer = stack => {
    if (stack.layers.length <= 1) return false;
    const index = stack.layers.findIndex(l => l.id === stack.selectedId);
    if (index < 0) return false;
    stack.layers.splice(index, 1);
    stack.selectedId = stack.layers[Math.min(index, stack.layers.length - 1)].id;
    return true;
};

/** delta 为 +1（上移一层）或 -1（下移一层） */
const moveLayer = (stack, delta) => {
    const index = stack.layers.findIndex(l => l.id === stack.selectedId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= stack.layers.length) return false;
    const [layer] = stack.layers.splice(index, 1);
    stack.layers.splice(target, 0, layer);
    return true;
};

/** 与下一层合并 */
const mergeDown = stack => {
    if (stack.layers.length <= 1) return false;
    const index = stack.layers.findIndex(l => l.id === stack.selectedId);
    if (index <= 0) return false;
    const top = stack.layers[index];
    const bottom = stack.layers[index - 1];
    const ctx = getContext(bottom.canvas);
    ctx.save();
    ctx.globalAlpha = top.visible ? top.opacity : 0;
    ctx.globalCompositeOperation = top.blendMode;
    ctx.drawImage(top.canvas, 0, 0);
    ctx.restore();
    stack.layers.splice(index, 1);
    stack.selectedId = bottom.id;
    return true;
};

/** 按当前可见性与混合模式把整个图层栈合成为一张画布 */
const compositeStack = stack => {
    const target = createCanvas(stack.width, stack.height);
    const ctx = getContext(target);
    for (const layer of stack.layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = layer.blendMode;
        ctx.drawImage(layer.canvas, 0, 0);
        ctx.restore();
    }
    return target;
};

/** 把 base 之外的图层烘焙进 base（应用时调用），并清空为单层 */
const flattenIntoBase = stack => {
    const composited = compositeStack(stack);
    const base = stack.layers[0];
    getContext(base.canvas).clearRect(0, 0, base.canvas.width, base.canvas.height);
    getContext(base.canvas).drawImage(composited, 0, 0);
    base.opacity = 1;
    base.blendMode = 'source-over';
    base.visible = true;
    stack.layers = [base];
    stack.selectedId = base.id;
    return base.canvas;
};

export {
    BLEND_MODES,
    createStack,
    createLayer,
    getSelectedLayer,
    selectLayer,
    addLayerFromCanvas,
    duplicateLayer,
    deleteLayer,
    moveLayer,
    mergeDown,
    compositeStack,
    flattenIntoBase
};
