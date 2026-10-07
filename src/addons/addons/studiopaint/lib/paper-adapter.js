// scratch-paint 适配层：读取当前 costume 像素、实时预览、写回并进入撤销栈。
// 只用 addon 公开的能力（paper scope + React fiber），不改 scratch-paint 源码。

const RASTER_LAYER_KEY = 'isRasterLayer';

const CHANGE_SELECTED_ITEMS = 'scratch-paint/select/CHANGE_SELECTED_ITEMS';
const CHANGE_FORMAT = 'scratch-paint/formats/CHANGE_FORMAT';
const BITMAP = 'BITMAP';

const BITMAP_FORMATS = ['BITMAP', 'BITMAP_SKIP_CONVERT'];

/**
 * 从 paper scope 找到位图 raster（scratch-paint 的 getRaster() 等价实现）。
 */
const getRaster = paper => {
    const layer = paper.project.layers.find(l => l.data && l.data[RASTER_LAYER_KEY]);
    return layer && layer.children.length > 0 ? layer.children[0] : null;
};

/**
 * 从 DOM 元素向上遍历 React fiber，找到持有 onUpdateImage 的 PaintEditor 实例。
 * scratch-paint 的 PaperCanvas 组件上有 importImage / recalibrateSize 可作为特征。
 */
const findPaintEditorInstance = element => {
    const internalKey = Object.keys(element).find(key => key.startsWith('__reactInternalInstance$'));
    if (!internalKey) return null;
    const queue = [element[internalKey]];
    while (queue.length) {
        const fiber = queue.shift();
        if (!fiber) continue;
        const node = fiber.stateNode;
        if (node && typeof node.importImage === 'function' && typeof node.recalibrateSize === 'function') {
            return node;
        }
        if (node && node.props && typeof node.props.onUpdateImage === 'function') {
            return node;
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
};

/**
 * 适配器：封装与 scratch-paint 的所有交互。
 */
class PaintAdapter {
    /**
     * @param {object} addon addon.tab
     * @param {object} paper paper.js scope
     */
    constructor (addon, paper, containerElement) {
        this.addon = addon;
        this.paper = paper;
        this.containerElement = containerElement;
        this.editorInstance = findPaintEditorInstance(containerElement);
        this.previewCanvas = null;
        this.originalCanvas = null;
    }

    get store () {
        return this.addon.redux;
    }

    /** 当前是否位图模式 */
    isBitmap () {
        const state = this.store.state;
        if (!state || !state.scratchPaint) return false;
        return BITMAP_FORMATS.includes(state.scratchPaint.format);
    }

    formatName () {
        const state = this.store.state;
        if (!state || !state.scratchPaint) return '未知';
        return state.scratchPaint.format;
    }

    /** 请求切换到位图模式（矢量模式下的调整是破坏性的，先转换更安全） */
    convertToBitmap () {
        this.store.dispatch({type: CHANGE_FORMAT, format: BITMAP});
    }

    /** 清空选区，避免 onUpdateImage 把选区内容贴进结果 */
    clearSelection () {
        try {
            this.paper.project.deselectAll();
        } catch (e) {
            // paper 尚未就绪时忽略
        }
        this.store.dispatch({type: CHANGE_SELECTED_ITEMS, selectedItems: []});
    }

    /** 读取当前 costume 的像素画布（位图模式） */
    readCanvas () {
        const raster = getRaster(this.paper);
        if (!raster || !raster.canvas) return null;
        return raster.canvas;
    }

    /** 把处理后的画布装回编辑器但不提交（用于实时预览） */
    preview (canvas) {
        const raster = getRaster(this.paper);
        if (!raster) return false;
        // 第一次预览前记住原像素，"取消预览"靠它恢复
        if (!this.originalCanvas) this.originalCanvas = raster.canvas;
        this.previewCanvas = canvas;
        raster.canvas = canvas;
        this.paper.view.update();
        return true;
    }

    /** 判断预览画布是否仍在编辑器里（若用户中途画了一笔则不在了） */
    isPreviewActive () {
        if (!this.previewCanvas) return false;
        const raster = getRaster(this.paper);
        return Boolean(raster && raster.canvas === this.previewCanvas);
    }

    /** 放弃预览，恢复原像素；若用户中途已改动画布则不覆盖其成果 */
    revert () {
        this.previewCanvas = null;
        if (!this.originalCanvas) return;
        const raster = getRaster(this.paper);
        if (raster && raster.canvas !== this.originalCanvas) {
            // 预览画布仍在，说明还没被其他操作顶掉，可以还原
            raster.canvas = this.originalCanvas;
            this.paper.view.update();
        }
        this.originalCanvas = null;
    }

    /** 记住应用前的原像素（应用前调用一次） */
    rememberOriginal () {
        this.originalCanvas = this.readCanvas();
    }

    /**
     * 提交：写回画布并触发 scratch-paint 的 onUpdateImage，
     * 由它完成 vm.updateBitmap（显示 + 工程 dirty）与撤销快照。
     */
    commit () {
        const raster = getRaster(this.paper);
        if (!raster) return false;
        if (this.editorInstance && this.editorInstance.props &&
            typeof this.editorInstance.props.onUpdateImage === 'function') {
            this.clearSelection();
            this.editorInstance.props.onUpdateImage(false);
            this.previewCanvas = null;
            this.originalCanvas = null;
            return true;
        }
        return false;
    }

    /** 把画布导出为 PNG dataURL（用于下载或作为新图层） */
    toDataURL (canvas) {
        return canvas.toDataURL('image/png');
    }
}

export {PaintAdapter, getRaster, findPaintEditorInstance, BITMAP_FORMATS};
