(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('“换行积木”扩展必须在非沙盒模式下运行。');
  }

  const extId = 'lineBreak';
  const { BlockType, ArgumentType, vm } = Scratch;
  const runtime = vm.runtime;
  const hasOwn = (o, p) => Object.prototype.hasOwnProperty.call(o, p);

  // 运行期配置由插件（userscript）写入，修改设置无需重载扩展。
  const getConfig = () => (typeof window !== 'undefined' && window.__lineBreakConfig) || {};
  const getDisplayMax = () => {
    const n = Number(getConfig().maxChars);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
  };
  const isPopupMode = () => getConfig().mode !== 'inline';

  const customFieldTypes = {};
  let Blockly = null;

  const _LDC = function _LightenDarkenColor (col, amt) {
    const num = parseInt(col.replace('#', ''), 16);
    const r = (num >> 16) + amt;
    const b = ((num >> 8) & 0x00FF) + amt;
    const g = (num & 0x0000FF) + amt;
    const newColour = g | (b << 8) | (r << 16);
    return (col.at(0) === '#' ? '#' : '') + newColour.toString(16);
  };

  function _setCssNattr (node, attr, value) {
    node.setAttribute(attr, String(value));
    node.style[attr] = value;
  }

  function _fixColours (doText, col1, textColour) {
    const LDA = -10;
    const self = this.sourceBlock_;
    const parent = self && self.parentBlock_;
    if (!parent) return;

    const path = self && self.svgPath_;
    const argumentSvg = path && path.parentNode;
    const textNode = argumentSvg && argumentSvg.querySelector('g.blocklyEditableText text');
    const oldFirstColour = parent.colour_;

    self.colour_ = col1 || _LDC(parent.colour_, LDA);
    self.colourSecondary_ = _LDC(parent.colourSecondary_, LDA);
    self.colourTertiary_ = _LDC(parent.colourTertiary_, LDA);
    self.colourQuaternary_ = _LDC((parent && parent.colourQuaternary_) || oldFirstColour, LDA);

    _setCssNattr(path, 'fill', self.colour_);
    _setCssNattr(path, 'stroke', self.colourTertiary_);
    if (doText && textNode) _setCssNattr(textNode, 'fill', textColour || '#FFFFFF');
  }

  // 这些 runtime/Blockly 补丁只安装一次，扩展重载时不会重复包装。
  const installRuntimePatches = () => {
    if (runtime.__lineBreakRuntimePatched) return;
    runtime.__lineBreakRuntimePatched = true;

    if (typeof runtime._convertBlockForScratchBlocks === 'function') {
      const _cbfsb = runtime._convertBlockForScratchBlocks.bind(runtime);
      runtime._convertBlockForScratchBlocks = function (blockInfo, categoryInfo, ...args) {
        const res = _cbfsb(blockInfo, categoryInfo, ...args);
        if (hasOwn(blockInfo, 'blockShape')) res.json.outputShape = blockInfo.blockShape;
        return res;
      };
    }

    if (typeof runtime._buildCustomFieldInfo === 'function' &&
        typeof runtime._buildCustomFieldTypeForScratchBlocks === 'function') {
      const bcfi = runtime._buildCustomFieldInfo.bind(runtime);
      const bcftfsb = runtime._buildCustomFieldTypeForScratchBlocks.bind(runtime);
      let fi = null;

      runtime._buildCustomFieldInfo = function (fieldName, fieldInfo, extensionId, categoryInfo, ...args) {
        fi = fieldInfo;
        return bcfi(fieldName, fieldInfo, extensionId, categoryInfo, ...args);
      };

      runtime._buildCustomFieldTypeForScratchBlocks = function (fieldName, output, outputShape, categoryInfo, ...args) {
        const res = bcftfsb(fieldName, output, outputShape, categoryInfo, ...args);
        if (fi) {
          if (fi.color1) res.json.colour = fi.color1;
          if (fi.color2) res.json.colourSecondary = fi.color2;
          if (fi.color3) res.json.colourTertiary = fi.color3;
          if (fi.color4) res.json.colourQuaternary = fi.color4;
          if (hasOwn(fi, 'output')) res.json.output = fi.output;
          fi = null;
        }
        return res;
      };
    }
  };

  installRuntimePatches();

  const toRegisterOnBlocklyGot = [];

  if (!runtime.__lineBreakFieldListener) {
    runtime.__lineBreakFieldListener = true;
    vm.addListener('EXTENSION_FIELD_ADDED', (fieldInfo) => {
      if (Blockly) Blockly.Field.register(fieldInfo.name, fieldInfo.implementation);
      else toRegisterOnBlocklyGot.push([fieldInfo.name, fieldInfo.implementation]);
    });
  }

  ArgumentType.TEXTAREA = 'TextareaInput';
  ArgumentType.INLINETEXTAREA = 'TextareaInputInline';

  const implementations = {
    FieldTextarea: null,
    FieldInlineTextarea: null
  };

  customFieldTypes[ArgumentType.TEXTAREA] = {
    output: ArgumentType.STRING,
    color1: '#9566d3',
    outputShape: 2,
    implementation: {
      fromJson: () => new implementations.FieldTextarea()
    }
  };

  customFieldTypes[ArgumentType.INLINETEXTAREA] = {
    output: ArgumentType.STRING,
    color1: '#9566d3',
    outputShape: 3,
    implementation: {
      fromJson: () => new implementations.FieldInlineTextarea()
    }
  };

  function tryUseScratchBlocks (_sb) {
    Blockly = _sb;

    // Blockly / DOM 补丁只安装一次。
    if (!Blockly.__lineBreakBlockPatched) {
      Blockly.__lineBreakBlockPatched = true;
      const _setAttribute = SVGTextElement.prototype.setAttribute;
      SVGTextElement.prototype.setAttribute = function (attr, val, ...args) {
        if (
          String(val) === 'NaN' &&
          (attr === 'x' || attr === 'y') &&
          this.getAttribute('class') === 'blocklyText'
        ) {
          const nattr = 'MoreFieldsAttrErr' + attr.toUpperCase();
          _setAttribute.call(
            this,
            nattr,
            '尝试在此文本节点上进行非法设置。' + attr.toUpperCase() + '被设置为NaN。'
          );
          return _setAttribute.call(this, attr, '0', ...args);
        }
        return _setAttribute.call(this, attr, val, ...args);
      };

      const _endBlockDrag = Blockly.BlockDragger.prototype.endBlockDrag;
      Blockly.BlockDragger.prototype.endBlockDrag = function (...a) {
        const res = _endBlockDrag.apply(this, a);
        for (const childBlock of this.draggingBlock_.childBlocks_) {
          const inputList = childBlock.inputList;
          if (
            inputList.length === 1 &&
            inputList[0].fieldRow.length === 1 &&
            !!(inputList[0].fieldRow[0] && inputList[0].fieldRow[0].inlineDblRender)
          ) {
            childBlock.render();
          }
        }
        return res;
      };
    }

    // =========================================================
    // 1) 弹出式 —— 注释式浮层（无确定按钮，点空白即关闭）
    //    积木上显示自动缩写为一行 + 省略号，最大字符数由插件设置控制
    // =========================================================
    implementations.FieldTextarea = class FieldTextarea extends Blockly.FieldTextInput {
      constructor (opt_value) {
        opt_value = '';
        super(opt_value);
        this.addArgType('String');
        this.addArgType(ArgumentType.TEXTAREA);

        this._overlay = null;
        this._arrow = null;
        this._textareaEl = null;
        this._rafId = 0;
        this._outsideHandler = null;
        this._outsideBound = false;
        this._keyHandler = null;
      }

      init (...initArgs) {
        Blockly.Field.prototype.init.call(this, ...initArgs);
        this.sourceBlock_.allowFieldConnection_ = true;
        this.sourceBlock_.isMoreFields_ = true;
        _fixColours.call(this, false, '#FFFFFF', '#FFFFFF');
      }

      dispose (...args) {
        this._closeOverlay();
        Blockly.Field.prototype.dispose.call(this, ...args);
      }

      // ---------- 关键：缩写积木上的显示文本 ----------
      getDisplayText_ () {
        const raw =
          (typeof this.getText === 'function' ? this.getText() : this.getValue()) || '';
        // 折叠所有换行/多余空白为单行
        const flat = String(raw)
          .replace(/\r\n|\r|\n/g, ' ↵ ')
          .replace(/\s+/g, ' ')
          .trim();

        if (flat.length === 0) {
          // 空值显示为 NBSP 以免塌陷
          return Blockly.Field && Blockly.Field.NBSP ? Blockly.Field.NBSP : '\u00A0';
        }
        const max = getDisplayMax();
        if (flat.length <= max) return flat;
        return flat.slice(0, max) + '…';
      }

      // 值变化时让积木重新排版（宽度随显示文本自适应）
      setValue (newValue) {
        const prev = this.getValue();
        const res = super.setValue(newValue);
        // 值的内容变化才需要重新渲染（避免每帧都重排）
        if (prev !== this.getValue()) {
          if (this.sourceBlock_ && this.sourceBlock_.rendered) {
            // 让 Blockly 重新计算字段尺寸
            if (typeof this.updateSize_ === 'function') this.updateSize_();
            this.sourceBlock_.render();
            if (typeof this.sourceBlock_.bumpNeighbours === 'function') {
              this.sourceBlock_.bumpNeighbours();
            }
          }
        }
        return res;
      }

      showEditor_ () {
        if (this._overlay && this._overlay.isConnected) {
          this._focusTextarea();
          return;
        }
        this._buildOverlay();
        this._updatePosition();
        this._startLoop();
        this._bindOutsideClose();
        this._bindKey();
        this._focusTextarea();
      }

      _buildOverlay () {
        const overlay = document.createElement('div');
        overlay.setAttribute('data-mf-overlay', '1');
        overlay.style.cssText = [
          'position:fixed',
          'z-index:2147483646',
          'background:#ffffff',
          'border-radius:10px',
          'box-shadow:0 12px 34px rgba(0,0,0,.28), 0 2px 6px rgba(0,0,0,.12)',
          'padding:8px',
          'box-sizing:border-box',
          'max-width:min(92vw, 460px)',
          'pointer-events:auto',
          'touch-action:manipulation',
          'font-family:inherit'
        ].join(';');

        const arrow = document.createElement('div');
        arrow.style.cssText = [
          'position:absolute',
          'width:0',
          'height:0',
          'pointer-events:none',
          'border-left:10px solid transparent',
          'border-right:10px solid transparent',
          'border-bottom:10px solid #ffffff'
        ].join(';');
        overlay.appendChild(arrow);

        const textarea = document.createElement('textarea');
        textarea.value = this.getValue() || '';
        textarea.style.cssText = [
          'display:block',
          'width:min(78vw, 420px)',
          'min-height:130px',
          'max-height:50vh',
          'font-family:monospace',
          'font-size:14px',
          'line-height:1.45',
          'border:1px solid #cfc4e8',
          'border-radius:8px',
          'padding:8px 10px',
          'box-sizing:border-box',
          'resize:vertical',
          'outline:none',
          'background:#ffffff',
          'color:#111111',
          'touch-action:manipulation',
          '-webkit-user-select:text',
          'user-select:text',
          '-webkit-touch-callout:default'
        ].join(';');
        overlay.appendChild(textarea);

        const stop = (e) => e.stopPropagation();
        ['pointerdown', 'mousedown', 'click', 'dblclick'].forEach((ev) => {
          overlay.addEventListener(ev, stop, true);
        });
        overlay.addEventListener('touchstart', stop, { capture: true, passive: true });
        overlay.addEventListener('touchmove', stop, { capture: true, passive: true });

        document.body.appendChild(overlay);

        this._overlay = overlay;
        this._arrow = arrow;
        this._textareaEl = textarea;

        // 输入 → 同步到积木（同时积木上的缩写文本会实时刷新）
        textarea.addEventListener('input', () => this.setValue(textarea.value));
      }

      _getFieldRect () {
        const el =
          this.fieldGroup_ ||
          (this.sourceBlock_ && this.sourceBlock_.svgGroup_) ||
          (this.sourceBlock_ && this.sourceBlock_.svgPath_ && this.sourceBlock_.svgPath_.parentNode);
        if (!el || !el.getBoundingClientRect) return null;
        return el.getBoundingClientRect();
      }

      _updatePosition () {
        const ov = this._overlay;
        if (!ov || !ov.isConnected) return;

        const rect = this._getFieldRect();
        if (!rect) return;

        const vv = window.visualViewport;
        const vpW = vv ? vv.width : window.innerWidth;
        const vpH = vv ? vv.height : window.innerHeight;
        const vpLeft = vv ? vv.offsetLeft : 0;
        const vpTop = vv ? vv.offsetTop : 0;
        const vpBottom = vpTop + vpH;

        ov.style.maxWidth = Math.min(vpW - 16, 460) + 'px';
        ov.style.maxHeight = Math.max(160, vpH - 24) + 'px';
        if (this._textareaEl) {
          this._textareaEl.style.maxHeight = Math.max(80, vpH - 60) + 'px';
        }

        const ow = ov.offsetWidth;
        const oh = ov.offsetHeight;

        const fx = rect.left + rect.width / 2;
        const fyTop = rect.top;
        const fyBottom = rect.bottom;

        let left = fx - ow / 2;
        const minLeft = vpLeft + 8;
        const maxLeft = vpLeft + vpW - ow - 8;
        if (maxLeft < minLeft) {
          left = vpLeft + Math.max(0, (vpW - ow) / 2);
        } else {
          left = Math.max(minLeft, Math.min(maxLeft, left));
        }

        const gap = 14;
        let top = fyBottom + gap;
        let arrowSide = 'top';

        if (top + oh > vpBottom - 8) {
          const above = fyTop - oh - gap;
          if (above >= vpTop + 8) {
            top = above;
            arrowSide = 'bottom';
          } else {
            top = vpTop + 8;
            if (fyBottom <= top + 4) arrowSide = 'top';
            else if (fyTop >= top + oh - 4) arrowSide = 'bottom';
            else arrowSide = 'none';
          }
        }

        if (
          rect.bottom < vpTop || rect.top > vpBottom ||
          rect.right < vpLeft || rect.left > vpLeft + vpW
        ) {
          arrowSide = 'none';
        }

        ov.style.left = left + 'px';
        ov.style.top = top + 'px';

        const arrow = this._arrow;
        if (arrow) {
          if (arrowSide === 'none') {
            arrow.style.display = 'none';
          } else {
            arrow.style.display = '';
            const ax = Math.max(16, Math.min(ow - 16, fx - left));
            arrow.style.left = (ax - 10) + 'px';
            if (arrowSide === 'top') {
              arrow.style.top = '-10px';
              arrow.style.bottom = '';
              arrow.style.borderTop = '';
              arrow.style.borderBottom = '10px solid #ffffff';
            } else {
              arrow.style.top = '';
              arrow.style.bottom = '-10px';
              arrow.style.borderTop = '10px solid #ffffff';
              arrow.style.borderBottom = '';
            }
          }
        }
      }

      _startLoop () {
        if (this._rafId) return;
        const tick = () => {
          if (!this._overlay || !this._overlay.isConnected) {
            this._rafId = 0;
            return;
          }
          this._updatePosition();
          this._rafId = requestAnimationFrame(tick);
        };
        this._rafId = requestAnimationFrame(tick);
      }

      _bindOutsideClose () {
        if (this._outsideBound) return;
        this._outsideBound = true;

        const handler = (e) => {
          if (!this._overlay) return;
          if (this._overlay.contains(e.target)) return;
          if (this._textareaEl) this.setValue(this._textareaEl.value);
          this._closeOverlay();
        };

        this._outsideHandler = handler;
        this._outsideTimer = setTimeout(() => {
          this._outsideTimer = null;
          if (!this._overlay) return;
          document.addEventListener('pointerdown', handler, true);
          document.addEventListener('touchstart', handler, true);
        }, 250);
      }

      _bindKey () {
        if (this._keyHandler) return;
        this._keyHandler = (e) => {
          if (e.key === 'Escape') {
            if (this._textareaEl) this.setValue(this._textareaEl.value);
            this._closeOverlay();
          }
        };
        document.addEventListener('keydown', this._keyHandler, true);
      }

      _focusTextarea () {
        const ta = this._textareaEl;
        if (!ta) return;
        const focusNow = () => {
          if (!document.contains(ta)) return;
          try {
            ta.focus({ preventScroll: true });
          } catch (e) {
            try { ta.focus(); } catch (_) { /* ignore */ }
          }
          try {
            ta.setSelectionRange(ta.value.length, ta.value.length);
          } catch (_) { /* ignore */ }
        };
        focusNow();
        setTimeout(focusNow, 60);
      }

      _closeOverlay () {
        if (this._rafId) {
          cancelAnimationFrame(this._rafId);
          this._rafId = 0;
        }
        if (this._outsideTimer) {
          clearTimeout(this._outsideTimer);
          this._outsideTimer = null;
        }
        if (this._outsideHandler) {
          document.removeEventListener('pointerdown', this._outsideHandler, true);
          document.removeEventListener('touchstart', this._outsideHandler, true);
          this._outsideHandler = null;
        }
        this._outsideBound = false;
        if (this._keyHandler) {
          document.removeEventListener('keydown', this._keyHandler, true);
          this._keyHandler = null;
        }
        if (this._overlay) {
          this._overlay.remove();
          this._overlay = null;
        }
        this._arrow = null;
        this._textareaEl = null;
      }
    };

    // =========================================================
    // 2) 内联式 —— 在积木上直接可编辑（含移动端触摸修复）
    // =========================================================
    implementations.FieldInlineTextarea = class FieldInlineTextarea extends Blockly.Field {
      constructor (opt_value) {
        opt_value = '';
        super(opt_value);
        this.addArgType('String');
        this.addArgType(ArgumentType.INLINETEXTAREA);
      }

      updateWidth () {
        if (this._textarea) {
          const width = this._textarea.offsetWidth + 1;
          const height = this._textarea.offsetHeight + 1;

          this._textareaHolder.setAttribute('width', String(width + 3));
          this._textareaHolder.setAttribute('height', String(height + 3));

          this.size_.width =
            width - Blockly.BlockSvg.NOTCH_START_PADDING +
            2 * Blockly.BlockSvg.NOTCH_START_PADDING / 3;

          this.size_.height =
            height + Blockly.BlockSvg.NOTCH_HEIGHT + 1.5 +
            Blockly.BlockSvg.NOTCH_START_PADDING / 3;
        } else {
          this.size_.width = this._FakeWidth || 40;
          this.size_.height = this._FakeHeight || 24;
        }
      }

      dispose () {
        super.dispose();
      }

      init (...initArgs) {
        this.inlineDblRender = true;
        Blockly.Field.prototype.init.call(this, ...initArgs);

        this.textNode__ =
          this.sourceBlock_.svgPath_.parentNode.querySelector('g.blocklyEditableText text');

        if (!!this.textNode__ && this.sourceBlock_.parentBlock_) {
          this.textNode__.style.display = 'none';
          _fixColours.call(this, false, this.sourceBlock_.parentBlock_.colour_);
        }

        this._FakeWidth = this._FakeWidth || 40;
        this._FakeHeight = this._FakeHeight || 24;

        const textareaHolder = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'foreignObject'
        );
        textareaHolder.setAttribute('x', '6');
        textareaHolder.setAttribute(
          'y',
          String(Blockly.BlockSvg.NOTCH_START_PADDING / 2 - 0.375)
        );
        textareaHolder.setAttribute('width', '160');
        textareaHolder.setAttribute('height', '48');
        textareaHolder.style.pointerEvents = 'auto';
        textareaHolder.style.touchAction = 'manipulation';

        const textarea = document.createElement('textarea');
        textarea.value = this.getValue() || '';
        textarea.style.cssText = [
          'width:160px',
          'min-height:44px',
          'box-sizing:border-box',
          'font-family:monospace',
          'font-size:12px',
          'line-height:1.35',
          'border:1px solid #cfc4e8',
          'border-radius:6px',
          'padding:4px 6px',
          'outline:none',
          'background:#ffffff',
          'color:#111111',
          'resize:both',
          'pointer-events:auto',
          'touch-action:manipulation',
          '-webkit-user-select:text',
          'user-select:text',
          '-webkit-touch-callout:default'
        ].join(';');

        const stop = (e) => e.stopPropagation();
        ['pointerdown', 'mousedown', 'click', 'dblclick'].forEach((ev) => {
          textareaHolder.addEventListener(ev, stop, true);
          textarea.addEventListener(ev, stop, true);
        });
        textareaHolder.addEventListener('touchstart', stop, { capture: true, passive: true });
        textarea.addEventListener('touchstart', stop, { capture: true, passive: true });
        textareaHolder.addEventListener('touchmove', stop, { capture: true, passive: true });
        textarea.addEventListener('touchmove', stop, { capture: true, passive: true });

        const focusNow = () => {
          if (!document.contains(textarea)) return;
          if (document.activeElement === textarea) return;
          try {
            textarea.focus({ preventScroll: true });
          } catch (e) {
            try { textarea.focus(); } catch (_) { /* ignore */ }
          }
        };
        textarea.addEventListener('touchstart', () => { focusNow(); }, { passive: true });
        textarea.addEventListener('touchend', () => { setTimeout(focusNow, 0); }, { passive: true });
        textarea.addEventListener('click', () => { setTimeout(focusNow, 0); });

        textarea.addEventListener('input', () => this._onInput());
        textarea.addEventListener('mouseup', () => this._resizeHolder());

        if (this.fieldGroup_) {
          this.fieldGroup_.insertAdjacentElement('afterend', textareaHolder);
          textareaHolder.appendChild(textarea);

          this._textareaHolder = textareaHolder;
          this._textarea = textarea;

          if (this.sourceBlock_ && this.sourceBlock_.isInFlyout) {
            textarea.disabled = true;
            textarea.style.resize = 'none';
          }

          new ResizeObserver(() => this._resizeHolder()).observe(this._textarea);
        }

        this._resizeHolder();
      }

      _resizeHolder () {
        this.updateWidth();

        const ov = this.getValue();
        this.setValue(ov + '~');
        this.setValue(ov);
        this.render_();
      }

      _onInput () {
        this.setValue(this._textarea.value);
      }

      showEditor_ () { /* 内联式直接在积木上编辑，不需要弹窗 */ }
    };

    while (toRegisterOnBlocklyGot.length > 0) {
      const item = toRegisterOnBlocklyGot.shift();
      Blockly.Field.register(item[0], item[1]);
    }

    // 供插件 userscript 在“最大显示字符数”变更后刷新已有积木的缩写显示
    window.__lineBreakAPI = {
      refreshDisplay () {
        if (!Blockly) return;
        const refreshWorkspace = (workspace) => {
          if (!workspace || typeof workspace.getAllBlocks !== 'function') return;
          for (const block of workspace.getAllBlocks()) {
            if (!block || (typeof block.isDead === 'function' && block.isDead())) continue;
            let touched = false;
            for (const input of block.inputList || []) {
              for (const field of input.fieldRow || []) {
                if (field instanceof implementations.FieldTextarea) {
                  try { field.render_(); } catch (e) { /* ignore */ }
                  touched = true;
                }
              }
            }
            if (touched) {
              try { block.render(); } catch (e) { /* ignore */ }
            }
          }
        };
        refreshWorkspace(Blockly.getMainWorkspace());
        const mainWorkspace = Blockly.getMainWorkspace();
        const flyout = mainWorkspace && mainWorkspace.getFlyout && mainWorkspace.getFlyout();
        refreshWorkspace(flyout && flyout.getWorkspace && flyout.getWorkspace());
      }
    };

    const eventsOriginallyEnabled = Blockly.Events.isEnabled();
    const workspace = Blockly.getMainWorkspace();

    Blockly.Events.disable();

    if (workspace) {
      if (vm.editingTarget) vm.emitWorkspaceUpdate();

      const flyout = workspace.getFlyout();
      if (flyout) {
        const flyoutWorkspace = flyout.getWorkspace();
        Blockly.Xml.clearWorkspaceAndLoadFromXml(
          Blockly.Xml.workspaceToDom(flyoutWorkspace),
          flyoutWorkspace
        );
        const toolbox = workspace.getToolbox();
        if (toolbox && toolbox.refreshSelection) toolbox.refreshSelection();
        workspace.toolboxRefreshEnabled_ = true;
      }
    }

    if (eventsOriginallyEnabled) Blockly.Events.enable();
  }

  if (Scratch && Scratch.gui && typeof Scratch.gui.getBlockly === 'function') {
    Scratch.gui.getBlockly().then((blockly) => tryUseScratchBlocks(blockly));
  }

  class LineBreakExtension {
    static get customFieldTypes () {
      return customFieldTypes;
    }

    getInfo () {
      const popup = isPopupMode();
      return {
        id: extId,
        name: '换行积木',
        color1: '#9566d3',
        color2: '#9566d3',
        color3: '#9566d3',
        color4: '#9566d3',
        blocks: [
          {
            opcode: 'textarea',
            blockType: BlockType.REPORTER,
            text: '文本区域 [TEXT]',
            arguments: {
              TEXT: {
                type: popup ? ArgumentType.TEXTAREA : ArgumentType.INLINETEXTAREA,
                defaultValue: ''
              }
            },
            allowDropAnywhere: true,
            blockShape: popup ? 2 : 3
          }
        ],
        customFieldTypes
      };
    }

    textarea (args) {
      return args.TEXT;
    }
  }

  Scratch.extensions.register(runtime['ext_' + extId] = new LineBreakExtension());
})(Scratch);
