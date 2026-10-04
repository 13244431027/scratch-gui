export default async function ({ addon, console }) {
  const Blockly = await addon.tab.traps.getBlockly();
  if (!Blockly || !Blockly.FieldTextInput) {
    console.warn("换行输入框: 未能获取 ScratchBlocks，插件未生效");
    return;
  }

  const originals = {};
  let patched = false;

  // 这些字段类型保持单行输入
  const isSingleLineField = (field) =>
    field instanceof Blockly.FieldNumber ||
    field instanceof Blockly.FieldTextDropdown ||
    field instanceof Blockly.FieldNote;

  const rerenderBlocks = () => {
    const ws = Blockly.getMainWorkspace();
    if (!ws || typeof ws.getAllBlocks !== "function") return;
    for (const block of ws.getAllBlocks()) {
      if (!block || (typeof block.isDead === "function" && block.isDead())) continue;
      if (block.rendered && typeof block.render === "function") {
        block.render();
      }
    }
  };

  const patch = () => {
    if (patched) return;
    patched = true;

    // ---------- 编辑浮层：单行 input 替换为多行 textarea ----------
    originals.showEditor_ = Blockly.FieldTextInput.prototype.showEditor_;
    Blockly.FieldTextInput.prototype.showEditor_ = function (
      opt_quietInput, opt_readOnly, opt_withArrow, opt_arrowCallback
    ) {
      if (isSingleLineField(this)) {
        return originals.showEditor_.apply(this, arguments);
      }

      this.workspace_ = this.sourceBlock_.workspace;
      const quietInput = opt_quietInput || false;
      const readOnly = opt_readOnly || false;

      Blockly.WidgetDiv.show(
        this,
        this.sourceBlock_.RTL,
        this.widgetDispose_(),
        this.widgetDisposeAnimationFinished_(),
        Blockly.FieldTextInput.ANIMATION_TIME
      );
      const div = Blockly.WidgetDiv.DIV;
      div.className += " fieldTextInput lineBreakMultilineInput";

      const textarea = document.createElement("textarea");
      textarea.className = "blocklyHtmlInput";
      textarea.setAttribute("spellcheck", String(this.spellcheck_));
      if (readOnly) {
        textarea.setAttribute("readonly", "true");
      }
      Object.assign(textarea.style, {
        lineHeight: "22px",
        textAlign: "left",
        padding: "2px 4px",
        resize: "none",
        overflowY: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        colorScheme: "light"
      });
      /** @type {HTMLTextAreaElement} */
      Blockly.FieldTextInput.htmlInput_ = textarea;
      div.appendChild(textarea);

      if (opt_withArrow) {
        if (this.sourceBlock_.RTL) {
          textarea.style.paddingLeft =
            (this.arrowSize_ + Blockly.BlockSvg.DROPDOWN_ARROW_PADDING) + "px";
        } else {
          textarea.style.paddingRight =
            (this.arrowSize_ + Blockly.BlockSvg.DROPDOWN_ARROW_PADDING) + "px";
        }
        const dropDownArrow = document.createElement("img");
        dropDownArrow.className = "blocklyTextDropDownArrow";
        dropDownArrow.setAttribute(
          "src",
          Blockly.mainWorkspace.options.pathToMedia + "dropdown-arrow-dark.svg"
        );
        dropDownArrow.style.width = this.arrowSize_ + "px";
        dropDownArrow.style.height = this.arrowSize_ + "px";
        dropDownArrow.style.top = this.arrowY_ + "px";
        dropDownArrow.style.cursor = "pointer";
        const dropdownArrowMagic = "11px";
        if (this.sourceBlock_.RTL) {
          dropDownArrow.style.left = dropdownArrowMagic;
        } else {
          dropDownArrow.style.right = dropdownArrowMagic;
        }
        if (opt_arrowCallback) {
          textarea.dropDownArrowMouseWrapper_ = Blockly.bindEvent_(
            dropDownArrow, "mousedown", this, opt_arrowCallback
          );
        }
        div.appendChild(dropDownArrow);
      }

      textarea.value = textarea.defaultValue = this.text_;
      textarea.oldValue_ = null;
      this.validate_();
      this.resizeEditor_();
      if (!quietInput) {
        textarea.focus();
        textarea.select();
        try {
          textarea.setSelectionRange(0, 99999);
        } catch (e) {
          // 忽略非 input 元素限制
        }
      }
      this.bindEvents_(textarea, quietInput || readOnly);

      const transitionProperties =
        "box-shadow " + Blockly.FieldTextInput.ANIMATION_TIME + "s";
      if (Blockly.BlockSvg.FIELD_TEXTINPUT_ANIMATE_POSITIONING) {
        div.style.transition +=
          ",padding " + Blockly.FieldTextInput.ANIMATION_TIME +
          "s,width " + Blockly.FieldTextInput.ANIMATION_TIME +
          "s,height " + Blockly.FieldTextInput.ANIMATION_TIME +
          "s,margin-left " + Blockly.FieldTextInput.ANIMATION_TIME + "s";
      }
      div.style.transition = transitionProperties;
      textarea.style.transition =
        "font-size " + Blockly.FieldTextInput.ANIMATION_TIME + "s";
      textarea.style.fontSize =
        Blockly.BlockSvg.FIELD_TEXTINPUT_FONTSIZE_FINAL + "pt";
      div.style.boxShadow = "0px 0px 0px 4px " + Blockly.Colours.fieldShadow;
    };

    // ---------- 按键：普通 Enter 换行，Ctrl/Cmd+Enter 确认 ----------
    originals.onHtmlInputKeyDown_ = Blockly.FieldTextInput.prototype.onHtmlInputKeyDown_;
    Blockly.FieldTextInput.prototype.onHtmlInputKeyDown_ = function (e) {
      const htmlInput = Blockly.FieldTextInput.htmlInput_;
      if (!htmlInput || htmlInput.tagName !== "TEXTAREA") {
        return originals.onHtmlInputKeyDown_.call(this, e);
      }
      const enterKey = 13, escKey = 27, tabKey = 9;
      if (e.isComposing || e.keyCode === 229) {
        return; // 输入法组合中，交给浏览器处理
      }
      if (e.keyCode === enterKey) {
        if (e.ctrlKey || e.metaKey) {
          Blockly.WidgetDiv.hide();
          Blockly.DropDownDiv.hideWithoutAnimation();
        }
        // 普通 Enter 不拦截 → 在 textarea 中插入换行
      } else if (e.keyCode === escKey) {
        htmlInput.value = htmlInput.defaultValue;
        Blockly.WidgetDiv.hide();
        Blockly.DropDownDiv.hideWithoutAnimation();
      } else if (e.keyCode === tabKey) {
        Blockly.WidgetDiv.hide();
        Blockly.DropDownDiv.hideWithoutAnimation();
        this.sourceBlock_.tab(this, !e.shiftKey);
        e.preventDefault();
      }
    };

    // ---------- 尺寸：高度随行数自适应，宽度取最长行 ----------
    originals.resizeEditor_ = Blockly.FieldTextInput.prototype.resizeEditor_;
    Blockly.FieldTextInput.prototype.resizeEditor_ = function () {
      const htmlInput = Blockly.FieldTextInput.htmlInput_;
      if (!htmlInput || htmlInput.tagName !== "TEXTAREA") {
        return originals.resizeEditor_.call(this);
      }
      const scale = this.sourceBlock_.workspace.scale;
      const div = Blockly.WidgetDiv.DIV;
      if (!div) return;

      const initialWidth = this.sourceBlock_.isShadow()
        ? this.sourceBlock_.getHeightWidth().width * scale
        : this.size_.width * scale;

      const rawText = String(htmlInput.value ?? "");
      const lines = rawText.split(/\r\n|\r|\n/);

      let width;
      if (Blockly.BlockSvg.FIELD_TEXTINPUT_EXPAND_PAST_TRUNCATION) {
        let maxTextWidth = 0;
        for (const line of lines) {
          const w = Blockly.scratchBlocksUtils.measureText(
            htmlInput.style.fontSize,
            htmlInput.style.fontFamily,
            htmlInput.style.fontWeight,
            line
          );
          maxTextWidth = Math.max(maxTextWidth, w);
        }
        width = (maxTextWidth + Blockly.FieldTextInput.TEXT_MEASURE_PADDING_MAGIC) * scale;
      } else {
        width = initialWidth;
      }
      width = Math.max(width, Blockly.BlockSvg.FIELD_WIDTH_MIN_EDIT * scale);
      width = Math.min(width, Blockly.BlockSvg.FIELD_WIDTH_MAX_EDIT * scale);

      const LINE_HEIGHT = 22;
      const lineCount = Math.max(1, lines.length);
      const heightPx = Math.min(240, lineCount * LINE_HEIGHT + 2);

      div.style.width = (width / scale + 1) + "px";
      div.style.height = heightPx + "px";
      div.style.transform = "scale(" + scale + ")";
      div.style.marginLeft = -0.5 * (width - initialWidth) + "px";

      const borderRadius = this.getBorderRadius() + 0.5;
      div.style.borderRadius = borderRadius + "px";
      htmlInput.style.borderRadius = borderRadius + "px";
      div.style.borderColor = this.sourceBlock_.getColourTertiary();

      const xy = this.getAbsoluteXY_();
      xy.x -= scale / 2;
      xy.y -= scale / 2;
      if (this.sourceBlock_.RTL) {
        xy.x += width;
        xy.x -= div.offsetWidth * scale;
        xy.x += 1 * scale;
      }
      xy.y += 1 * scale;
      const googUA = Blockly.goog && Blockly.goog.userAgent;
      if (googUA && googUA.GECKO && div.style.top) {
        xy.x += 2 * scale;
        xy.y += 1 * scale;
      }
      if (googUA && googUA.WEBKIT) {
        xy.y -= 1 * scale;
      }
      div.style.left = xy.x + "px";
      div.style.top = xy.y + "px";
    };

    // ---------- 显示：含换行的文本折叠为一行（↵ + 省略号） ----------
    originals.getDisplayText_ = Blockly.FieldTextInput.prototype.getDisplayText_;
    Blockly.FieldTextInput.prototype.getDisplayText_ = function () {
      const text = String(this.text_ ?? "");
      if (!/[\r\n]/.test(text)) {
        return originals.getDisplayText_.call(this);
      }
      const flat = text
        .replace(/\r\n|\r|\n/g, " ↵ ")
        .replace(/\s+/g, " ")
        .trim();
      if (flat.length === 0) {
        return Blockly.Field.NBSP || "\u00A0";
      }
      const limit = Math.max(
        1,
        parseInt(addon.settings.get("maxChars"), 10) || 20
      );
      const shown = flat.length <= limit ? flat : flat.slice(0, limit) + "\u2026";
      return shown.replace(/ /g, Blockly.Field.NBSP || "\u00A0");
    };

    rerenderBlocks();
  };

  const restore = () => {
    if (!patched) return;
    patched = false;
    for (const key of Object.keys(originals)) {
      if (typeof Blockly.FieldTextInput.prototype[key] !== "undefined") {
        Blockly.FieldTextInput.prototype[key] = originals[key];
      }
    }
    rerenderBlocks();
  };

  patch();

  addon.self.addEventListener("disabled", () => restore());
  addon.self.addEventListener("reenabled", () => patch());
  addon.settings.addEventListener("change", () => rerenderBlocks());
}
