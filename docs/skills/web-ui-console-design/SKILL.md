---
name: web-ui-console-design
description: 构建「控制台型」Web 界面（单页应用 + 侧边栏 + 实时状态）的设计系统与实现规范——提炼自 curloop（无人值守 Cursor Harness）产品级 Web UI 的实战经验。
whenToUse: 当你需要设计/实现一个面向"运维控制台、自动化工具、监控面板、开发者工具"类的 Web UI，希望复用一套经过验证的设计语言（浅色、圆点状态、卡片统计、面板化、响应式交互）时。
metadata:
  origin: "curloop (CursorHarness) — 无人值守 Cursor 编码 Harness 的 Web 界面"
  stack: "vanilla HTML/CSS/JS + Tabler + ECharts（全部本地打包离线可用）"
  version: 1
---

# Web UI 控制台设计系统（Console UI Design System）

从 **curloop**（无人值守 Cursor Harness）的产品级 Web 界面沉淀的设计思路与实现规范。
这是一套面向「控制台型工具」的完整设计语言：浅色 + 圆点状态 + 卡片统计 + 面板化 + 响应式单页。

## 一、设计基调（Design Tokens）

### 配色（浅色，Apple HIG × shadcn 混合）
- **背景栈**：页面 `#fafafa`，侧边栏 `#f4f4f5`，卡片 `#ffffff`
- **文字栈**：主文字 `#18181b`（近黑），次级 `#71717a`，弱化 `#a1a1aa`
- **边框栈**：常规 `#e8e8ea`，强调 `#d4d4d8`
- **主色**：`#18181b`（近黑按钮）+ `#007aff`（Apple 蓝，聚焦/激活）
- **语义色**：绿 `#22c55e` / 红 `#ef4444` / 黄 `#f59e0b` / 青 `#06b6d4` / 紫 `#8b5cf6`
- **圆角**：`7px / 10px / 14px`（sm/md/lg 三级）
- **阴影**：sm `0 1px 2px rgb(0 0 0/.04)`（常态），md `0 10px 28px -8px`（hover 浮起）
- **字体**：`-apple-system, SF Pro Text, Segoe UI, PingFang SC, Microsoft YaHei`（系统栈，避免网络字体）
- **等宽**：`ui-monospace, SFMono-Regular, Consolas`（路径/日志/代码）

**原则**：全部走 CSS 变量（`--bg/--fg/--primary/...`），换肤只需改 `:root`。

### 字号阶梯（统一，禁止内联 font-size）
- 10.5px 统计标签（uppercase）、11px 徽章/表单标签/hint、12px 次级说明
- 13px 正文/按钮/输入、13.5px 导航项、16px 品牌、19px 页面标题、24px 统计数字
- 数字用 `font-variant-numeric: tabular-nums`（等宽数字，避免跳动）

## 二、布局架构（App Shell）

```
┌──────────┬──────────────────────────┐
│  sidebar  │  topbar（sticky，毛玻璃） │
│  228px    ├──────────────────────────┤
│  品牌     │  content（max-width）     │
│  导航项    │   view 1 / view 2 / ...   │
│  分隔线    │                          │
│  底部信息  │                          │
└──────────┴──────────────────────────┘
```

### 侧边栏（Sidebar）
- 固定 228px，`position:sticky; height:100vh`，独立滚动
- **品牌区**：logo + 渐变文字（`background-clip:text`）
- **导航项**：图标(16px, stroke 1.9) + 文字，hover 淡灰，active 白卡 + 阴影 + 蓝色图标
- **分隔线**（`nav-sep`）：功能组与设置组之间
- **底部**：项目路径（等宽小字，`text-overflow:ellipsis`）

### 顶栏（Topbar）
- sticky + `backdrop-filter:blur(14px)` 毛玻璃（内容滚动时保持可见）
- 左侧当前视图标题，右侧操作区（状态 chip + 刷新按钮）

### 视图切换（SPA 核心）
```html
<section class="view" id="view-overview"><!-- ... --></section>
```
- 所有视图平铺在 content 里，CSS 控制显隐（`.view{display:none} .view.active{display:block}`）
- `switchView(name)`：切 active 类 + 更新标题 + 按需懒加载该视图数据
- **一屏一焦点**：每次只显示一个视图，避免信息过载

## 三、核心组件库（可复用组件）

### 1. 状态圆点（Status Dot）—— 状态表达首选
> 相比文字徽章，圆点 + 颜色 + hover 提示更克制、更符合整体风格。
```css
.dot{width:8px;height:8px;border-radius:50%;background:var(--border-strong);
     transition:background-color .2s}
.dot.on{animation:pulse2 1.6s infinite}      /* 呼吸 = 活跃/需注意 */
@keyframes pulse2{50%{opacity:.4}}
```
- **颜色即状态**：绿=正常/完成，黄=部分/警告，红=错误/需操作，灰=待定
- 圆点旁不放文字（信息放 `title` tooltip 或下方 hint）
- 「需注意」状态加呼吸动画吸引眼球（如"需要初始化"红点闪烁）

### 2. 状态徽章（Badge）—— 标签/计数
```css
.badge{font-size:11px;border-radius:999px;padding:2px 10px;
       display:inline-block;border:1px solid transparent}
```
- 柔和色系：`bg #f0fdf4 / text #15803d / border #bbf7d0`（绿），红/黄/蓝同理
- 面板标题右侧放计数徽章（如"0 行"、"3 项"）
- **徽章在 flex 行中必须垂直居中**：`align-self:center; line-height:1.4`（否则被 stretch 拉高文字偏上）

### 3. 统计卡片（Stat Card）—— 总览数据
```css
.stat-card{display:flex;gap:14px;align-items:center;padding:16px;border:1px solid var(--border);
           border-radius:14px;box-shadow:sm;transition:box-shadow .18s,transform .18s}
.stat-card:hover{box-shadow:md;transform:translateY(-1px)}
```
- 布局：彩色图标方块(38px, 圆角10px, tint 背景) + 竖排「大写标签 + 大数字 + 小副文」
- 网格：`grid-template-columns:repeat(auto-fit,minmax(180px,1fr))`（自动响应式）

### 4. 面板（Panel）—— 内容容器
- 卡片化：白底 + 边框 + 圆角 + 微阴影
- **面板头**：左标题（svg 图标 + 文字），右操作区（徽章/按钮）
- **面板体**：`padding:18px`
- 可折叠面板用 `<details class="panel">` + 旋转 chevron

### 5. 表单元素
- **输入框**：圆角 7px，聚焦蓝边 + `box-shadow:0 0 0 3px rgba(0,122,255,.14)`（focus ring）
- **数字步进器**：隐藏原生 spinner + 自定义 −/+ 按钮组（等宽数字）
- **下拉选择**：`appearance:none` + 内联 SVG 箭头（替换原生丑陋箭头）
- **开关（Toggle）**：Apple HIG 风格——40×24 轨道 + 20px 白滑块 + 弹性动画
  ```css
  .switch .track{width:40px;height:24px;border-radius:999px;background:#d4d4d8}
  .switch .track::after{content:'';width:20px;height:20px;border-radius:50%;background:#fff;
    box-shadow:0 2px 5px rgb(0 0 0/.22);transition:transform .18s cubic-bezier(.4,.9,.5,1.3)}
  .switch input:checked + .track{background:var(--green)}
  .switch input:checked + .track::after{transform:translateX(16px)}
  ```
- **表单标签**：11px 次级色（比正文小的"字段说明"感），**hint 文案统一 11px** 弱化色

### 6. 按钮
- shadcn 风格：34px 高，圆角 7px，`inline-flex` + gap + svg 图标
- 变体：`btn-primary`（近黑）/ `btn-outline`（白底描边）/ `btn-danger`（红）/ `btn-ghost`（透明）
- 禁用态 `opacity:.45;pointer-events:none`；focus-visible 焦点环

### 7. 终端/日志（Terminal）
- 深色卡片（`#0b0c0e`）与整体浅色形成对比焦点
- 顶栏：led 状态灯（绿=运行呼吸）+ 状态文字；主体：等宽字体日志流

## 四、交互设计原则

### 1. 状态可视化优先
- 所有"状态"（运行中/完成/失败/待操作）用**颜色 + 圆点**表达，不用长文字
- hover/点击才展开细节（tooltip、折叠面板）

### 2. 智能流程守卫（人机交互）
- **响应式状态徽章**：根据项目状态自动切换（绿=已完成自动收起 / 红=需操作自动展开）
- **唯一操作入口**：能自动完成的步骤合并进主按钮（如"开始运行"自动包含初始化+扩写+执行），减少用户决策
- **自动判断**：保存路径后自动检测项目是否初始化，无才提示生成

### 3. 记住用户选择
- `localStorage` 记住最后使用的路径/选项，刷新/重开自动回填
- 服务端持久化默认值（写入配置文件），重启也生效

### 4. 实时反馈
- 页面 `setInterval` 每 2s 轮询状态 + 每 5s 刷新图表
- 操作按钮点击后 `disabled` + 控制台输出提示，完成后恢复
- 运行日志流式回传（子进程 stdout → 终端样式容器）

### 5. 一致性检查清单
- ❌ 禁止内联 `style="font-size"`——全部走 CSS 类/变量
- ❌ 禁止重复 id（`$()` 只取第一个，重复即 bug）
- ✅ 徽章/flex 行内元素必须垂直居中
- ✅ 同层级字号统一（开关文字 = 同行复选框文字 = 12px）
- ✅ 所有图标用同一套 SVG 线性图标（stroke 2，圆头圆角）

## 五、数据可视化

- **ECharts**：轨迹时间线（任务条 + 换号标记散点，支持滚轮缩放/拖拽 dataZoom）
- **活动柱状图**：近 24h 事件分桶
- 图表配色与全局语义色一致（完成=绿，换号=蓝/紫，失败=红）
- 空状态：图内居中提示文案（"加载中…"）

## 六、落地清单（在新项目复用时）

1. **复制 tokens**：`:root` CSS 变量块（配色/圆角/阴影/字体）直接复用
2. **搭 shell**：sidebar + topbar + view 切换骨架
3. **按需引入组件**：状态圆点 / 徽章 / 统计卡 / 面板 / 开关 / 步进器 / 终端
4. **API 约定**：后端返回 `{ok, error}` + 数据；前端统一 `api(url, opts)` 封装（失败显示连接状态）
5. **状态驱动 UI**：每个实体（项目/任务/配置）先定义状态枚举 → 映射颜色/动画
6. **离线优先**：第三方库（Tabler/ECharts/marked）下载到本地 vendor，不用 CDN

## 参考实现

- 完整参考：curloop Web 界面（`src/web/index.html`，单文件 1500 行 SPA）
- 设计来源：Apple HIG × shadcn/ui × Refactoring UI（配色/间距/层级）
