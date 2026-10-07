// 造像工作室：给造像编辑器加一套 Photoshop 风格的调整 / 滤镜 / 效果 / 变换 / 图层工具。
// 全部能力通过 addon 公开接口 + paper.js 实现，不修改 scratch-paint 源码。

import {PaintAdapter} from './lib/paper-adapter.js';
import {createStudioPanel} from './lib/ui.js';

const BUTTON_CLASS = 'sa-studiopaint-button';
const WRAPPER_CLASS = 'sa-studiopaint-wrapper';

const ICON_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">',
    '<path fill="currentColor" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14z"/>',
    '<circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
    '<path fill="currentColor" d="M11 1h2v4h-2zm0 18h2v4h-2zM1 11h4v2H1zm18 0h4v2h-4z"/>',
    '</svg>'
].join('');

let addonRef = null;
let adapter = null;
let studioPanel = null;

const isPaintTabActive = () => {
    const state = addonRef.tab.redux.state;
    return Boolean(state && state.scratchGui &&
        state.scratchGui.editorTab.activeTabIndex === 1 &&
        !state.scratchGui.mode.isPlayerOnly);
};

// studioPanel 是整个会话共用的单例：第一次打开时创建，之后复用
// eslint-disable-next-line require-atomic-updates
const openPanel = async () => {
    if (!studioPanel) {
        const paper = await addonRef.tab.traps.getPaper();
        const container = await addonRef.tab.waitForElement("[class^='paint-editor_canvas-container']");
        adapter = new PaintAdapter(addonRef, paper, container);
        const created = createStudioPanel(adapter);
        document.body.appendChild(created.root);
        studioPanel = created;
    }
    const format = addonRef.tab.redux.state.scratchPaint && addonRef.tab.redux.state.scratchPaint.format;
    studioPanel.show();
    if (format === 'VECTOR') {
        studioPanel.panel.setStatus('当前为矢量模式：建议先点右上角「转位图」，否则调整会破坏矢量数据', true);
    } else {
        studioPanel.refreshHistogram();
    }
};

const togglePanel = async () => {
    if (studioPanel && studioPanel.isOpen()) {
        studioPanel.panel.internal.handleAction('close');
        return;
    }
    await openPanel();
};

const addButton = async () => {
    const canvasControls = await addonRef.tab.waitForElement("[class^='paint-editor_canvas-controls']", {
        markAsSeen: true,
        reduxCondition: () => isPaintTabActive()
    });
    if (!canvasControls || canvasControls.querySelector(`.${BUTTON_CLASS}`)) return;

    // 借原生样式：缩放按钮组里的第一个按钮的长相
    const zoomControls = canvasControls.querySelector("[class^='paint-editor_zoom-controls']");
    const sample = zoomControls && zoomControls.firstChild;
    const wrapper = document.createElement('div');
    wrapper.className = WRAPPER_CLASS;
    if (sample) wrapper.className += ` ${sample.className}`;

    const button = document.createElement('div');
    button.className = BUTTON_CLASS;
    if (sample && sample.firstChild && sample.firstChild.className) {
        button.className += ` ${sample.firstChild.className}`;
    }
    button.title = '造像工作室：调整、滤镜、图层效果与变换';
    button.setAttribute('role', 'button');
    button.innerHTML = ICON_SVG;
    button.addEventListener('click', () => {
        togglePanel().catch(error => console.error(error));
    });
    wrapper.appendChild(button);
    canvasControls.appendChild(wrapper);
};

const removeButton = () => {
    for (const node of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
        const wrapper = node.closest(`.${WRAPPER_CLASS}`);
        (wrapper || node).remove();
    }
};

export default async ({addon, console}) => {
    addonRef = addon;
    if (!addon.tab.redux) {
        console.warn('Redux 不可用，造像工作室未启动');
        return;
    }

    await addButton();

    addon.tab.redux.addEventListener('statechanged', ({detail}) => {
        const action = detail.action;
        if (!action) return;
        if (action.type === 'scratch-gui/navigation/ACTIVATE_TAB') {
            if (action.activeTabIndex === 1) {
                addButton().catch(error => console.error(error));
            } else {
                removeButton();
                if (studioPanel) studioPanel.panel.internal.handleAction('revert');
            }
        }
        if (action.type === 'scratch-gui/mode/SET_PLAYER' && action.isPlayerOnly) {
            removeButton();
            if (studioPanel) studioPanel.panel.internal.handleAction('revert');
        }
    });

    window.addEventListener('beforeunload', () => {
        if (studioPanel) studioPanel.panel.internal.handleAction('revert');
    });
};
