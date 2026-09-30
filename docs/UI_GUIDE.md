# UI 组件与视觉规范

本页是 Drift Space 的 UI 开发契约。Quiet Precision 以内容优先、紧凑节奏、低干扰反馈组织现有 Web Shell；Notion / Apple 仅作为视觉参考，不引入对应产品代码或假定具备它们的全部功能。新增组件以当前源码为基础，规范调整在同次变更中同步本页与相关测试。

## 信息架构与视觉分工

- Shell 包含品牌、主导航、对话列表、用户入口与内容区域，使用**纯黑白灰**。不要恢复灰褐色框架或让绿色 / Color Pattern 接管整页文字。
- 工作区放对话、Skill 库等产品能力；统计独立分组；左下角用户入口进入设置。通用设置、账户设置、相关信息及管理员页面均属于设置容器。
- feature 页面只负责自己的内容，不再创建第二套全局侧栏、用户菜单或主题 Provider。功能管理区分 Core / Plugin；普通用户不能看到管理员操作。
- Color Pattern 给卡片、建议、对话分组、图表、图标与边框分配多色；正文和辅助文字仍保持中性色。用户选的是色系与组件颜色，不是把页面所有元素染成一种颜色。
- 使用现有 `Logo`（d·）、首页 Sailboat、Chatbot 的 Bot 默认头像以及 `UserAvatar`；不在新页面各自创造品牌标识。

## 组件放在哪里

只服务一个能力的组件放在 `src/features/<id>/` 或其 `components/` 下。例如 `chat/model-picker.tsx`、`chat/outline.tsx`。两个以上页面需要相同稳定接口时，再抽到 `src/client/<component>.tsx`；不要为了复用外观把业务请求也集中到公共组件。

普通 UI 组件不需要 feature manifest、Kernel 服务或 client registry 条目；只有可导航的产品页面才接入 feature registry。产品能力的服务端与客户端仍共同放在 feature 目录。

### 当前可复用的接口

| 组件 / hook                         | 位置                           | 用法与边界                                                                                                                    |
| ----------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`                        | `client/components.tsx`        | `eyebrow`、`title`、`description`、可选 `action`；统一页面标题与操作位置                                                      |
| `Empty` / `Spinner` / `ErrorNote`   | 同上                           | 空状态、加载状态、`text` 错误反馈；Spinner 含 status、ErrorNote 含 alert                                                      |
| `Modal`                             | 同上                           | `title`、`close`、`children`；原生 dialog，支持 Escape 与外部点击关闭                                                         |
| `useLoad`                           | 同上                           | `loader`、可选依赖数组；返回 data / error / reload，无全局缓存                                                                |
| `api` / `post` / `patch` / `remove` | `client/api.ts`                | 相对 API 路径，例如 `/skills`；不要重复 `/api`                                                                                |
| `useWorkspace`                      | `client/context.tsx`           | user、setUser、models、conversations、features、refresh、navigate、notify、草稿                                               |
| `useUi`                             | `client/ui-preferences.tsx`    | preferences、resolvedTheme、fontSize、setFontSize、save；激活账户由 Shell 管理                                                |
| `Tooltip`                           | `client/tooltip.tsx`           | `label`、触发内容 `children`、浮层 `content`、可选 `className`；悬停 / 聚焦 / 点击固定，Escape 与外侧关闭；内容不可含交互控件 |
| `SegmentedControl`                  | `client/segmented-control.tsx` | `label`、`value`、`options`、`onChange`，可选 `disabled` / `busy` / `className`；受控分段单选，保存与业务逻辑由调用方负责     |
| `UserAvatar`                        | `client/user-avatar.tsx`       | `user: { displayName, avatar }`，可选 `size`；图片失败回退首字                                                                |
| `AssistantAvatar`                   | `client/ui-preferences.tsx`    | 从 UI 偏好读取自定义 Chatbot 图标，无参                                                                                       |
| `Markdown`                          | `client/markdown.tsx`          | `content`、可选 `streaming`；统一 Markdown / 数学 / 图表 / 代码复制                                                           |
| `usePatternColors`                  | `client/color-pattern.tsx`     | `pattern`、`resolve(assignment)`、`style(assignment)`                                                                         |
| `ColorPickerButton`                 | 同上                           | `label`、`value`、`colorKey`、异步 `onChange`；只选择颜色，数据由所属 feature 保存                                            |

源码链接：[公共组件](../src/client/components.tsx)、[色彩](../src/client/color-pattern.tsx)、[偏好](../src/client/ui-preferences.tsx)、[内容](../src/client/markdown.tsx)。当前没有 `Button` / `Card` React 组件，按钮使用原生元素配合公共 CSS 类，不能假定存在某个 UI 库 API。

`SegmentedControl` 用于同一设置的互斥选项，使用原生 radio group 保留方向键、Space 与读屏语义；不用于切换内容面板的 tabs。`options` 包含字符串 `value`、`label` 和可选 `description`。`value` 由父级控制；`busy` 阻止重复修改但保留键盘焦点，`disabled` 表示不可操作。组件自行导入命名空间样式 `segmented-control.css`，统一灰度 token、选中态、焦点与手机触控区域；页面只调整所在布局，不复制控件内部样式。

分段选项等宽，选中背景使用独立滑块，以 240ms 缓出曲线平移；文字及桌面悬停背景以 160ms 过渡。滑块由 CSS 按控件实际宽度计算位置，适配字号、手机布局和 Popover 重新打开；连续切换时从当前动画位置过渡，不通过定时器逐帧更新。动画跟随父级确认的 `value`，不提前表示保存成功；系统启用 `prefers-reduced-motion` 时直接切换。

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

## 表面层次与对话分组

公共几何 token 位于 `styles.css`：`--space-1/2/3/4/6/8/10/12` 对应 4/8/12/16/24/32/40/48px；`--radius-hover/control/panel/floating` 对应 4/6/8/12px；`--control-sm/md/lg` 对应 24/28/32px。新增固定间距先选这些 token，字号与随字号扩张的控件仍使用语义字号和内容驱动尺寸。桌面侧栏 240px、顶栏 44px，手机顶栏 56px；侧栏宽度不随字号放大。

侧栏为次级灰色表面，内容区为主表面，使用低对比的 1px 细线和留白建立层次。静态 `.panel`、首页建议和 Color Pattern 卡片无阴影；仅弹窗、Popover、Tooltip、Toast 与拖拽浮层使用 `--shadow-floating`。面板和输入框使用不同圆角，不以大圆角包装整个 Shell。顶栏保留已有轻度模糊。`shared/appearance.ts` 是运行时明暗 Shell 颜色的来源；`appearance.css` 提供同值回退，不让 Color Pattern 接管正文。

Quiet Precision 的跨页面映射集中在 `client/quiet-precision.css`，在公共 CSS 之后导入；局部结构和状态仍由 feature 自己的 CSS 负责。聊天保留阅读宽度，设置页用分组间距和细线代替卡片套卡片，模型来源与扩展能力使用紧凑行，统计手机端把最近调用表格逐项呈现。侧栏搜索与 Skill 库搜索是完整的复合控件：外层负责唯一的边框、背景和键盘焦点反馈，内层 input 不再单独画框或轮廓，图标、文字与快捷键共用一条对齐线。移动端高频操作命中区至少 44px；键盘焦点使用 3px 低透明度中性色环，按钮按下有很小的即时缩放，系统减少动态效果时取消空间动画。Toast 4 秒自动关闭，悬停或聚焦期间暂停；公共 Tooltip 桌面悬停 500ms 后出现，相邻提示快速切换，键盘聚焦和触屏点击立即显示。不要把整页缩放当作字号设置。

`features/chat/conversation-list.tsx` 负责侧栏对话组织，Shell 仍负责导航和账户状态。分组标题、图标底色与边框使用 `usePatternColors()` + 分组 ID / `colorSlot`；分组内外的对话条目、消息气泡、助手头像与阅读大纲保持中性灰度。普通对话不提供单独选色入口，旧 `colorSlot` 仅保留接口兼容。首页建议、Skill 与统计配色不变。

分组是单层可折叠列表，用按钮的 `aria-expanded` / `aria-controls` 关联组内区域；名称截断并保留 title，计数、生成提示和操作不挤压到视口外。搜索分组名称或对话标题时自动展开结果；进入对话时展开其分组。分组编辑和对话管理复用原生 Modal，支持 Escape、焦点返回、保存错误和删除确认；删除分组明确说明对话保留。图标来自 lucide 固定选项或一个 emoji 字素，作为纯文本渲染。配色使用当前注册表中的原生 radio，不另建色板，也不嵌套选色弹窗。

桌面将对话操作收进悬停 / 聚焦可见的更多按钮；触屏保持可见并扩大命中区域。分组动作始终可见。CSS 放在 `conversation-list.css`，仅使用 `chat-group-*` / `chat-library` 命名空间；展开箭头遵循减少动态效果偏好。

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
quiet-precision.css              跨页面间距、圆角、浮层与密度映射
```

这是当前 CSS 层叠约定，不是已经实现了 CSS Modules 或 `@layer`。部分旧规则使用 `:root .selector` 提高优先级；修样式前检查实际生效规则。`quiet-precision.css` 只映射跨页面公共尺寸和表面，不放某个 feature 的业务状态。新 feature 使用 `.bookmarks-*` 等专属类，不把覆盖堆进全局 `enhancements.css`，不通过 `!important` 掩盖不明来源的冲突。

CSS 必须显式导入，可在所属 client 模块导入仅作用于本功能的样式；涉及公共覆盖顺序时放到 `main.tsx` 合适位置并说明原因。优先直接修改负责该行为的规则，避免同一个选择器在多个文件反复叠加。

现有公共样式包括 `.page`、`.panel`、`.button`、`.button.primary`、`.icon-button`、`.row`、`.grow`、`.muted`、`.modal-actions`、`.table-wrap`；它们是 CSS 类，不是组件库。不要使用未在项目里定义的 utility class。

## 交互、内容与可访问性

- 每个异步页面有加载、空、成功、失败状态；提交有 busy / disabled 与错误反馈，不能失败后静默关闭。纯按钮明确 `type="button"`，提交按钮明确 `type="submit"`。
- 输入有 label；图标按钮有 `aria-label`；只起装饰作用的图标用 `aria-hidden`。状态不能只通过颜色表达，键盘焦点要可见。
- 圆角与阴影遵循下方「表面层次与对话分组」；同类控件使用现有 `.button` / `.icon-button`，避免复制近似样式制造第二套视觉尺寸。
- 模态窗口使用 `Modal`，验证 Escape、点击外侧、忙碌状态与焦点返回。长表单的 dialog 自身可滚动，不把操作按钮挤出视口。
- 轻量选择浮层可参考 [`ModelPicker`](../src/features/chat/model-picker.tsx)：原生 Popover、顶层显示、视口约束、关闭恢复焦点；不要只用巨大 z-index 对抗父容器裁切。
- 新 tablist 需考虑键盘切换、`aria-selected`、tab 与 panel 的关联；参考偏好页面已有色系标签实现。
- 输出 Markdown 统一用 `Markdown`；代码复制统一用 `copyText`。KaTeX 不等同完整 TeX 编译器；Mermaid 完成后渲染，流式期间保留源码。不要另开 raw HTML 渲染通路。
- `syntax-highlighting.css` 的代码 token 不继承 Shell 的 muted 颜色；验证明暗切换时关键词、函数、数值、字符串、注释仍有区分。
- 聊天输入沿用 Tiptap 实时编辑，不再增加编辑 / 预览切换。编辑器要保留选择与 undo；中文输入法合成期间不能发送。桌面和手机 Enter 的既有行为见 README。
- 保留聊天的独立滚动容器、底部跟随、上翻后暂停、大纲定位和返回最新按钮。组件 cleanup 不能调用聊天停止 API。

## Skill 卡片

Skill 卡片的本地样式位于 `features/prompts/prompts.css`，使用 `prompts-*` 命名空间。32px 图标、标题、版本和参考文件数集中在首行；简介、标签与底部操作沿标题左边界对齐。标题使用 font-heading（标准 20px）与 650 字重，简介使用 font-ui（标准 14px），最多显示两行。卡片只使用 Color Pattern 的轻微背景色与低对比边框，标签和图标保留色彩，操作采用中性色的轻量按钮，不在彩色底板上放突兀的黑色按钮。标签单行横向滚动，底部并列「编辑」和「载入新对话」；选色与删除在带 `aria-expanded` 的「更多操作」内，删除仍需确认。载入时传递 id/version 的技能引用，保持消息输入正文不变。

列表上方是搜索框、结果数与可多选的标签按钮；搜索输入短暂延迟后请求服务端，保留正文搜索能力，标签在窄屏横向滚动且用 aria-pressed 表达筛选状态。无匹配时提供清除入口，不能误报为空库。编辑复用原生 Modal；手机端编辑器贴底展示，底部保存操作随弹窗滚动保持可见，参考文档默认折叠、已有文档默认展开。标签输入在中文输入法合成期间不处理回车，已选标签可移除。简介可手写，生成按钮旁保留配置与用量说明；生成期间锁定标题和正文，防止返回结果覆盖另一份草稿，关闭编辑窗口取消这一次简介调用。保存失败保留输入，Escape 关闭后返回触发按钮。

聊天输入栏的「附件 → Skill 库」选择弹窗由 `features/skills/chat-controls.tsx` 和 `skills.css` 实现：桌面搜索与紧凑的标签筛选并排，手机上下排列；结果以分割线组织成紧凑列表，复选框、标题 / 版本、简介、标签和右侧预览共用行内层级，不套独立大卡片。点击复选框即选择，选中态同时有勾选和底色反馈；预览在对应条目内展开，可再次点击收起，版本更新操作保留在条目中。结果列表独立滚动，底部已选数量与完成按钮保持可见。手机弹窗按内容确定高度并以视口为上限，触控目标至少 44px，长名称与参考文档可换行或局部滚动。

「设置 → Skill 库」使用该 feature 的 settingsComponent，模型下拉只显示当前用户可用 LLM；失效选择明确提示重新选择。所有字号使用语义 token，卡片按可用宽度自动填列、至少保留易读的内容宽度，手机一列；触屏操作增大命中区域，明暗均保留中性正文。

## 来源列表与连接诊断

来源列表使用 `models-provider-list` / `models-provider-card`：图标、名称 / 协议、API 地址及元信息集中排列，右侧提供探测、编辑、删除。窄屏操作区换到下一行，长地址可折行，保留触控命中区域；不通过缩小字号提高密度。样式位于 feature 旁的 `models.css`，保持灰色框架与四档语义字号。

来源标题旁的状态灯反映后台模型列表接口探测：正常绿、异常红、待检查 / 检查中灰，并始终附文字。悬停展示上次检查时间。它不承诺单个模型可生成；具体模型仍使用显式连通性测试。状态色属于语义例外，不把来源卡片或 Shell 染色。

来源表单只做模型探测，结果采用限高滚动列表；保存后复用白名单选择弹窗，不堆叠原生 dialog。模型设置中使用 `ModelConnectionProbe`：显示已保存协议与模型、可选思考程度、按钮及诊断指标。首段文本与总耗时分开，缺失值显示“未收到 / 未上报”；不能把计量缺失显示为零。测试期间禁止重复提交及关闭表单，结束或失败后恢复操作，结果支持屏幕阅读器 status 提示。诊断日志使用原生 details/summary，失败时默认展开，分别显示请求输入、上游 HTTP 响应、模型输出和错误；只用纯文本 pre 渲染，长行折行、区域限高滚动，不能渲染上游 HTML。日志显示脱敏及截断提示，Jev 测试明确标注英文输入。

## 模型排序与回复用量

`features/models/sortable-models.tsx` 使用 dnd-kit 的 Pointer / Keyboard sensors 和 SortableContext；拖动手柄单独设置 touch-action: none，行内容正常滚动。列表保留表格语义，窄屏转换为逐项卡片；DragOverlay 与位移动画保持表格列宽一致，尊重 prefers-reduced-motion。列表乐观更新，保存期间禁止重复排序，失败恢复并展示错误。默认标记跟随首个已启用项，聊天选择列表以首个可用项标记默认。后续分组排序应复用交互约定，但不能复用本组件的模型权限逻辑。

`features/chat/token-usage.tsx` 在回复操作行与复制并列，调用共享 Tooltip；浮层使用原生 Popover 顶层定位，避免被聊天滚动容器裁切。不要把 null 当 0，失败回复可能有真实的已上报用量。仅统计 Token，不显示价格估算；颜色与字号继承 Shell 中性 token / font-caption、font-ui。手机点击可固定浮层，桌面悬停与键盘聚焦均可查看。

`features/chat/generation-time.tsx` 在同一操作行显示回复用时，使用 font-caption 和中性文字；小于 0.1 秒显示“< 0.1 秒”，其余显示一位小数。未完成回复标注“已用时”，未计时的旧消息不显示。小字随操作行换行，不能覆盖复制或 Token 控件。

最后一条用户提问提供“编辑提问”，将原内容和图片放回既有富文本输入框，发送后替换这轮问答；输入框显示替换提示和取消入口，取消恢复原草稿。最近一次失败或已停止的回复在同一操作行显示“重新输出”，复用原提问与图片并建立新任务，保留输入框里的未发送草稿。生成中禁用这些操作。失败原因显示在回复下方；用量和旧任务记录不因重新输出而消失。

用量统计的最近调用表格局部采用 font-ui（标准档 14px，原为 font-caption 的 12px）；表头、状态和正文遵循统一缩放，手机端不额外缩小。`features/usage/usage.css` 的 usage-status 使用独立的语义色：完成为绿色、失败为红色，已停止 / 生成中保持中性。明暗主题各有高对比前景和淡底色，保留文字和圆点标记，不依赖颜色独自传达状态。这属于语义色例外，不跟随装饰性的 Color Pattern，也不改写全局 badge 或 td。

这些 feature CSS 在所属模块显式导入，类名前缀为 models-* / chat-token-*；通用 Tooltip 使用 ds-tooltip。不要修改全局表格或 copy-button 规则来实现局部外观。

## 验证与同步

UI 变更至少查看：light / dark（含系统跟随）、自然鲜明 / 柔和经典、四档字号、桌面与手机、长标题 / 表格 / 代码 / 公式 / 弹窗、键盘与触控、刷新与账号切换后的状态。

常用回归位置：`tests/e2e/layout.spec.ts` 检查字号和长内容布局；`shell.spec.ts` 检查 Shell、头像、代码主题和模型选择；`workspace.spec.ts` 检查编辑器、配色持久化和离开恢复。`appearance.test.ts` 检查色系与对比度，`markdown.test.tsx` 检查渲染行为。根据本次影响挑选用例，共享 token 或布局改变时执行完整桌面 / 手机回归。

新增公共组件时更新本页接口表；新增 token 时说明语义与适用范围；更改样式顺序时同时更新上方顺序说明；产品交互变化同步 README。涉及全项目规则时，再同步 [AGENTS.md](../AGENTS.md) 的简要约束。

## 聊天拓展能力

聊天输入栏的 `ExtensionControls` 消费核心 `/extensions` 目录，不导入 Search 实现。输入栏显示统一的四菱形拓展按钮，点击打开原生 Popover 顶层中的能力列表；每项显示自己的图标、说明与 Auto / On / Off 原生单选控件，支持方向键、Space、Escape 和焦点恢复。菜单响应可视视口、滚动及手机软键盘，避免输入区裁切。未配置或管理员关闭的能力禁用，生成和保存模式时同样禁用。模式按账户保存在服务器；发送时提交快照。

管理入口是设置中的“拓展能力”。可选插件通过 `ClientFeature.settingsParent` 将设置页归于该入口，保留自己的 client 页面，不重复加入设置侧栏。核心页采用类似模型管理的紧凑灰度条目列表，不使用 Color Pattern 背景或彩色边框。每项显示能力、可用状态、默认模式、能力设置和插件设置；手机换行保留触控区域。Auto 策略与辅助模型选择放入该条目的原生 Modal，插件专属配置继续使用独立子页；插件停用后显示重新启用入口。列表默认模式与聊天菜单通过 `ExtensionModeControl` 复用公共 `SegmentedControl`，由 `useExtensions` 管理当前账户偏好，保存后同步到同源标签页。

回复的 `ExtensionDetails` 默认折叠为带同款四菱形图标的状态条，根据已有 run 状态与当前调用阶段实时显示理解问题、自动判断、生成搜索词、检索进度或终态；终态优先于调用阶段，失败和停止不继续显示执行中。拓展执行期间隐藏重复的通用“正在思考”提示，拓展完成后恢复最终回答生成提示。原生 details/summary 支持点击及键盘展开；状态变化通过 polite live region 提示，保持用户当前的展开状态。旋转进度图标与展开箭头遵循减少动态效果偏好。

展开后，搜索词、编号来源和分阶段 Token 放在同一个可聚焦的详情区，桌面最高 `min(360px, 45dvh)`，手机最高 `min(300px, 40dvh)`；详情区内部纵向滚动并限制滚动传递，状态条始终留在滚动区外。来源标题与摘要以纯文本呈现，外链使用安全 HTTP(S) URL、noopener noreferrer。状态独立使用明暗绿色 / 红色并保留文字。最终回答继续用原有安全 Markdown 管线，回复旁 Token 表示回答模型的全部请求，拓展消耗在详情和统计中查看。总耗时包含拓展处理。

新增能力 UI 必须检查明暗主题、四档字号、手机触控、焦点与长链接换行，不允许横向撑破聊天栏。

## 聊天 Skill 附件

回形针打开原生 Popover，包含「添加图片」与「Skill 库」；后者始终带「插件」标签。模型无图片能力时只禁用图片项，插件停用时禁用 Skill 库项并说明原因。菜单适应可视视口和软键盘，Escape 关闭并恢复触发按钮焦点。

选择器使用原生 Modal，可搜索名称/简介/标签、筛选标签、预览指令与参考文本并多选。输入栏标签显示名称、固定版本、本对话/仅本轮范围与移除按钮；选择随下一条消息提交，不覆盖编辑器正文。已有版本落后时，选择器提供显式「更新到 vN」。管理页保持原有 Color Pattern 卡片；聊天技能标签和加载详情使用中性表面与语义字号。

`SkillDetails` 折叠显示实际读取记录与每次模型请求状态/用量，限制内部高度和滚动。文档预览沿用安全 Markdown 管线，参考文件以纯文本展示。编辑器新增参考文件路径和正文表单；保存产生新版本，版本冲突保留草稿并提示重新打开。
