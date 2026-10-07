/* 本地 addon：造像工作室（Stud.io Paint Studio） */
const manifest = {
    editorOnly: true,
    noTranslations: true,
    name: '造像工作室',
    description: '给造像编辑器加上专业图像处理：色阶、曲线、曝光、色相饱和度、黑白、色彩平衡、渐变映射、' +
        '高斯/动感模糊、辉光、锐化、暗角、镜头校正，以及描边、投影、内外发光等图层效果，' +
        '还有图层堆栈、变换裁剪与直方图。功能参考开源图像编辑器 Compositor。',
    credits: [
        {
            name: '13244431027'
        }
    ],
    userscripts: [
        {
            url: 'userscript.js'
        }
    ],
    userstyles: [
        {
            url: 'style.css'
        }
    ],
    tags: [
        'editor',
        'paintEditor'
    ],
    dynamicDisable: true,
    enabledByDefault: false
};
export default manifest;
