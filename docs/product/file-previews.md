# 文件预览格式与边界

更新日期：2026-10-27。此清单区分“被识别”“浏览器可尝试打开”“已实现结构化预览”，不把 MIME 或文件图标当作预览承诺。

## 一、改动前的实际支持

取证位置：`src/local/files.rs`、`src/commands/file_serve.rs`、`ui/src/queries/files.ts`、`FileViewer.tsx`、`ArtifactsTab.tsx`、`MediaPreview.tsx` 和 `HtmlPreview.tsx`。

| 分类 | 已识别的扩展名 | 改动前的预览方式与范围 |
| --- | --- | --- |
| Markdown | md、markdown、mdx | GFM 正文、表格、数学公式、相对图片/链接；可切换源码。MDX 按 Markdown 展示，不执行 JSX 组件。产物、仓库、会话工作树等位置共用文件页；产物列表内也可预览。 |
| 网页 | html、htm | 文件页可使用隔离 iframe 展示，允许脚本但不允许同源权限；本地依赖按 MIME 白名单内联。产物列表内的小预览原来按文本展示。 |
| PDF | pdf | 按需加载 PDF.js；支持多页阅读，失败时下载。扫描 PDF 能看页面但没有 OCR。 |
| LaTeX | tex | 源码编辑；执行主机安装可用 TeX 引擎后可编译并预览 PDF。不是浏览器内直接排版 TeX。 |
| 常见图片 | png、jpg、jpeg、jfif、gif、webp、svg、bmp、ico、apng、avif | 原生 img；实际受浏览器/系统解码能力限制。 |
| 扩展图片 | heic、heif、jxl、tif、tiff、pbm、pgm、pnm、ppm | 原来已有 MIME 和图片分类，但浏览器通常不能全部解码；失败后下载。不能宣称普遍支持。 |
| 音频 | mp3、wav、ogg、oga、opus、m4a、aac、flac、weba、aif、aiff、mid、midi | 原生 audio + 控件；容器和编码都要受浏览器支持，MIDI 等不是可移植的浏览器播放能力。 |
| 视频 | mp4、m4v、webm、mov、mkv、avi、mpeg、mpg、ogv、3gp | 原生 video + 控件，复用 Range 接口；实际可播性取决于容器、编码、操作系统，失败后下载。 |
| 数据与笔记本 | csv、tsv、json、jsonl、ipynb、xml | 纯文本/源码，无表格网格、工作表或 Notebook 单元格视图。 |
| 代码、配置、纯文本 | txt、log、rst、bib、cfg、cmake、conf、dart、env、ex、exs、fs、fsx、gql、graphql、gradle、hs、ini、jl、lock、lua、m、mm、nix、npmrc、properties、proto、qmd、r、rmd、swift、tex；c、cc、cpp、cs、go、h、hpp、java、kt、php、pl、py、rb、rs、scala、sh、sql、toml、ts、tsx、vue、yaml、yml；css、js、jsx、mjs；部分点文件及 Dockerfile/Makefile/README/LICENSE/Gemfile/Justfile | 源码展示；语法高亮取决于已注册语言，无法高亮也能按文本阅读。可编辑的仓库文件使用版本校验保存。未知后缀也会做严格文本探测，而不是一律执行或下载。 |
| Office、开放文档 | doc、docx、xls、xlsx、ods 等 | 主要是 MIME 分类和下载，尚未有正文/工作表预览；ppt/pptx/odt/odp 也没有专门预览。 |
| 压缩包 | zip、tar、gz、tgz、bz2、rar、7z | MIME/图标分类和下载，没有包内目录视图。 |
| 其他二进制 | ps、eps、字体、wasm、可执行文件、未知二进制等 | 下载；不执行。 |

原文本上限为 512,000 字节；UTF-8 不合法或含 NUL 会被标为二进制。扩展名能进入文本分类，并不代表实际字节一定合法。

## 二、本次补充的能力

共用 `filePreview.ts` 判定、`StructuredFilePreview` 懒加载入口和 `structuredPreview.ts` 解析器；在产物内嵌预览与独立文件页一致接入。继续使用现有项目/产物/会话/版本对应的原始文件 URL，不增加绕过权限或路径隔离的接口，不把文件上传到第三方查看器。

| 分类 | 新增/增强格式 | 预览方式 | 重点场景与明确限制 |
| --- | --- | --- | --- |
| 文档 | docx、odt | 提取正文段落，按原顺序显示文本；表格内文字可阅读 | 研究报告、审计清单、交付文档。内容级预览，不还原分页、字体、复杂表格布局、图片、图表、页眉页脚或批注。加密文档明确报错。 |
| 表格 | csv、tsv | 支持引号、转义引号、嵌入换行的网格；按页浏览 | 指标、实验结果、导出数据。只读，不执行公式。默认 CSV 逗号、TSV 制表符；其他分隔符需先转换。 |
| 工作簿 | xlsx、xlsm、ods | 多表切换、行列网格、缓存单元格值；无缓存时展示公式文本 | 多实验对比、数据检查。保留 XLSX 空行/空列位置。不重新计算公式，不执行 VBA，不保留数字格式、日期格式、图表、合并单元格或隐藏状态；数值日期可能显示为序列号。 |
| 演示 | pptx、odp | 按页展示提取出的文字 | 汇报稿、成果汇总。非原版式幻灯片，图片/动画/媒体不展开；PPTX 以文件编号排序，不解析自定义播放顺序。最多 200 页。 |
| Notebook | ipynb | 分单元格阅读源码/Markdown 原文与纯文本输出 | Python 实验、分析记录。最多 500 个单元格；不执行代码，不渲染 HTML/JavaScript 输出或嵌入图片，每单元格最多 10 万字符、每格最多 10 条文本输出。 |
| 压缩包 | zip、tar、tgz、tar.gz、gz | 包内路径、原始大小、ZIP 加密标记；单独 gzip 显示展开后文件名和大小 | 检查研究包的目录和文件构成。只列目录，不落盘、不打开包内文件。ZIP 不支持 ZIP64、分卷、重复路径；非 UTF-8 ZIP 文件名可能失真。TAR 以基本 ustar 为目标，不解释 GNU/PAX 的长路径、稀疏文件语义。 |
| Unicode 文本 | 产物中的 UTF-8/带 BOM 的 UTF-16LE、UTF-16BE | 严格解码并识别实际二进制；截断字符不误判整个文件 | Windows 导出的文本、CSV 和 Markdown。没有 BOM 时不猜测 UTF-16/GBK/GB18030；仓库编辑仍以现有服务端编码和版本协议为准，不把 UTF-16 文件静默转换后写回。 |
| 类型兼容 | 常见文本、图片、音视频、PDF；补充 cjs、svelte、pyi、ps1 等文本判定 | 服务端缺少 presentation 头时，按扩展名和标准 Content-Type 推断，再读取实际字节校验 | 新旧服务端/代理兼容。明确的服务端 presentation 头优先；这是兼容性补足，未据此宣称已确认某一部署故障的根因。 |

### 资源与行为边界

- 结构化文件最多读取 16 MiB；即使服务端忽略 Range 或没有 Content-Length，也会在流式读取时实施上限。文本接口继续使用 512,000 字节预览上限。
- ZIP 目录最多 2,000 项。Office 只读取必要 XML，单个 XML 最多 4 MiB，合计最多 32 MiB；gzip 总展开量最多 32 MiB。超过限制、损坏、加密或未支持的变体均给出错误与下载入口，不显示为成功空白页。
- 工作簿最多 30 表，每表 1,000 行、100 列，每页显示 100 行；单元格最多 20,000 字符，整份表格预览的单元格文本累计最多 200 万字符。超出部分不代表不存在，需下载检查完整数据。
- DOCX/ODT 最多提取 5,000 个段落。所有提取文本由 React 转义；Office XML 禁止 DOCTYPE/ENTITY；不加载包内脚本、外部关系或宏，不执行表格公式。
- 新格式是按需加载的独立 chunk；保留下载退路。当前有限规模解析在浏览器执行，较复杂文件仍可能短暂占用主线程；大规模预览需后续迁入 Worker 或隔离的服务端转换任务。
- 这不是在线编辑器，也不是 Office 排版引擎；内容提取视图不能作为分页、数字格式或演示布局的验收依据。

## 三、继续扩展的格式与建议方案（尚未实现）

| 格式/类别 | 建议方式 | 适配重点及约束 |
| --- | --- | --- |
| doc、xls、ppt、rtf；Office 高保真预览 | 隔离的 LibreOffice headless 转 PDF，复用 PDF.js；xls 另可接成熟工作簿解析器 | 旧版文件、打印版式、图表、复杂排版。执行主机必须安装转换器和字体；设置进程超时、内存/CPU 配额、独立用户配置目录和无网络环境；按源文件哈希缓存。需部署与兼容性验收后才可标为支持。 |
| HEIC/HEIF、TIFF、多页 TIFF、JXL、PNM 家族 | 隔离的图片解码/转 PNG 或 WebP；多页建立分页索引 | 显微/扫描图像；保留原图与色彩/位深说明，限制像素总量，科研图像不能以有损缩略图替代原始数据。 |
| MOV/MKV/AVI、MPEG、3GP；非浏览器音频编码 | ffprobe 探测轨道，按需转 H.264/AAC MP4 或兼容 WebM/音频 | 科研录像和录音；限制时长、分辨率、转码资源与版权许可；保留原件，不以“扩展名已识别”冒充可播放。 |
| rar、7z、bz2、xz、zst 及高级 TAR/ZIP 变体 | 受限的归档目录读取器，必要时只执行 list 操作 | 大型研究包。隔离运行，限制条目、嵌套深度与展开字节；不得直接解压到工作目录。 |
| parquet、arrow、feather、h5/hdf5、npy/npz、mat、sqlite | 主机侧只读抽样、schema/数组维度/统计视图 | 科学数据。不能伪装成通用表格，避免全量加载；SQLite 禁止写入，pickle/joblib 不反序列化执行。 |
| GBK/GB18030/Shift-JIS 等历史文本编码 | 显式编码选择、只读解码；必要时提供单独的“另存为 UTF-8”操作 | 历史数据。自动猜测存在歧义，不能影响原件或现有保存校验。 |

## 四、MD 被误报二进制的排查路径

服务端本身已将 md/markdown/mdx 分类为文本；前端也已有 Markdown renderer。需要分别核对：

1. HEAD 是否返回 `x-openresearch-presentation: text`；代理是否保留它；若是跨域，是否向浏览器暴露该响应头。
2. 实际 GET/Range 返回的是 Markdown 字节，还是登录页、错误体或错误的文件；核对项目、会话、来源与路径。
3. 文件是否 UTF-8、含 BOM 的 UTF-16、其他编码或确实含二进制字节；不能仅依扩展名强行解码。
4. 前端和 executor 是否为同一版本、缓存是否仍使用旧资源。仅更新静态 UI 不会更新已部署 executor。

本次按用户后续指示停止核对具体服务器，未访问或修改其部署，也没有确认远端 `material_audit.md` 的实际编码、头信息或版本。通用判定的兼容改进不等同于已验证远端故障消失。

## 五、调研依据

- [MDN：Content-Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Type)：标准 MIME 是响应类型信息，仍需与实际内容及现有路由共同校验。
- [MDN：媒体容器格式](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)：容器与编码器支持必须分开，不能只按 mp4/mov 后缀承诺播放。
- [fflate 官方说明](https://github.com/101arrowz/fflate)：本地 ZIP/GZIP 解码能力，支持筛选需要解压的文件；本项目另外施加读取和展开上限。
- [Mammoth 官方安全说明](https://github.com/mwilliamson/mammoth.js#security)：文档到 HTML 的转换不能天然视为可信 HTML。本次选择纯文本/表格数据展示，避免引入任意文档 HTML。
- [LibreOffice：命令行参数](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)：可用 headless/convert-to 建立后续高保真 PDF 转换，但须满足执行环境、字体、独立 profile 和资源隔离要求。
