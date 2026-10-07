// 面板 UI：Photoshop 风格的调整/滤镜/效果/变换/图层侧栏。
// 纯 DOM 构建，无框架依赖；所有控件都会触发实时预览。
// 说明：控件回调（apply/action）在用户交互时才执行，因此引用下方定义的函数是安全的。
/* eslint-disable no-use-before-define */

import {IMAGE_DEFAULTS, renderPipeline, computeHistogram} from './imaging.js';
import {EFFECT_DEFAULTS, applyEffects} from './effects.js';
import {createCanvas, getContext, transformCanvas, cropCanvas, resizeCanvas, trimTransparent} from './transform.js';
import {
    BLEND_MODES,
    createStack,
    getSelectedLayer,
    selectLayer,
    addLayerFromCanvas,
    duplicateLayer,
    deleteLayer,
    moveLayer,
    mergeDown,
    compositeStack
} from './layers.js';

const deepClone = value => JSON.parse(JSON.stringify(value));

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === 'string') node.textContent = text;
    return node;
};

/* ------------------------------------------------------------------ *
 * 控件工厂
 * ------------------------------------------------------------------ */

class Panel {
    constructor (root, options) {
        this.root = root;
        this.onChange = options.onChange;
        this.onAction = options.onAction;
        this.status = el('div', 'sp-status', '');
        this.buildHeader();
        this.tabs = el('div', 'sp-tabs');
        this.body = el('div', 'sp-body');
        this.root.appendChild(this.tabs);
        this.root.appendChild(this.body);
        this.root.appendChild(this.buildFooter());
        this.root.appendChild(this.status);
    }

    buildHeader () {
        const header = el('div', 'sp-header');
        header.appendChild(el('div', 'sp-title', '造像工作室'));
        const close = el('button', 'sp-close', '×');
        close.title = '关闭面板';
        close.addEventListener('click', () => this.onAction('close'));
        header.appendChild(close);
        this.root.appendChild(header);
    }

    buildFooter () {
        const footer = el('div', 'sp-footer');
        const apply = el('button', 'sp-btn sp-btn-primary', '应用');
        apply.addEventListener('click', () => this.onAction('apply'));
        const reset = el('button', 'sp-btn', '重置');
        reset.addEventListener('click', () => this.onAction('reset'));
        const revert = el('button', 'sp-btn', '取消预览');
        revert.addEventListener('click', () => this.onAction('revert'));
        footer.appendChild(apply);
        footer.appendChild(reset);
        footer.appendChild(revert);
        return footer;
    }

    addTab (id, label) {
        const tab = el('button', 'sp-tab', label);
        tab.dataset.tab = id;
        tab.addEventListener('click', () => this.selectTab(id));
        this.tabs.appendChild(tab);
        return tab;
    }

    selectTab (id) {
        for (const tab of this.tabs.children) {
            tab.classList.toggle('is-active', tab.dataset.tab === id);
        }
        for (const pane of this.body.children) {
            pane.style.display = pane.dataset.pane === id ? '' : 'none';
        }
    }

    addPane (id) {
        const pane = el('div', 'sp-pane');
        pane.dataset.pane = id;
        pane.style.display = 'none';
        this.body.appendChild(pane);
        return pane;
    }

    setStatus (text, isError) {
        this.status.textContent = text || '';
        this.status.classList.toggle('is-error', Boolean(isError));
    }
}

// 折叠分组
const section = (parent, title, options) => {
    const wrap = el('div', 'sp-section');
    const header = el('div', 'sp-section-header');
    header.appendChild(el('span', 'sp-section-title', title));
    const enable = el('input', 'sp-check');
    enable.type = 'checkbox';
    enable.checked = Boolean(options && options.enabled);
    header.appendChild(enable);
    const body = el('div', 'sp-section-body');
    wrap.appendChild(header);
    wrap.appendChild(body);
    parent.appendChild(wrap);
    header.addEventListener('click', event => {
        if (event.target === enable) return;
        wrap.classList.toggle('is-collapsed');
    });
    if (!enable.checked) wrap.classList.add('is-collapsed');
    return {
        root: wrap,
        body,
        enable,
        setEnabled (value) {
            enable.checked = value;
            wrap.classList.toggle('is-collapsed', !value);
        }
    };
};

// 滑块 + 数字输入
const slider = (parent, label, config) => {
    const {min, max, step = 1, value, format, onInput} = config;
    const row = el('label', 'sp-row');
    const name = el('span', 'sp-row-label', label);
    const input = el('input', 'sp-slider');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    const number = el('input', 'sp-number');
    number.type = 'number';
    number.min = min;
    number.max = max;
    number.step = step;
    number.value = value;
    const fmt = format || (v => v);
    const sync = v => {
        const clamped = Math.min(max, Math.max(min, v));
        input.value = clamped;
        number.value = clamped;
        name.textContent = `${label}: ${fmt(clamped)}`;
    };
    input.addEventListener('input', () => {
        sync(Number(input.value));
        onInput(Number(input.value));
    });
    number.addEventListener('change', () => {
        sync(Number(number.value));
        onInput(Number(number.value));
    });
    sync(value);
    row.appendChild(name);
    row.appendChild(input);
    row.appendChild(number);
    parent.appendChild(row);
    return {
        set (v) {
            sync(v);
        },
        row
    };
};

// 颜色选择
const colorField = (parent, label, value, onInput) => {
    const row = el('label', 'sp-row');
    row.appendChild(el('span', 'sp-row-label', label));
    const input = el('input', 'sp-color');
    input.type = 'color';
    input.value = value;
    const hex = el('span', 'sp-color-hex', value.toUpperCase());
    input.addEventListener('input', () => {
        hex.textContent = input.value.toUpperCase();
        onInput(input.value);
    });
    row.appendChild(input);
    row.appendChild(hex);
    parent.appendChild(row);
    return input;
};

// 下拉框
const select = (parent, label, options, value, onInput) => {
    const row = el('label', 'sp-row');
    row.appendChild(el('span', 'sp-row-label', label));
    const input = el('select', 'sp-select');
    for (const option of options) {
        const node = el('option', null, option.label);
        node.value = option.value;
        input.appendChild(node);
    }
    input.value = value;
    input.addEventListener('change', () => onInput(input.value));
    row.appendChild(input);
    parent.appendChild(row);
    return input;
};

// 一排按钮
const buttons = (parent, definitions) => {
    const row = el('div', 'sp-buttons');
    for (const definition of definitions) {
        const button = el('button', 'sp-btn sp-btn-small', definition.label);
        button.addEventListener('click', definition.onClick);
        row.appendChild(button);
    }
    parent.appendChild(row);
    return row;
};

// 曲线编辑器：可拖动控制点，实时输出查找表预览
class CurveEditor {
    constructor (parent, initialPoints, onChange) {
        this.canvas = el('canvas', 'sp-curve');
        this.canvas.width = 220;
        this.canvas.height = 220;
        this.ctx = this.canvas.getContext('2d');
        this.points = (initialPoints || [{x: 0, y: 0}, {x: 255, y: 255}]).map(p => ({...p}));
        this.onChange = onChange;
        this.dragIndex = -1;
        parent.appendChild(this.canvas);
        this.bind();
        this.draw();
    }

    bind () {
        const toPoint = event => {
            const rect = this.canvas.getBoundingClientRect();
            return {
                x: ((event.clientX - rect.left) / rect.width) * 255,
                y: 255 - (((event.clientY - rect.top) / rect.height) * 255)
            };
        };
        this.canvas.addEventListener('mousedown', event => {
            const p = toPoint(event);
            let best = -1;
            let bestDist = 16;
            for (let i = 0; i < this.points.length; i++) {
                const d = Math.hypot(this.points[i].x - p.x, this.points[i].y - p.y);
                if (d < bestDist) {
                    bestDist = d;
                    best = i;
                }
            }
            if (best >= 0) this.dragIndex = best;
            this.move(p);
        });
        window.addEventListener('mousemove', event => {
            if (this.dragIndex >= 0) this.move(toPoint(event));
        });
        window.addEventListener('mouseup', () => {
            if (this.dragIndex >= 0) {
                this.dragIndex = -1;
                this.onChange(this.points.map(p => ({...p})));
            }
        });
        this.canvas.addEventListener('dblclick', event => {
            const p = toPoint(event);
            if (this.points.length >= 2 && this.points[0].x !== 0) {
                this.points.shift();
                this.points.push({x: 0, y: 0});
            }
            this.points.push({
                x: Math.round(Math.min(255, Math.max(0, p.x))),
                y: Math.round(Math.min(255, Math.max(0, p.y)))
            });
            this.points.sort((a, b) => a.x - b.x);
            this.dragIndex = -1;
            this.draw();
            this.onChange(this.points.map(pt => ({...pt})));
        });
    }

    move (p) {
        const index = this.dragIndex;
        if (index < 0) return;
        const point = this.points[index];
        const isEnd = index === 0 || index === this.points.length - 1;
        point.y = Math.round(Math.min(255, Math.max(0, p.y)));
        if (!isEnd) {
            const minX = this.points[index - 1].x + 1;
            const maxX = this.points[index + 1].x - 1;
            point.x = Math.round(Math.min(maxX, Math.max(minX, p.x)));
        }
        this.draw();
        this.onChange(this.points.map(pt => ({...pt})));
    }

    reset () {
        this.points = [{x: 0, y: 0}, {x: 255, y: 255}];
        this.draw();
        this.onChange(this.points.map(p => ({...p})));
    }

    draw () {
        const ctx = this.ctx;
        const size = this.canvas.width;
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = '#202124';
        ctx.fillRect(0, 0, size, size);
        ctx.strokeStyle = '#3c4043';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
            const p = (size / 4) * i;
            ctx.beginPath();
            ctx.moveTo(p, 0);
            ctx.lineTo(p, size);
            ctx.moveTo(0, p);
            ctx.lineTo(size, p);
            ctx.stroke();
        }
        ctx.strokeStyle = '#9aa0a6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 0; x <= 255; x++) {
            let y;
            if (x <= this.points[0].x) {
                y = this.points[0].y;
            } else if (x >= this.points[this.points.length - 1].x) {
                y = this.points[this.points.length - 1].y;
            } else {
                let i = 0;
                while (i < this.points.length - 2 && x > this.points[i + 1].x) i++;
                const a = this.points[i];
                const b = this.points[i + 1];
                const t = (x - a.x) / Math.max(1e-6, b.x - a.x);
                y = a.y + ((b.y - a.y) * t);
            }
            const px = (x / 255) * size;
            const py = size - ((y / 255) * size);
            if (x === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.fillStyle = '#8ab4f8';
        for (const point of this.points) {
            const px = (point.x / 255) * size;
            const py = size - ((point.y / 255) * size);
            ctx.beginPath();
            ctx.arc(px, py, 5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

// 直方图
class Histogram {
    constructor (parent) {
        this.canvas = el('canvas', 'sp-histogram');
        this.canvas.width = 240;
        this.canvas.height = 110;
        this.ctx = this.canvas.getContext('2d');
        this.mode = 'l';
        parent.appendChild(this.canvas);
        this.modeSelect = select(parent, '通道', [
            {value: 'l', label: '明度'},
            {value: 'r', label: '红'},
            {value: 'g', label: '绿'},
            {value: 'b', label: '蓝'}
        ], 'l', value => {
            this.mode = value;
            if (this.last) this.render(this.last);
        });
        this.last = null;
    }

    update (imageData) {
        this.last = computeHistogram(imageData.data);
        this.render(this.last);
    }

    render (histogram) {
        const ctx = this.ctx;
        const {width, height} = this.canvas;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#202124';
        ctx.fillRect(0, 0, width, height);
        const values = histogram[this.mode];
        let max = 1;
        for (const value of values) if (value > max) max = value;
        const colors = {r: '#f28b82', g: '#81c995', b: '#8ab4f8', l: '#e8eaed'};
        ctx.fillStyle = colors[this.mode] || colors.l;
        for (let i = 0; i < 256; i++) {
            const barHeight = (values[i] / max) * (height - 4);
            const x = (i / 256) * width;
            ctx.fillRect(x, height - barHeight, width / 256, barHeight);
        }
    }
}

/* ------------------------------------------------------------------ *
 * 面板内容构建
 * ------------------------------------------------------------------ */

const imageDataToCanvas = imageData => {
    const canvas = createCanvas(imageData.width, imageData.height);
    getContext(canvas).putImageData(imageData, 0, 0);
    return canvas;
};

const canvasToImageData = canvas => getContext(canvas).getImageData(0, 0, canvas.width, canvas.height);

/**
 * 创建整个面板。
 * @param {object} adapter - PaintAdapter 实例
 * @returns {{root: HTMLElement, state: object, panel: object}} 面板句柄
 */
const createStudioPanel = adapter => {
    const state = {
        pipeline: deepClone(IMAGE_DEFAULTS),
        effects: deepClone(EFFECT_DEFAULTS),
        transform: {rotate: 0, scale: 100, flipH: false, flipV: false},
        stack: null
    };

    const root = el('div', 'sp-root sa-studiopaint-panel');
    const panel = new Panel(root, {
        onChange: () => schedulePreview(),
        onAction: action => handleAction(action)
    });

    let previewTimer = null;
    let baseCanvas = null;

    const schedulePreview = () => {
        if (previewTimer) return;
        previewTimer = window.setTimeout(() => {
            previewTimer = null;
            renderPreview();
        }, 40);
    };

    const ensureBase = () => {
        const current = adapter.readCanvas();
        if (!current) {
            panel.setStatus('无法读取位图像素', true);
            return null;
        }
        if (!baseCanvas) baseCanvas = current;
        return baseCanvas;
    };

    const renderPreview = () => {
        const base = ensureBase();
        if (!base) return;
        const baseData = canvasToImageData(base);
        let imageData = renderPipeline(baseData, state.pipeline);
        const hasEffects = Object.values(state.effects).some(e => e.enabled);
        if (hasEffects) {
            imageData = applyEffects(imageData, state.effects);
        }
        histogram.update(imageData);
        let canvas = imageDataToCanvas(imageData);
        const t = state.transform;
        if (t.rotate || t.scale !== 100 || t.flipH || t.flipV) {
            canvas = transformCanvas(canvas, t);
        }
        if (state.cropWidth || state.cropHeight) {
            const width = state.cropWidth || canvas.width;
            const height = state.cropHeight || canvas.height;
            const x = Math.round((canvas.width - width) / 2);
            const y = Math.round((canvas.height - height) / 2);
            canvas = cropCanvas(canvas, {x, y, width, height});
        }
        if (adapter.preview(canvas)) {
            panel.setStatus(`预览 ${canvas.width} × ${canvas.height}`);
        }
    };

    /* ---------------- 调整 ---------------- */

    panel.addTab('adjust', '调整');
    const adjustPane = panel.addPane('adjust');

    const levelsSection = section(adjustPane, '色阶', {enabled: false});
    state.pipeline.levels.channels = {
        rgb: [0, 255, 1, 0, 1],
        r: [0, 255, 1, 0, 1],
        g: [0, 255, 1, 0, 1],
        b: [0, 255, 1, 0, 1]
    };
    const levelChannelNames = {rgb: 'RGB', r: '红', g: '绿', b: '蓝'};
    for (const key of ['rgb', 'r', 'g', 'b']) {
        const channel = key;
        const channelRow = el('div', 'sp-subgroup');
        channelRow.appendChild(el('div', 'sp-subgroup-title', levelChannelNames[channel]));
        levelsSection.body.appendChild(channelRow);
        slider(channelRow, '黑场', {
            min: 0,
            max: 254,
            value: 0,
            onInput: v => {
                state.pipeline.levels.channels[channel][0] = v;
                schedulePreview();
            }
        });
        slider(channelRow, '白场', {
            min: 1,
            max: 255,
            value: 255,
            onInput: v => {
                state.pipeline.levels.channels[channel][1] = v;
                schedulePreview();
            }
        });
        slider(channelRow, '灰度系数', {
            min: 0.1,
            max: 4,
            step: 0.01,
            value: 1,
            format: v => v.toFixed(2),
            onInput: v => {
                state.pipeline.levels.channels[channel][2] = v;
                schedulePreview();
            }
        });
        slider(channelRow, '输出黑场', {
            min: 0,
            max: 1,
            step: 0.01,
            value: 0,
            format: v => v.toFixed(2),
            onInput: v => {
                state.pipeline.levels.channels[channel][3] = v;
                schedulePreview();
            }
        });
        slider(channelRow, '输出白场', {
            min: 0,
            max: 1,
            step: 0.01,
            value: 1,
            format: v => v.toFixed(2),
            onInput: v => {
                state.pipeline.levels.channels[channel][4] = v;
                schedulePreview();
            }
        });
    }
    buttons(levelsSection.body, [
        {label: '自动', onClick: () => autoLevels()},
        {label: '重置', onClick: () => resetLevels()}
    ]);

    const autoLevels = () => {
        const base = ensureBase();
        if (!base) return;
        const data = canvasToImageData(base).data;
        let min = 255;
        let max = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] === 0) continue;
            const l = (0.2126 * data[i]) + (0.7152 * data[i + 1]) + (0.0722 * data[i + 2]);
            if (l < min) min = l;
            if (l > max) max = l;
        }
        const inLow = Math.floor(min);
        const inHigh = Math.ceil(max);
        for (const key of ['rgb', 'r', 'g', 'b']) {
            state.pipeline.levels.channels[key][0] = inLow;
            state.pipeline.levels.channels[key][1] = inHigh;
        }
        panel.setStatus(`自动色阶: ${inLow} - ${inHigh}`);
        schedulePreview();
    };

    const resetLevels = () => {
        for (const key of ['rgb', 'r', 'g', 'b']) {
            state.pipeline.levels.channels[key] = [0, 255, 1, 0, 1];
        }
        schedulePreview();
    };

    const curvesSection = section(adjustPane, '曲线', {enabled: false});
    state.pipeline.curves.channels = {rgb: [{x: 0, y: 0}, {x: 255, y: 255}]};
    for (const key of ['rgb', 'r', 'g', 'b']) {
        const channel = key;
        const group = el('div', 'sp-subgroup');
        group.appendChild(el('div', 'sp-subgroup-title', levelChannelNames[channel]));
        curvesSection.body.appendChild(group);
        const editor = new CurveEditor(group, [{x: 0, y: 0}, {x: 255, y: 255}], points => {
            state.pipeline.curves.channels[channel] = points;
            schedulePreview();
        });
        group.appendChild(el('div', 'sp-hint', '拖动控制点调整，双击添加控制点'));
        buttons(group, [{label: '重置通道', onClick: () => editor.reset()}]);
    }

    const exposureSection = section(adjustPane, '曝光', {enabled: false});
    slider(exposureSection.body, '曝光', {
        min: -5,
        max: 5,
        step: 0.05,
        value: 0,
        format: v => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`,
        onInput: v => {
            state.pipeline.exposure.exposure = v;
            schedulePreview();
        }
    });
    slider(exposureSection.body, '偏移', {
        min: -0.5,
        max: 0.5,
        step: 0.01,
        value: 0,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.exposure.offset = v;
            schedulePreview();
        }
    });
    slider(exposureSection.body, '伽马', {
        min: 0.2,
        max: 3,
        step: 0.01,
        value: 1,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.exposure.gamma = v;
            schedulePreview();
        }
    });

    const hueSection = section(adjustPane, '色相 / 饱和度', {enabled: false});
    slider(hueSection.body, '色相', {
        min: -180,
        max: 180,
        value: 0,
        format: v => `${v}°`,
        onInput: v => {
            state.pipeline.hueSaturation.hue = v;
            schedulePreview();
        }
    });
    slider(hueSection.body, '饱和度', {
        min: -100,
        max: 100,
        value: 0,
        onInput: v => {
            state.pipeline.hueSaturation.saturation = v;
            schedulePreview();
        }
    });
    slider(hueSection.body, '明度', {
        min: -100,
        max: 100,
        value: 0,
        onInput: v => {
            state.pipeline.hueSaturation.lightness = v;
            schedulePreview();
        }
    });
    const colorizeCheck = el('input', 'sp-check');
    colorizeCheck.type = 'checkbox';
    const colorizeRow = el('label', 'sp-row sp-row-inline');
    colorizeRow.appendChild(colorizeCheck);
    colorizeRow.appendChild(el('span', 'sp-row-label', '着色（单色化）'));
    colorizeCheck.addEventListener('change', () => {
        state.pipeline.hueSaturation.colorize = colorizeCheck.checked;
        schedulePreview();
    });
    hueSection.body.appendChild(colorizeRow);
    slider(hueSection.body, '着色色相', {
        min: 0,
        max: 360,
        value: 0,
        format: v => `${v}°`,
        onInput: v => {
            state.pipeline.hueSaturation.colorizeHue = v;
            schedulePreview();
        }
    });
    slider(hueSection.body, '着色饱和度', {
        min: 0,
        max: 100,
        value: 50,
        onInput: v => {
            state.pipeline.hueSaturation.colorizeSat = v;
            schedulePreview();
        }
    });

    const bwSection = section(adjustPane, '黑白', {enabled: false});
    const bwNames = {reds: '红色', yellows: '黄色', greens: '绿色', cyans: '青色', blues: '蓝色', magentas: '洋红'};
    for (const key of Object.keys(bwNames)) {
        slider(bwSection.body, bwNames[key], {
            min: -200,
            max: 300,
            value: state.pipeline.blackWhite[key],
            onInput: v => {
                state.pipeline.blackWhite[key] = v;
                schedulePreview();
            }
        });
    }

    const balanceSection = section(adjustPane, '色彩平衡', {enabled: false});
    const balanceGroups = {shadows: '阴影', midtones: '中间调', highlights: '高光'};
    for (const key of Object.keys(balanceGroups)) {
        const group = el('div', 'sp-subgroup');
        group.appendChild(el('div', 'sp-subgroup-title', balanceGroups[key]));
        balanceSection.body.appendChild(group);
        for (const channel of ['r', 'g', 'b']) {
            slider(group, {r: '红', g: '绿', b: '蓝'}[channel], {
                min: -100,
                max: 100,
                value: 0,
                format: v => (v > 0 ? `+${v}` : `${v}`),
                onInput: v => {
                    state.pipeline.colorBalance[key][channel] = v;
                    schedulePreview();
                }
            });
        }
    }
    const preserveCheck = el('input', 'sp-check');
    preserveCheck.type = 'checkbox';
    const preserveRow = el('label', 'sp-row sp-row-inline');
    preserveRow.appendChild(preserveCheck);
    preserveRow.appendChild(el('span', 'sp-row-label', '保持明度'));
    preserveCheck.addEventListener('change', () => {
        state.pipeline.colorBalance.preserveLuminosity = preserveCheck.checked;
        schedulePreview();
    });
    balanceSection.body.appendChild(preserveRow);

    const gradientSection = section(adjustPane, '渐变映射', {enabled: false});
    colorField(gradientSection.body, '阴影色', '#000000', value => {
        state.pipeline.gradientMap.shadows = hexToTriple(value);
        schedulePreview();
    });
    colorField(gradientSection.body, '中间调', '#808080', value => {
        state.pipeline.gradientMap.midtones = hexToTriple(value);
        schedulePreview();
    });
    colorField(gradientSection.body, '高光色', '#ffffff', value => {
        state.pipeline.gradientMap.highlights = hexToTriple(value);
        schedulePreview();
    });
    const reverseRow = el('label', 'sp-row sp-row-inline');
    const reverseCheck = el('input', 'sp-check');
    reverseCheck.type = 'checkbox';
    reverseRow.appendChild(reverseCheck);
    reverseRow.appendChild(el('span', 'sp-row-label', '反转渐变'));
    reverseCheck.addEventListener('change', () => {
        state.pipeline.gradientMap.reversed = reverseCheck.checked;
        schedulePreview();
    });
    gradientSection.body.appendChild(reverseRow);

    const grainSection = section(adjustPane, '颗粒', {enabled: false});
    slider(grainSection.body, '强度', {
        min: 0,
        max: 40,
        value: 10,
        onInput: v => {
            state.pipeline.tone.grain.amount = v;
            schedulePreview();
        }
    });
    const grainMonoRow = el('label', 'sp-row sp-row-inline');
    const grainMono = el('input', 'sp-check');
    grainMono.type = 'checkbox';
    grainMono.checked = true;
    grainMonoRow.appendChild(grainMono);
    grainMonoRow.appendChild(el('span', 'sp-row-label', '单色颗粒'));
    grainMono.addEventListener('change', () => {
        state.pipeline.tone.grain.monochromatic = grainMono.checked;
        schedulePreview();
    });
    grainSection.body.appendChild(grainMonoRow);
    buttons(grainSection.body, [{
        label: '随机种子',
        onClick: () => {
            state.pipeline.tone.grain.seed = Math.floor(Math.random() * 100000);
            schedulePreview();
        }
    }]);

    const invertSection = section(adjustPane, '反相', {enabled: false});
    invertSection.body.appendChild(el('div', 'sp-hint', '反相不改变透明度'));

    /* ---------------- 滤镜 ---------------- */

    panel.addTab('filter', '滤镜');
    const filterPane = panel.addPane('filter');

    const blurSection = section(filterPane, '高斯模糊', {enabled: false});
    slider(blurSection.body, '半径', {
        min: 0,
        max: 100,
        step: 0.5,
        value: 2,
        format: v => `${v} px`,
        onInput: v => {
            state.pipeline.tone.gaussianBlur.radius = v;
            schedulePreview();
        }
    });

    const motionSection = section(filterPane, '动感模糊', {enabled: false});
    slider(motionSection.body, '角度', {
        min: -90,
        max: 90,
        value: 0,
        format: v => `${v}°`,
        onInput: v => {
            state.pipeline.tone.motionBlur.angle = v;
            schedulePreview();
        }
    });
    slider(motionSection.body, '距离', {
        min: 1,
        max: 200,
        value: 10,
        format: v => `${v} px`,
        onInput: v => {
            state.pipeline.tone.motionBlur.distance = v;
            schedulePreview();
        }
    });

    const bloomSection = section(filterPane, '辉光 / 泛光', {enabled: false});
    slider(bloomSection.body, '阈值', {
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.7,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.tone.bloom.threshold = v;
            schedulePreview();
        }
    });
    slider(bloomSection.body, '半径', {
        min: 1,
        max: 100,
        value: 10,
        format: v => `${v} px`,
        onInput: v => {
            state.pipeline.tone.bloom.radius = v;
            schedulePreview();
        }
    });
    slider(bloomSection.body, '强度', {
        min: 0,
        max: 2,
        step: 0.05,
        value: 0.5,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.tone.bloom.intensity = v;
            schedulePreview();
        }
    });

    const sharpenSection = section(filterPane, '锐化', {enabled: false});
    slider(sharpenSection.body, '数量', {
        min: 0,
        max: 3,
        step: 0.05,
        value: 0.5,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.tone.sharpen.amount = v;
            schedulePreview();
        }
    });
    slider(sharpenSection.body, '半径', {
        min: 0.5,
        max: 10,
        step: 0.5,
        value: 1,
        format: v => `${v} px`,
        onInput: v => {
            state.pipeline.tone.sharpen.radius = v;
            schedulePreview();
        }
    });

    const toneSection = section(filterPane, '色调对比', {enabled: false});
    slider(toneSection.body, '暗部', {
        min: -100,
        max: 100,
        value: 0,
        onInput: v => {
            state.pipeline.tone.toneCurve.shadows = v;
            schedulePreview();
        }
    });
    slider(toneSection.body, '亮部', {
        min: -100,
        max: 100,
        value: 0,
        onInput: v => {
            state.pipeline.tone.toneCurve.highlights = v;
            schedulePreview();
        }
    });

    const noiseSection = section(filterPane, '添加噪点', {enabled: false});
    slider(noiseSection.body, '数量', {
        min: 0,
        max: 100,
        value: 10,
        onInput: v => {
            state.pipeline.tone.addNoise.amount = v;
            schedulePreview();
        }
    });
    const noiseRows = [
        {label: '正态分布', key: 'gaussian'},
        {label: '单色', key: 'monochromatic'}
    ];
    for (const item of noiseRows) {
        const row = el('label', 'sp-row sp-row-inline');
        const check = el('input', 'sp-check');
        check.type = 'checkbox';
        row.appendChild(check);
        row.appendChild(el('span', 'sp-row-label', item.label));
        check.addEventListener('change', () => {
            state.pipeline.tone.addNoise[item.key] = check.checked;
            schedulePreview();
        });
        noiseSection.body.appendChild(row);
    }

    const vignetteSection = section(filterPane, '暗角', {enabled: false});
    slider(vignetteSection.body, '强度', {
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.4,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.tone.vignette.amount = v;
            schedulePreview();
        }
    });
    slider(vignetteSection.body, '中点', {
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.5,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.tone.vignette.midpoint = v;
            schedulePreview();
        }
    });
    slider(vignetteSection.body, '羽化', {
        min: 0.01,
        max: 1,
        step: 0.01,
        value: 0.5,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.tone.vignette.feather = v;
            schedulePreview();
        }
    });

    const lensSection = section(filterPane, '镜头校正', {enabled: false});
    slider(lensSection.body, '桶形畸变', {
        min: -1,
        max: 1,
        step: 0.01,
        value: 0,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.tone.lensCorrection.distortion = v;
            schedulePreview();
        }
    });
    slider(lensSection.body, '色散', {
        min: 0,
        max: 10,
        step: 0.5,
        value: 0,
        format: v => `${v} px`,
        onInput: v => {
            state.pipeline.tone.lensCorrection.chromatic = v;
            schedulePreview();
        }
    });
    slider(lensSection.body, '暗角', {
        min: 0,
        max: 1,
        step: 0.01,
        value: 0,
        format: v => v.toFixed(2),
        onInput: v => {
            state.pipeline.tone.lensCorrection.vignette = v;
            schedulePreview();
        }
    });

    const pixelateSection = section(filterPane, '像素化', {enabled: false});
    slider(pixelateSection.body, '像素大小', {
        min: 2,
        max: 64,
        value: 4,
        format: v => `${v} px`,
        onInput: v => {
            state.pipeline.tone.pixelate.size = v;
            schedulePreview();
        }
    });

    /* ---------------- 效果 ---------------- */

    panel.addTab('effect', '效果');
    const effectPane = panel.addPane('effect');

    const strokeSection = section(effectPane, '描边', {enabled: false});
    colorField(strokeSection.body, '颜色', '#000000', value => {
        state.effects.stroke.color = value;
        schedulePreview();
    });
    slider(strokeSection.body, '大小', {
        min: 1,
        max: 50,
        value: 2,
        format: v => `${v} px`,
        onInput: v => {
            state.effects.stroke.size = v;
            schedulePreview();
        }
    });
    slider(strokeSection.body, '不透明度', {
        min: 0,
        max: 100,
        value: 100,
        format: v => `${v}%`,
        onInput: v => {
            state.effects.stroke.opacity = v;
            schedulePreview();
        }
    });
    const insideRow = el('label', 'sp-row sp-row-inline');
    const insideCheck = el('input', 'sp-check');
    insideCheck.type = 'checkbox';
    insideRow.appendChild(insideCheck);
    insideRow.appendChild(el('span', 'sp-row-label', '内侧描边'));
    insideCheck.addEventListener('change', () => {
        state.effects.stroke.inside = insideCheck.checked;
        schedulePreview();
    });
    strokeSection.body.appendChild(insideRow);

    const shadowSection = section(effectPane, '投影', {enabled: false});
    slider(shadowSection.body, '角度', {
        min: -180,
        max: 180,
        value: 120,
        format: v => `${v}°`,
        onInput: v => {
            state.effects.dropShadow.angle = v;
            schedulePreview();
        }
    });
    slider(shadowSection.body, '距离', {
        min: 0,
        max: 100,
        value: 5,
        format: v => `${v} px`,
        onInput: v => {
            state.effects.dropShadow.distance = v;
            schedulePreview();
        }
    });
    slider(shadowSection.body, '大小', {
        min: 0,
        max: 100,
        value: 5,
        format: v => `${v} px`,
        onInput: v => {
            state.effects.dropShadow.blur = v;
            schedulePreview();
        }
    });
    colorField(shadowSection.body, '颜色', '#000000', value => {
        state.effects.dropShadow.color = value;
        schedulePreview();
    });
    slider(shadowSection.body, '不透明度', {
        min: 0,
        max: 100,
        value: 60,
        format: v => `${v}%`,
        onInput: v => {
            state.effects.dropShadow.opacity = v;
            schedulePreview();
        }
    });

    const innerShadowSection = section(effectPane, '内阴影', {enabled: false});
    slider(innerShadowSection.body, '角度', {
        min: -180,
        max: 180,
        value: 120,
        format: v => `${v}°`,
        onInput: v => {
            state.effects.innerShadow.angle = v;
            schedulePreview();
        }
    });
    slider(innerShadowSection.body, '距离', {
        min: 0,
        max: 100,
        value: 5,
        format: v => `${v} px`,
        onInput: v => {
            state.effects.innerShadow.distance = v;
            schedulePreview();
        }
    });
    slider(innerShadowSection.body, '大小', {
        min: 0,
        max: 100,
        value: 5,
        format: v => `${v} px`,
        onInput: v => {
            state.effects.innerShadow.blur = v;
            schedulePreview();
        }
    });
    colorField(innerShadowSection.body, '颜色', '#000000', value => {
        state.effects.innerShadow.color = value;
        schedulePreview();
    });
    slider(innerShadowSection.body, '不透明度', {
        min: 0,
        max: 100,
        value: 60,
        format: v => `${v}%`,
        onInput: v => {
            state.effects.innerShadow.opacity = v;
            schedulePreview();
        }
    });

    const outerGlowSection = section(effectPane, '外发光', {enabled: false});
    slider(outerGlowSection.body, '大小', {
        min: 1,
        max: 100,
        value: 10,
        format: v => `${v} px`,
        onInput: v => {
            state.effects.outerGlow.size = v;
            schedulePreview();
        }
    });
    colorField(outerGlowSection.body, '颜色', '#ffffff', value => {
        state.effects.outerGlow.color = value;
        schedulePreview();
    });
    slider(outerGlowSection.body, '不透明度', {
        min: 0,
        max: 100,
        value: 75,
        format: v => `${v}%`,
        onInput: v => {
            state.effects.outerGlow.opacity = v;
            schedulePreview();
        }
    });

    const innerGlowSection = section(effectPane, '内发光', {enabled: false});
    slider(innerGlowSection.body, '大小', {
        min: 1,
        max: 100,
        value: 10,
        format: v => `${v} px`,
        onInput: v => {
            state.effects.innerGlow.size = v;
            schedulePreview();
        }
    });
    colorField(innerGlowSection.body, '颜色', '#000000', value => {
        state.effects.innerGlow.color = value;
        schedulePreview();
    });
    slider(innerGlowSection.body, '不透明度', {
        min: 0,
        max: 100,
        value: 50,
        format: v => `${v}%`,
        onInput: v => {
            state.effects.innerGlow.opacity = v;
            schedulePreview();
        }
    });

    const overlaySection = section(effectPane, '颜色叠加', {enabled: false});
    colorField(overlaySection.body, '颜色', '#4b6bfb', value => {
        state.effects.colorOverlay.color = value;
        schedulePreview();
    });
    slider(overlaySection.body, '不透明度', {
        min: 0,
        max: 100,
        value: 30,
        format: v => `${v}%`,
        onInput: v => {
            state.effects.colorOverlay.opacity = v;
            schedulePreview();
        }
    });

    /* ---------------- 变换 ---------------- */

    panel.addTab('transform', '变换');
    const transformPane = panel.addPane('transform');

    const rotateSection = section(transformPane, '旋转 / 缩放 / 翻转', {enabled: true});
    slider(rotateSection.body, '旋转', {
        min: -180,
        max: 180,
        value: 0,
        format: v => `${v}°`,
        onInput: v => {
            state.transform.rotate = v;
            schedulePreview();
        }
    });
    slider(rotateSection.body, '缩放', {
        min: 5,
        max: 400,
        value: 100,
        format: v => `${v}%`,
        onInput: v => {
            state.transform.scale = v;
            schedulePreview();
        }
    });
    const flipRow = el('div', 'sp-row sp-row-inline');
    const flipHCheck = el('input', 'sp-check');
    flipHCheck.type = 'checkbox';
    const flipVCheck = el('input', 'sp-check');
    flipVCheck.type = 'checkbox';
    flipRow.appendChild(flipHCheck);
    flipRow.appendChild(el('span', 'sp-row-label', '水平翻转'));
    flipRow.appendChild(flipVCheck);
    flipRow.appendChild(el('span', 'sp-row-label', '垂直翻转'));
    flipHCheck.addEventListener('change', schedulePreview);
    flipVCheck.addEventListener('change', schedulePreview);
    rotateSection.body.appendChild(flipRow);
    select(rotateSection.body, '重采样', [
        {value: 'smooth', label: '平滑'},
        {value: 'pixelated', label: '像素化（保留硬边）'}
    ], 'smooth', value => {
        state.transform.resample = value;
        schedulePreview();
    });
    buttons(rotateSection.body, [{
        label: '顺时针 90°',
        onClick: () => {
            state.transform.rotate = (state.transform.rotate + 90) % 360;
            schedulePreview();
        }
    }, {
        label: '逆时针 90°',
        onClick: () => {
            state.transform.rotate = (state.transform.rotate + 270) % 360;
            schedulePreview();
        }
    }, {
        label: '恢复',
        onClick: () => {
            state.transform.rotate = 0;
            state.transform.scale = 100;
            state.transform.flipH = flipHCheck.checked = false;
            state.transform.flipV = flipVCheck.checked = false;
            schedulePreview();
        }
    }]);

    const cropSection = section(transformPane, '裁剪 / 尺寸', {enabled: true});
    slider(cropSection.body, '裁剪宽', {
        min: 1,
        max: 2048,
        value: 0,
        format: v => (v === 0 ? '原始' : `${v} px`),
        onInput: v => {
            state.cropWidth = v;
            schedulePreview();
        }
    });
    slider(cropSection.body, '裁剪高', {
        min: 1,
        max: 2048,
        value: 0,
        format: v => (v === 0 ? '原始' : `${v} px`),
        onInput: v => {
            state.cropHeight = v;
            schedulePreview();
        }
    });
    const centerRow = el('div', 'sp-row sp-row-inline');
    const centerXCheck = el('input', 'sp-check');
    centerXCheck.type = 'checkbox';
    centerXCheck.checked = true;
    const centerYCheck = el('input', 'sp-check');
    centerYCheck.checked = true;
    centerRow.appendChild(centerXCheck);
    centerRow.appendChild(el('span', 'sp-row-label', '水平居中'));
    centerRow.appendChild(centerYCheck);
    centerRow.appendChild(el('span', 'sp-row-label', '垂直居中'));
    centerXCheck.addEventListener('change', schedulePreview);
    centerYCheck.addEventListener('change', schedulePreview);
    cropSection.body.appendChild(centerRow);
    buttons(cropSection.body, [{
        label: '裁掉透明边',
        onClick: () => {
            const preview = adapter.readCanvas();
            if (!preview) return;
            const trimmed = trimTransparent(preview, 2);
            adapter.preview(trimmed);
            baseCanvas = trimmed;
            panel.setStatus(`已裁掉透明边: ${trimmed.width} × ${trimmed.height}`);
            renderPreview();
        }
    }, {
        label: '扩展画布一倍',
        onClick: () => {
            const preview = adapter.readCanvas();
            if (!preview) return;
            const expanded = resizeCanvas(preview, preview.width * 2, preview.height * 2, [0.5, 0.5]);
            adapter.preview(expanded);
            baseCanvas = expanded;
            panel.setStatus(`画布已扩展: ${expanded.width} × ${expanded.height}`);
            renderPreview();
        }
    }, {
        label: '裁剪到中心',
        onClick: () => {
            const preview = adapter.readCanvas();
            if (!preview) return;
            const w = state.cropWidth || preview.width;
            const h = state.cropHeight || preview.height;
            const x = Math.round((preview.width - w) / 2);
            const y = Math.round((preview.height - h) / 2);
            const cropped = cropCanvas(preview, {x, y, width: w, height: h});
            adapter.preview(cropped);
            baseCanvas = cropped;
            panel.setStatus(`已裁剪: ${cropped.width} × ${cropped.height}`);
        }
    }]);

    /* ---------------- 图层 ---------------- */

    panel.addTab('layer', '图层');
    const layerPane = panel.addPane('layer');
    const layerList = el('div', 'sp-layer-list');
    layerPane.appendChild(layerList);
    buttons(layerPane, [
        {label: '新建空图层', onClick: () => mutateStack(stack => addLayerFromCanvas(stack, null, '新图层'))},
        {
            label: '从当前结果新建',
            onClick: () => mutateStack(stack => addLayerFromCanvas(stack, adapter.readCanvas(), '合并结果'))
        },
        {label: '复制图层', onClick: () => mutateStack(stack => duplicateLayer(stack))},
        {label: '删除图层', onClick: () => mutateStack(stack => deleteLayer(stack))}
    ]);
    buttons(layerPane, [
        {label: '上移', onClick: () => mutateStack(stack => moveLayer(stack, 1))},
        {label: '下移', onClick: () => mutateStack(stack => moveLayer(stack, -1))},
        {label: '向下合并', onClick: () => mutateStack(stack => mergeDown(stack))}
    ]);
    const layerControls = el('div', 'sp-layer-controls');
    layerPane.appendChild(layerControls);

    const layerOpacity = slider(layerControls, '不透明度', {
        min: 0,
        max: 100,
        value: 100,
        format: v => `${v}%`,
        onInput: v => {
            const layer = state.stack && getSelectedLayer(state.stack);
            if (layer) layer.opacity = v / 100;
            renderPreview();
        }
    });
    const layerBlend = select(layerControls, '混合模式', BLEND_MODES, 'source-over', value => {
        const layer = state.stack && getSelectedLayer(state.stack);
        if (layer) layer.blendMode = value;
        renderPreview();
    });
    const layerVisibleRow = el('label', 'sp-row sp-row-inline');
    const layerVisible = el('input', 'sp-check');
    layerVisible.type = 'checkbox';
    layerVisible.checked = true;
    layerVisibleRow.appendChild(layerVisible);
    layerVisibleRow.appendChild(el('span', 'sp-row-label', '可见'));
    layerVisible.addEventListener('change', () => {
        const layer = state.stack && getSelectedLayer(state.stack);
        if (layer) layer.visible = layerVisible.checked;
        renderPreview();
    });
    layerControls.appendChild(layerVisibleRow);

    const renderLayerList = () => {
        layerList.textContent = '';
        if (!state.stack) {
            layerList.appendChild(el('div', 'sp-hint', '点击「从当前结果新建」开始使用图层'));
            return;
        }
        // 顶层在上显示
        for (let i = state.stack.layers.length - 1; i >= 0; i--) {
            const layer = state.stack.layers[i];
            const item = el('div', 'sp-layer-item');
            if (layer.id === state.stack.selectedId) item.classList.add('is-selected');
            const thumb = el('canvas', 'sp-layer-thumb');
            thumb.width = 48;
            thumb.height = 48;
            const thumbCtx = thumb.getContext('2d');
            thumbCtx.drawImage(layer.canvas, 0, 0, 48, 48);
            item.appendChild(thumb);
            item.appendChild(el('span', 'sp-layer-name', layer.name));
            const eye = el('input', 'sp-check');
            eye.type = 'checkbox';
            eye.checked = layer.visible;
            eye.addEventListener('click', event => event.stopPropagation());
            eye.addEventListener('change', () => {
                layer.visible = eye.checked;
                renderPreview();
            });
            item.appendChild(eye);
            item.addEventListener('click', () => {
                selectLayer(state.stack, layer.id);
                layerOpacity.set(Math.round(layer.opacity * 100));
                layerBlend.value = layer.blendMode;
                layerVisible.checked = layer.visible;
                renderLayerList();
                renderPreview();
            });
            layerList.appendChild(item);
        }
    };

    const ensureStack = () => {
        if (!state.stack) {
            const base = adapter.readCanvas();
            if (!base) return null;
            state.stack = createStack(base);
        }
        return state.stack;
    };

    const mutateStack = mutator => {
        const stack = ensureStack();
        if (!stack) return;
        mutator(stack);
        const layer = getSelectedLayer(stack);
        if (layer) {
            layerOpacity.set(Math.round(layer.opacity * 100));
            layerBlend.value = layer.blendMode;
            layerVisible.checked = layer.visible;
        }
        baseCanvas = flattenPreview(stack);
        renderLayerList();
        renderPreview();
    };

    const flattenPreview = stack => compositeStack(stack);

    /* ---------------- 直方图 ---------------- */

    panel.addTab('info', '直方图');
    const infoPane = panel.addPane('info');
    const histogram = new Histogram(infoPane);
    buttons(infoPane, [
        {
            label: '导出 PNG',
            onClick: () => {
                const canvas = adapter.readCanvas();
                if (!canvas) return;
                const link = document.createElement('a');
                link.href = canvas.toDataURL('image/png');
                link.download = `costume-${Date.now()}.png`;
                link.click();
            }
        },
        {
            label: '复制到剪贴板',
            onClick: () => {
                const canvas = adapter.readCanvas();
                if (!canvas || !navigator.clipboard) return;
                canvas.toBlob(blob => navigator.clipboard.write([new ClipboardItem({'image/png': blob})]));
            }
        }
    ]);
    infoPane.appendChild(el('div', 'sp-hint', '提示：应用后可用 Ctrl+Z 撤销，或再次点击「应用」叠加更多效果。'));

    /* ---------------- 动作 ---------------- */

    const handleAction = action => {
        if (action === 'apply') {
            const canvas = adapter.readCanvas();
            if (!canvas) {
                panel.setStatus('没有可提交的像素', true);
                return;
            }
            if (adapter.commit()) {
                baseCanvas = adapter.readCanvas();
                if (state.stack) state.stack = null;
                renderLayerList();
                panel.setStatus('已应用，Ctrl+Z 可撤销');
                histogram.update(canvasToImageData(canvas));
            } else {
                panel.setStatus('提交失败：找不到造像编辑器的更新入口', true);
            }
        } else if (action === 'reset') {
            state.pipeline = deepClone(IMAGE_DEFAULTS);
            state.effects = deepClone(EFFECT_DEFAULTS);
            state.transform = {rotate: 0, scale: 100, flipH: false, flipV: false};
            state.stack = null;
            baseCanvas = adapter.readCanvas();
            adapter.revert();
            panel.setStatus('已重置所有设置');
            const base = adapter.readCanvas();
            if (base) histogram.update(canvasToImageData(base));
            renderLayerList();
        } else if (action === 'revert') {
            adapter.revert();
            baseCanvas = adapter.readCanvas();
            panel.setStatus('已取消预览');
        } else if (action === 'close') {
            adapter.revert();
            root.style.display = 'none';
        }
    };

    /* ---------------- 分组开关与初始页 ---------------- */

    const boundSections = [
        [levelsSection, state.pipeline.levels],
        [curvesSection, state.pipeline.curves],
        [exposureSection, state.pipeline.exposure],
        [hueSection, state.pipeline.hueSaturation],
        [bwSection, state.pipeline.blackWhite],
        [balanceSection, state.pipeline.colorBalance],
        [gradientSection, state.pipeline.gradientMap],
        [grainSection, state.pipeline.tone.grain],
        [invertSection, state.pipeline.invert],
        [blurSection, state.pipeline.tone.gaussianBlur],
        [motionSection, state.pipeline.tone.motionBlur],
        [bloomSection, state.pipeline.tone.bloom],
        [sharpenSection, state.pipeline.tone.sharpen],
        [toneSection, state.pipeline.tone.toneCurve],
        [noiseSection, state.pipeline.tone.addNoise],
        [vignetteSection, state.pipeline.tone.vignette],
        [lensSection, state.pipeline.tone.lensCorrection],
        [pixelateSection, state.pipeline.tone.pixelate],
        [strokeSection, state.effects.stroke],
        [shadowSection, state.effects.dropShadow],
        [innerShadowSection, state.effects.innerShadow],
        [outerGlowSection, state.effects.outerGlow],
        [innerGlowSection, state.effects.innerGlow],
        [overlaySection, state.effects.colorOverlay]
    ];
    for (const [sectionObject, target] of boundSections) {
        sectionObject.enable.checked = Boolean(target.enabled);
        sectionObject.enable.addEventListener('change', () => {
            target.enabled = sectionObject.enable.checked;
            schedulePreview();
        });
    }

    // 翻转复选框与状态同步
    flipHCheck.addEventListener('change', () => {
        state.transform.flipH = flipHCheck.checked;
    });
    flipVCheck.addEventListener('change', () => {
        state.transform.flipV = flipVCheck.checked;
    });

    panel.selectTab('adjust');
    root.style.display = 'none';

    return {
        root,
        panel,
        state,
        show () {
            // 上一次的预览若还挂在画布上，先还原再重新取基线
            if (adapter.isPreviewActive()) adapter.revert();
            root.style.display = '';
            baseCanvas = adapter.readCanvas();
            if (baseCanvas) histogram.update(canvasToImageData(baseCanvas));
        },
        isOpen () {
            return root.style.display !== 'none';
        },
        refreshHistogram () {
            const canvas = adapter.readCanvas();
            if (canvas) histogram.update(canvasToImageData(canvas));
        },
        // 内部工具，供 userscript 调用
        internal: {ensureStack, renderLayerList, renderPreview, handleAction}
    };
};

const hexToTriple = hex => {
    const value = hex.replace('#', '');
    const n = parseInt(value, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

export {createStudioPanel};
