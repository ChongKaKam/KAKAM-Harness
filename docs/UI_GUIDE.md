# UI 组件与视觉规范

本页是 Drift Space 的 UI 开发契约。交互应安静、清晰，保持 Notion 式内容组织和 ChatGPT 式聊天体验；这里的“参考”不表示引入对应产品的代码或假定具有它们的全部功能。新增组件以当前源码为基础，规范调整在同次变更中同步本页与相关测试。

## 信息架构与视觉分工

- Shell 包含品牌、主导航、对话列表、用户入口与内容区域，使用**纯黑白灰**。不要恢复灰褐色框架或让绿色 / Color Pattern 接管整页文字。
- 工作区放对话、提示词等产品能力；统计独立分组；左下角用户入口进入设置。通用设置、账户设置、相关信息及管理员页面均属于设置容器。
- feature 页面只负责自己的内容，不再创建第二套全局侧栏、用户菜单或主题 Provider。功能管理区分 Core / Plugin；普通用户不能看到管理员操作。
- Color Pattern 给卡片、建议、对话条目、图表、图标与边框分配多色；正文和辅助文字仍保持中性色。用户选的是色系与组件颜色，不是把页面所有元素染成一种颜色。
- 使用现有 `Logo`（d·）、首页 Sailboat、Chatbot 的 Bot 默认头像以及 `UserAvatar`；不在新页面各自创造品牌标识。

## 组件放在哪里

只服务一个能力的组件放在 `src/features/<id>/` 或其 `components/` 下。例如 `chat/model-picker.tsx`、`chat/outline.tsx`。两个以上页面需要相同稳定接口时，再抽到 `src/client/<component>.tsx`；不要为了复用外观把业务请求也集中到公共组件。

普通 UI 组件不需要 feature manifest、Kernel 服务或 client registry 条目；只有可导航的产品页面才接入 feature registry。产品能力的服务端与客户端仍共同放在 feature 目录。

### 当前可复用的接口

| 组件 / hook                         | 位置                        | 用法与边界                                                                                                                    |
| ----------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`                        | `client/components.tsx`     | `eyebrow`、`title`、`description`、可选 `action`；统一页面标题与操作位置                                                      |
| `Empty` / `Spinner` / `ErrorNote`   | 同上                        | 空状态、加载状态、`text` 错误反馈；Spinner 含 status、ErrorNote 含 alert                                                      |
| `Modal`                             | 同上                        | `title`、`close`、`children`；原生 dialog，支持 Escape 与外部点击关闭                                                         |
| `useLoad`                           | 同上                        | `loader`、可选依赖数组；返回 data / error / reload，无全局缓存                                                                |
| `api` / `post` / `patch` / `remove` | `client/api.ts`             | 相对 API 路径，例如 `/prompts`；不要重复 `/api`                                                                               |
| `useWorkspace`                      | `client/context.tsx`        | user、setUser、models、conversations、features、refresh、navigate、notify、草稿                                               |
| `useUi`                             | `client/ui-preferences.tsx` | preferences、resolvedTheme、fontSize、setFontSize、save；激活账户由 Shell 管理                                                |
| `Tooltip`                           | `client/tooltip.tsx`        | `label`、触发内容 `children`、浮层 `content`、可选 `className`；悬停 / 聚焦 / 点击固定，Escape 与外侧关闭；内容不可含交互控件 |
| `UserAvatar`                        | `client/user-avatar.tsx`    | `user: { displayName, avatar }`，可选 `size`；图片失败回退首字                                                                |
| `AssistantAvatar`                   | `client/ui-preferences.tsx` | 从 UI 偏好读取自定义 Chatbot 图标，无参                                                                                       |
| `Markdown`                          | `client/markdown.tsx`       | `content`、可选 `streaming`；统一 Markdown / 数学 / 图表 / 代码复制                                                           |
| `usePatternColors`                  | `client/color-pattern.tsx`  | `pattern`、`resolve(assignment)`、`style(assignment)`                                                                         |
| `ColorPickerButton`                 | 同上                        | `label`、`value`、`colorKey`、异步 `onChange`；只选择颜色，数据由所属 feature 保存                                            |

源码链接：[公共组件](../src/client/components.tsx)、[色彩](../src/client/color-pattern.tsx)、[偏好](../src/client/ui-preferences.tsx)、[内容](../src/client/markdown.tsx)。当前没有 `Button` / `Card` React 组件，按钮使用原生元素配合公共 CSS 类，不能假定存在某个 UI 库 API。

## 颜色 token

Shell token 的主要来源是 [`shellTokens()`](../src/shared/appearance.ts)，由 `UiProvider` 写到根元素，随 light / dark / system 更新。

| 变量                                             | 语义                                     |
| ------------------------------------------------ | ---------------------------------------- |
| `--ink` / `--muted` / `--faint`                  | 正文 / 辅助文字 / 更弱的说明             |
| `--surface` / `--surface-alt` / `--sidebar`      | 主背景 / 次级表面 / 侧栏                 |
| `--line` / `--soft` / `--selection`              | 边框 / 轻背景 / 当前选择                 |
| `--primary` / `--primary-hover` / `--on-primary` | 主要操作及其前景文字                     |
| `--accent` / `--accent-base`                     | 保留旧命名的中性控件颜色，当前仍是灰度值 |
| `--code` / `--cell` / `--control`                | 代码背景 / 活动格 / 控件状态             |

组件颜色来自 `colors.style({ key, slot?, index? })`：

| 变量                          | 语义                                  |
| ----------------------------- | ------------------------------------- |
| `--item-color`                | 原色色样，适合装饰、图标与图表        |
| `--item-fill` / `--item-soft` | 按明暗模式混合后的组件背景 / 更淡背景 |
| `--item-line`                 | 混合后的边框                          |
| `--item-ink`                  | 与 Shell 一致的中性正文               |

自动颜色依赖稳定的资源 ID / key；同组相邻卡片可以用稳定组 key + index。手动选择保存 `colorSlot: number | null`，null 恢复自动；不要存派生 RGB、不要让 render 里的 `Math.random()` 决定颜色。

新增色系在 `shared/appearance.ts` 的 `colorPatterns` 注册，见架构文档的 [Color Pattern 扩展接口](ARCHITECTURE.md#color-pattern-扩展接口)。当前两组各九色，注册表支持 1–64 色及各自 light / dark 的 `tint.fill/soft/line`。`accentColors` / `accentColor` 保留迁移兼容，不要再用它们重新实现全页主题。

## 字号体系

[`typography.css`](../src/client/typography.css) 固定 rem 根为 16px，语义字号乘统一 `--font-scale`。四档由 [`shared/typography.ts`](../src/shared/typography.ts) 定义，用户选择后立即生效。

| 语义                | CSS 变量                                                           | 标准档                    |
| ------------------- | ------------------------------------------------------------------ | ------------------------- |
| 普通正文 / 聊天正文 | `--font-body` / `--font-chat`                                      | 16px                      |
| 输入                | `--font-input`                                                     | 16px                      |
| 导航 / 按钮 / 控件  | `--font-ui`                                                        | 14px                      |
| 代码                | `--font-code`                                                      | 14px                      |
| 辅助说明            | `--font-caption`                                                   | 12px；紧凑档也不低于 12px |
| 页面标题            | `--font-title`                                                     | 30px                      |
| 分区标题            | `--font-heading-small` / `--font-heading` / `--font-heading-large` | 18 / 20 / 24px            |

紧凑 / 标准 / 舒适 / 较大分别为 90% / 100% / 112.5% / 125%。保留对应的轻微 `--detail-scale` 图标 / 头像调整，不给所有 SVG 或布局整体缩放。标题、输入、按钮用自己的语义变量，不能把整个应用统一成一个字号。

新组件不硬编码字号，不在手机媒体查询中缩小聊天正文。行高用无单位比例，控件用内容驱动高度与 `min-height`；复杂长文本允许换行。侧栏宽度、容器布局不随字号比例放大，不使用页面 zoom / transform 模拟字号。

## 示例：新增一张可复用卡片

以下是示例组件，不是现有导出。若只用于一个 feature，放在它的目录；确定跨页面复用后可放 `src/client/resource-card.tsx`。使用方负责请求、持久化与跳转，组件只接收数据和回调。

```tsx
import { ArrowUpRight } from 'lucide-react';
import { usePatternColors } from './color-pattern';

export function ResourceCard({
  id,
  title,
  description,
  colorSlot = null,
  onOpen,
}: {
  id: string;
  title: string;
  description: string;
  colorSlot?: number | null;
  onOpen: () => void;
}) {
  const colors = usePatternColors();
  return (
    <article
      className="panel pattern-card resource-card"
      style={colors.style({ key: id, slot: colorSlot })}
    >
      <h3 className="resource-card-title">{title}</h3>
      <p className="resource-card-description">{description}</p>
      <button type="button" className="button" onClick={onOpen} aria-label={`打开 ${title}`}>
        打开
        <ArrowUpRight size={16} aria-hidden="true" />
      </button>
    </article>
  );
}
```

对应 CSS（例如 `src/client/resource-card.css`，在 `client/main.tsx` 现有导入之后显式接入）：

```css
.resource-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  padding: 20px;
  border-color: var(--item-line);
  background: var(--item-soft);
  color: var(--item-ink);
}
.resource-card-title {
  font-size: var(--font-heading-small);
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.resource-card-description {
  color: var(--muted);
  font-size: var(--font-ui);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
@media (max-width: 760px) {
  .resource-card {
    padding: 16px;
  }
}
```

在父级 grid 使用 `minmax(0, 1fr)`、flex 子项使用 `min-width: 0`，防止长标题撑宽页面。需要手动配色时，在卡片内组合 `ColorPickerButton`，由页面的 `onChange` 调用授权 API 并刷新；不要把用户 ID 或未校验的颜色随意写入公共 localStorage。

## CSS 分层与导入

全局顺序明确写在 [`client/main.tsx`](../src/client/main.tsx)：

```text
styles.css                       基础元素、Shell、原有页面结构
responsive.css                   原有响应式规则
katex/dist/katex.min.css          公式样式
enhancements.css                 已有富文本、设置与界面迭代样式
appearance.css                   主题与 Color Pattern 的样式映射
syntax-highlighting.css          独立的明暗代码 token
typography.css                   统一字号与相关适配
features/chat/navigation.css     聊天阅读位置与大纲
features/chat/composer.css       最后的紧凑输入框与模型弹层规则
```

这是当前 CSS 层叠约定，不是已经实现了 CSS Modules 或 `@layer`。部分旧规则使用 `:root .selector` 提高优先级；修样式前检查实际生效规则。新 feature 使用 `.bookmarks-*` 等专属类，不把覆盖堆进全局 `enhancements.css`，不通过 `!important` 掩盖不明来源的冲突。

CSS 必须显式导入，可在所属 client 模块导入仅作用于本功能的样式；涉及公共覆盖顺序时放到 `main.tsx` 合适位置并说明原因。优先直接修改负责该行为的规则，避免同一个选择器在多个文件反复叠加。

现有公共样式包括 `.page`、`.panel`、`.button`、`.button.primary`、`.icon-button`、`.row`、`.grow`、`.muted`、`.modal-actions`、`.table-wrap`；它们是 CSS 类，不是组件库。不要使用未在项目里定义的 utility class。

## 交互、内容与可访问性

- 每个异步页面有加载、空、成功、失败状态；提交有 busy / disabled 与错误反馈，不能失败后静默关闭。纯按钮明确 `type="button"`，提交按钮明确 `type="submit"`。
- 输入有 label；图标按钮有 `aria-label`；只起装饰作用的图标用 `aria-hidden`。状态不能只通过颜色表达，键盘焦点要可见。
- 沿用当前圆角、细边框、轻背景和克制阴影；同类控件使用现有 `.button` / `.icon-button`，避免复制近似样式制造第二套视觉尺寸。
- 模态窗口使用 `Modal`，验证 Escape、点击外侧、忙碌状态与焦点返回。长表单的 dialog 自身可滚动，不把操作按钮挤出视口。
- 轻量选择浮层可参考 [`ModelPicker`](../src/features/chat/model-picker.tsx)：原生 Popover、顶层显示、视口约束、关闭恢复焦点；不要只用巨大 z-index 对抗父容器裁切。
- 新 tablist 需考虑键盘切换、`aria-selected`、tab 与 panel 的关联；参考偏好页面已有色系标签实现。
- 输出 Markdown 统一用 `Markdown`；代码复制统一用 `copyText`。KaTeX 不等同完整 TeX 编译器；Mermaid 完成后渲染，流式期间保留源码。不要另开 raw HTML 渲染通路。
- `syntax-highlighting.css` 的代码 token 不继承 Shell 的 muted 颜色；验证明暗切换时关键词、函数、数值、字符串、注释仍有区分。
- 聊天输入沿用 Tiptap 实时编辑，不再增加编辑 / 预览切换。编辑器要保留选择与 undo；中文输入法合成期间不能发送。桌面和手机 Enter 的既有行为见 README。
- 保留聊天的独立滚动容器、底部跟随、上翻后暂停、大纲定位和返回最新按钮。组件 cleanup 不能调用聊天停止 API。

## 来源列表与连接诊断

来源列表使用 `models-provider-list` / `models-provider-card`：图标、名称 / 协议、API 地址及元信息集中排列，右侧提供探测、编辑、删除。窄屏操作区换到下一行，长地址可折行，保留触控命中区域；不通过缩小字号提高密度。样式位于 feature 旁的 `models.css`，保持灰色框架与四档语义字号。

来源表单只做模型探测，结果采用限高滚动列表；保存后复用白名单选择弹窗，不堆叠原生 dialog。模型设置中使用 `ModelConnectionProbe`：显示已保存协议与模型、可选思考程度、按钮及诊断指标。首段文本与总耗时分开，缺失值显示“未收到 / 未上报”；不能把计量缺失显示为零。测试期间禁止重复提交及关闭表单，结束或失败后恢复操作，结果支持屏幕阅读器 status 提示。诊断日志使用原生 details/summary，失败时默认展开，分别显示请求输入、上游 HTTP 响应、模型输出和错误；只用纯文本 pre 渲染，长行折行、区域限高滚动，不能渲染上游 HTML。日志显示脱敏及截断提示，Jev 测试明确标注英文输入。

## 模型排序与回复用量

`features/models/sortable-models.tsx` 使用 dnd-kit 的 Pointer / Keyboard sensors 和 SortableContext；拖动手柄单独设置 touch-action: none，行内容正常滚动。列表保留表格语义，窄屏转换为逐项卡片；DragOverlay 与位移动画保持表格列宽一致，尊重 prefers-reduced-motion。列表乐观更新，保存期间禁止重复排序，失败恢复并展示错误。默认标记跟随首个已启用项，聊天选择列表以首个可用项标记默认。后续分组排序应复用交互约定，但不能复用本组件的模型权限逻辑。

`features/chat/token-usage.tsx` 在回复操作行与复制并列，调用共享 Tooltip；浮层使用原生 Popover 顶层定位，避免被聊天滚动容器裁切。不要把 null 当 0，失败回复可能有真实的已上报用量。仅统计 Token，不显示价格估算；颜色与字号继承 Shell 中性 token / font-caption、font-ui。手机点击可固定浮层，桌面悬停与键盘聚焦均可查看。

`features/chat/generation-time.tsx` 在同一操作行显示回复用时，使用 font-caption 和中性文字；小于 0.1 秒显示“< 0.1 秒”，其余显示一位小数。未完成回复标注“已用时”，未计时的旧消息不显示。小字随操作行换行，不能覆盖复制或 Token 控件。

用量统计的最近调用表格局部采用 font-ui（标准档 14px，原为 font-caption 的 12px）；表头、状态和正文遵循统一缩放，手机端不额外缩小。`features/usage/usage.css` 的 usage-status 使用独立的语义色：完成为绿色、失败为红色，已停止 / 生成中保持中性。明暗主题各有高对比前景和淡底色，保留文字和圆点标记，不依赖颜色独自传达状态。这属于语义色例外，不跟随装饰性的 Color Pattern，也不改写全局 badge 或 td。

这些 feature CSS 在所属模块显式导入，类名前缀为 models-* / chat-token-*；通用 Tooltip 使用 ds-tooltip。不要修改全局表格或 copy-button 规则来实现局部外观。

## 验证与同步

UI 变更至少查看：light / dark（含系统跟随）、自然鲜明 / 柔和经典、四档字号、桌面与手机、长标题 / 表格 / 代码 / 公式 / 弹窗、键盘与触控、刷新与账号切换后的状态。

常用回归位置：`tests/e2e/layout.spec.ts` 检查字号和长内容布局；`shell.spec.ts` 检查 Shell、头像、代码主题和模型选择；`workspace.spec.ts` 检查编辑器、配色持久化和离开恢复。`appearance.test.ts` 检查色系与对比度，`markdown.test.tsx` 检查渲染行为。根据本次影响挑选用例，共享 token 或布局改变时执行完整桌面 / 手机回归。

新增公共组件时更新本页接口表；新增 token 时说明语义与适用范围；更改样式顺序时同时更新上方顺序说明；产品交互变化同步 README。涉及全项目规则时，再同步 [AGENTS.md](../AGENTS.md) 的简要约束。

## 聊天拓展能力

聊天输入栏的 `ExtensionControls` 消费核心 `/extensions` 目录，不导入 Search 实现。输入栏只显示统一拼图按钮，点击打开原生 Popover 顶层中的能力列表；每项显示自己的图标、说明与 Auto / On / Off 原生单选控件，支持方向键、Space、Escape 和焦点恢复。菜单响应可视视口、滚动及手机软键盘，避免输入区裁切。未配置或管理员关闭的能力禁用，生成和保存模式时同样禁用。模式按账户保存在服务器；发送时提交快照。

管理入口是设置中的“拓展能力”。可选插件通过 `ClientFeature.settingsParent` 将设置页归于该入口，保留自己的 client 页面，不重复加入设置侧栏。核心页采用类似模型管理的紧凑灰度条目列表，不使用 Color Pattern 背景或彩色边框。每项显示能力、可用状态、默认模式、能力设置和插件设置；手机换行保留触控区域。Auto 策略与辅助模型选择放入该条目的原生 Modal，插件专属配置继续使用独立子页；插件停用后显示重新启用入口。列表默认模式与聊天菜单复用 `ExtensionModeControl` 和 `useExtensions`，共用当前账户偏好，保存后同步到同源标签页。

回复的 `ExtensionDetails` 使用原生 details/summary 展示状态、搜索词、编号来源和分阶段 Token；来源标题与摘要以纯文本呈现，外链使用安全 HTTP(S) URL、noopener noreferrer。状态独立使用明暗绿色 / 红色并保留文字。最终回答继续用原有安全 Markdown 管线，回复旁 Token 只表示最终回答调用，拓展消耗在详情和统计中查看。总耗时包含拓展处理。

新增能力 UI 必须检查明暗主题、四档字号、手机触控、焦点与长链接换行，不允许横向撑破聊天栏。
