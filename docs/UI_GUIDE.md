# UI 组件与视觉规范

本页是 Drift Space 的 UI 开发契约。Quiet Precision 以内容优先、紧凑节奏、低干扰反馈组织现有 Web Shell；Notion / Apple 仅作为视觉参考，不引入对应产品代码或假定具备它们的全部功能。新增组件以当前源码为基础，规范调整在同次变更中同步本页与相关测试。

## 信息架构与视觉分工

- Shell 包含品牌、主导航、对话列表、用户入口与内容区域，使用**纯黑白灰**。不要恢复灰褐色框架或让绿色 / Color Pattern 接管整页文字。
- 工作区放对话、Skill 库、记忆等产品能力；统计独立分组；左下角用户入口进入设置。通用设置、账户设置、相关信息及管理员页面均属于设置容器。
- feature 页面只负责自己的内容，不再创建第二套全局侧栏、用户菜单或主题 Provider。功能管理区分 Core / Plugin；普通用户不能看到管理员操作。
- Color Pattern 给卡片、对话分组、图表、图标与边框分配多色；正文和辅助文字仍保持中性色。用户选的是色系与组件颜色，不是把页面所有元素染成一种颜色。
- 空白对话首页只显示个性化问候语与聊天输入框，不放引导卡片、模型数量或品牌标语；使用现有 `Logo`（d·）、Chatbot 的 Bot 默认头像以及 `UserAvatar`，不在新页面各自创造品牌标识。

## 组件放在哪里

只服务一个能力的组件放在 `src/features/<id>/` 或其 `components/` 下。例如 `chat/model-picker.tsx`、`chat/outline.tsx`。两个以上页面需要相同稳定接口时，再抽到 `src/client/<component>.tsx`；不要为了复用外观把业务请求也集中到公共组件。

普通 UI 组件不需要 feature manifest、Kernel 服务或 client registry 条目；只有可导航的产品页面才接入 feature registry。产品能力的服务端与客户端仍共同放在 feature 目录。

### 当前可复用的接口

| 组件 / hook                         | 位置                           | 用法与边界                                                                                                                    |
| ----------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`                        | `client/components.tsx`        | `eyebrow`、`title`、`description`、可选 `action`；统一页面标题与操作位置                                                      |
| `Empty` / `Spinner` / `ErrorNote`   | 同上                           | 空状态、加载状态、`text` 错误反馈；Spinner 含 status、ErrorNote 含 alert                                                      |
| `Modal`                             | 同上                           | `title`、`close`、`children`、可选 `className`；原生 dialog，支持 Escape 与外部点击关闭                                       |
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

嵌套使用 `Modal` 时，Escape 只关闭当前顶层弹窗，不向外层传播 cancel；关闭后焦点恢复到仍连接的打开按钮。例如从产物抽屉打开图片预览，关闭预览后应保留产物抽屉。

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

侧栏为次级灰色表面，内容区为主表面，使用低对比的 1px 细线和留白建立层次。静态 `.panel` 和 Color Pattern 卡片无阴影；仅弹窗、Popover、Tooltip、Toast 与拖拽浮层使用 `--shadow-floating`。面板和输入框使用不同圆角，不以大圆角包装整个 Shell。顶栏保留已有轻度模糊。`shared/appearance.ts` 是运行时明暗 Shell 颜色的来源；`appearance.css` 提供同值回退，不让 Color Pattern 接管正文。

Quiet Precision 的跨页面映射集中在 `client/quiet-precision.css`，在公共 CSS 之后导入；局部结构和状态仍由 feature 自己的 CSS 负责。聊天保留阅读宽度，设置页用分组间距和细线代替卡片套卡片，模型来源与扩展能力使用紧凑行，统计手机端把最近调用表格逐项呈现。侧栏搜索与 Skill 库搜索是完整的复合控件：外层负责唯一的边框、背景和键盘焦点反馈，内层 input 不再单独画框或轮廓，图标、文字与快捷键共用一条对齐线。移动端高频操作命中区至少 44px；键盘焦点使用 3px 低透明度中性色环，按钮按下有很小的即时缩放，系统减少动态效果时取消空间动画。Toast 4 秒自动关闭，悬停或聚焦期间暂停；公共 Tooltip 桌面悬停 500ms 后出现，相邻提示快速切换，键盘聚焦和触屏点击立即显示。不要把整页缩放当作字号设置。

`features/chat/conversation-list.tsx` 负责侧栏对话组织，Shell 仍负责导航和账户状态。分组标题、图标底色与边框使用 `usePatternColors()` + 分组 ID / `colorSlot`；分组内外的对话条目、消息气泡、助手头像与阅读大纲保持中性灰度。普通对话不提供单独选色入口，旧 `colorSlot` 仅保留接口兼容。Skill 与统计仍使用各自的配色。

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
features/chat/composer.css       简约输入框、加号菜单与模型弹层规则
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

## 聊天输入

输入框默认只显示编辑正文与底部一行操作：左侧加号，右侧模型 / 思考程度与发送 / 停止。外框使用中性色细边、24px 圆角和无静态阴影，正文按内容增长并限制高度滚动；模型入口透明，仅悬停时显示轻微背景，发送按钮为 44px 黑白圆形。启用「必须产物」或手动 On 的拓展时，加号旁显示一个可点击的聚合状态标签；默认选项及功能说明不常驻正文区域。

`features/chat/composer-actions.tsx` 的加号菜单统一提供添加图片、Skill 库、产物输出模式、拓展 Auto / On / Off，以及「显示文本格式」复选框。菜单复用原生 Popover，按可视视口和手机软键盘定位并限制高度，Escape 关闭后焦点返回加号；菜单内部的选择控件保留原生键盘操作，行命中区至少 44px。功能说明仅在菜单展开时显示。不能用新增入口绕过已有模型能力、用户授权、生成忙碌或偏好保存中的禁用条件。

`LiveComposer` 的 `formatting` 默认 false。选择「显示文本格式」才显示粗体、列表、代码、公式、表格和撤销工具栏；该开关仅影响当前页面的当前聊天，切换聊天后恢复隐藏。Tiptap 文档和选择不因工具栏显示变化而重建，Markdown 快捷语法、粘贴、撤销、中文输入法和发送规则保持既有行为。

## Skill 卡片

Skill 卡片的本地样式位于 `features/prompts/prompts.css`，使用 `prompts-*` 命名空间。32px 图标、标题、版本和参考文件数集中在首行；简介、标签与底部操作沿标题左边界对齐。标题使用 font-heading（标准 20px）与 650 字重，简介使用 font-ui（标准 14px），最多显示两行。卡片只使用 Color Pattern 的轻微背景色与低对比边框，标签和图标保留色彩，操作采用中性色的轻量按钮，不在彩色底板上放突兀的黑色按钮。标签单行横向滚动，底部并列「编辑」和「载入新对话」；选色与删除作为右上角常驻图标，不展开额外操作行或播放形状变化动画，删除仍需确认。载入时传递 id/version 的技能引用，保持消息输入正文不变。

列表上方是搜索框、结果数与可多选的标签按钮；搜索输入短暂延迟后请求服务端，保留正文搜索能力，标签在窄屏横向滚动且用 aria-pressed 表达筛选状态。无匹配时提供清除入口，不能误报为空库。编辑复用原生 Modal；桌面编辑器加宽，并把名称 / 主指令与简介 / 标签分成两列，参考文档独占下方宽度；手机端恢复单列贴底展示，底部保存操作随弹窗滚动保持可见，参考文档默认折叠、已有文档默认展开。标签输入在中文输入法合成期间不处理回车，已选标签可移除。简介可手写，生成按钮旁保留配置与用量说明；生成期间锁定标题和正文，防止返回结果覆盖另一份草稿，关闭编辑窗口取消这一次简介调用。保存失败保留输入，Escape 关闭后返回触发按钮。

聊天输入栏的「加号 → Skill 库」选择弹窗由 `features/skills/chat-controls.tsx` 和 `skills.css` 实现：桌面搜索与紧凑的标签筛选并排，手机上下排列；结果以分割线组织成紧凑列表，复选框、标题 / 版本、简介、标签和右侧预览共用行内层级，不套独立大卡片。点击复选框即选择，选中态同时有勾选和底色反馈；预览在对应条目内展开，可再次点击收起，版本更新操作保留在条目中。结果列表独立滚动，底部已选数量与完成按钮保持可见。手机弹窗按内容确定高度并以视口为上限，触控目标至少 44px，长名称与参考文档可换行或局部滚动。

「设置 → Skill 库」使用该 feature 的 settingsComponent，模型下拉只显示当前用户可用 LLM；失效选择明确提示重新选择。所有字号使用语义 token，Skill 库卡片在常规桌面每行三张、宽屏四张，中窄窗口两张，手机一张；触屏操作增大命中区域，明暗均保留中性正文。

## 来源列表与连接诊断

来源列表使用 `models-provider-list` / `models-provider-card`：图标、名称 / 协议、API 地址及元信息集中排列，右侧提供探测、编辑、删除。窄屏操作区换到下一行，长地址可折行，保留触控命中区域；不通过缩小字号提高密度。样式位于 feature 旁的 `models.css`，保持灰色框架与四档语义字号。

来源标题旁的状态灯反映后台模型列表接口探测：正常绿、异常红、待检查 / 检查中灰，并始终附文字。悬停展示上次检查时间。它不承诺单个模型可生成；具体模型仍使用显式连通性测试。状态色属于语义例外，不把来源卡片或 Shell 染色。

来源表单只做模型探测，结果采用限高滚动列表；保存后复用白名单选择弹窗，不堆叠原生 dialog。模型设置中使用 `ModelConnectionProbe`：显示已保存协议与模型、可选思考程度、按钮及诊断指标。首段文本与总耗时分开，缺失值显示“未收到 / 未上报”；不能把计量缺失显示为零。测试期间禁止重复提交及关闭表单，结束或失败后恢复操作，结果支持屏幕阅读器 status 提示。诊断日志使用原生 details/summary，失败时默认展开，分别显示请求输入、上游 HTTP 响应、模型输出和错误；只用纯文本 pre 渲染，长行折行、区域限高滚动，不能渲染上游 HTML。日志显示脱敏及截断提示，Jev 测试明确标注英文输入。

## 模型排序与回复用量

模型管理明确显示模型级 LLM / Jev / Embedding 类型。Embedding 表单提供可空配置维度和最近验证维度；连通性测试使用已保存配置，显示配置维度、实际维度、匹配状态、耗时及逐字段实际 Token。没有上报的输出 Token 保留「未上报」。未保存的表单值不参与测试；类型或维度修改后先保存再验证。Embedding 不显示图片 / Skill 工具选项、不进入聊天默认模型。

`features/models/sortable-models.tsx` 使用 dnd-kit 的 Pointer / Keyboard sensors 和 SortableContext；拖动手柄单独设置 touch-action: none，行内容正常滚动。列表保留表格语义，窄屏转换为逐项卡片；DragOverlay 与位移动画保持表格列宽一致，尊重 prefers-reduced-motion。列表乐观更新，保存期间禁止重复排序，失败恢复并展示错误。默认标记跟随首个已启用 LLM，聊天选择列表以首个可用项标记默认。后续分组排序应复用交互约定，但不能复用本组件的模型权限逻辑。

`features/chat/token-usage.tsx` 在回复操作行与复制并列，调用共享 Tooltip；浮层使用原生 Popover 顶层定位，避免被聊天滚动容器裁切。不要把 null 当 0，失败回复可能有真实的已上报用量。仅统计 Token，不显示价格估算；颜色与字号继承 Shell 中性 token / font-caption、font-ui。手机点击可固定浮层，桌面悬停与键盘聚焦均可查看。

`features/chat/generation-time.tsx` 在同一操作行显示回复用时，使用 font-caption 和中性文字；小于 0.1 秒显示“< 0.1 秒”，其余显示一位小数。未完成回复标注“已用时”，未计时的旧消息不显示。小字随操作行换行，不能覆盖复制或 Token 控件。

最后一条用户提问提供“编辑提问”，将原内容和图片放回既有富文本输入框，发送后替换这轮问答；输入框显示替换提示和取消入口，取消恢复原草稿。`useWorkspace` 的 chatDraft / setChatDraft 复用 Shell 生命周期，按账户与 conversationId 隔离正文、图片、产物模式及编辑前草稿；新对话有独立草稿，切换会话恢复各自状态，退出 / 换账户清空，刷新页面不保留。富文本编辑器按会话重建，防止撤销历史串用；异步提交只清理其对应的已接受草稿，不覆盖用户在其他会话的输入，保留该对话的产物模式。

最近一次失败或已停止的回复在同一操作行显示“重新输出”；已完成的最后一条回复显示“再次生成”，打开原生 Modal，复用 ModelPicker 选择已授权模型与思考程度，点击“开始生成”才提交。两者复用原提问、图片与产物模式，建立新任务并替换末条回复，保留未发送草稿。切换会话关闭选择弹窗，关闭恢复焦点，生成中禁用这些操作。失败原因显示在回复下方；用量和旧任务记录不因再次生成而消失。更早轮次不提供替换入口。

用量统计的最近调用表格局部采用 font-ui（标准档 14px，原为 font-caption 的 12px）；表头、状态和正文遵循统一缩放，手机端不额外缩小。`features/usage/usage.css` 的 usage-status 使用独立的语义色：完成为绿色、失败为红色，已停止 / 生成中保持中性。明暗主题各有高对比前景和淡底色，保留文字和圆点标记，不依赖颜色独自传达状态。这属于语义色例外，不跟随装饰性的 Color Pattern，也不改写全局 badge 或 td。

这些 feature CSS 在所属模块显式导入，类名前缀为 models-* / chat-token-*；通用 Tooltip 使用 ds-tooltip。不要修改全局表格或 copy-button 规则来实现局部外观。

## 验证与同步

UI 变更按实际影响选择最小的验收组合；例如本次 Skill 卡片与编辑器只需检查受影响的桌面 / 手机布局、常用明暗主题、长标题、弹窗和相关操作。未触及的表格、代码、公式或账户状态不必每次重测。

常用回归位置：`tests/e2e/layout.spec.ts` 检查字号和长内容布局；`shell.spec.ts` 检查 Shell、头像、代码主题和模型选择；`workspace.spec.ts` 检查编辑器、配色持久化和离开恢复。`appearance.test.ts` 检查色系与对比度，`markdown.test.tsx` 检查渲染行为。根据本次影响挑选用例；共享 token 或布局改变时优先选取受影响的代表页面与设备，只有发现具体跨页面回归迹象时才扩大范围。

新增公共组件时更新本页接口表；新增 token 时说明语义与适用范围；更改样式顺序时同时更新上方顺序说明；产品交互变化同步 README。涉及全项目规则时，再同步 [AGENTS.md](../AGENTS.md) 的简要约束。

## 聊天拓展能力

聊天加号菜单中的拓展列表消费核心 `/extensions` 目录，不导入 Search 实现；通过 `ExtensionModeControl` 展示各项图标、说明与 Auto / On / Off 原生单选控件，支持方向键、Space 和菜单关闭后的焦点恢复。列表共用[聊天输入](#聊天输入)的原生 Popover，未配置或管理员关闭的能力禁用，生成和保存模式时同样禁用。模式按账户保存在服务器；发送时提交快照。

管理入口是设置中的“拓展能力”。可选插件通过 `ClientFeature.settingsParent` 将设置页归于该入口，保留自己的 client 页面，不重复加入设置侧栏。核心页采用类似模型管理的紧凑灰度条目列表，不使用 Color Pattern 背景或彩色边框。每项显示能力、可用状态、默认模式、能力设置和插件设置；手机换行保留触控区域。Auto 策略与辅助模型选择放入该条目的原生 Modal，插件专属配置继续使用独立子页；插件停用后显示重新启用入口。列表默认模式与聊天菜单通过 `ExtensionModeControl` 复用公共 `SegmentedControl`，由 `useExtensions` 管理当前账户偏好，保存后同步到同源标签页。

回复的 `ExtensionDetails` 默认折叠为带同款四菱形图标的状态条，根据已有 run 状态与当前调用阶段实时显示理解问题、自动判断、生成搜索词、检索进度或终态；终态优先于调用阶段，失败和停止不继续显示执行中。拓展执行期间隐藏重复的通用“正在思考”提示，拓展完成后恢复最终回答生成提示。原生 details/summary 支持点击及键盘展开；状态变化通过 polite live region 提示，保持用户当前的展开状态。旋转进度图标与展开箭头遵循减少动态效果偏好。

展开后，搜索词、编号来源和分阶段 Token 放在同一个可聚焦的详情区，桌面最高 `min(360px, 45dvh)`，手机最高 `min(300px, 40dvh)`；详情区内部纵向滚动并限制滚动传递，状态条始终留在滚动区外。来源标题与摘要以纯文本呈现，外链使用安全 HTTP(S) URL、noopener noreferrer。状态独立使用明暗绿色 / 红色并保留文字。最终回答继续用原有安全 Markdown 管线，回复旁 Token 表示回答模型的全部请求，拓展消耗在详情和统计中查看。总耗时包含拓展处理。

新增能力 UI 必须检查明暗主题、四档字号、手机触控、焦点与长链接换行，不允许横向撑破聊天栏。

## 聊天 Skill 附件

回形针打开原生 Popover，包含「添加图片」与「Skill 库」；后者始终带「插件」标签。模型无图片能力时只禁用图片项，插件停用时禁用 Skill 库项并说明原因。菜单适应可视视口和软键盘，Escape 关闭并恢复触发按钮焦点。

选择器使用原生 Modal，可搜索名称/简介/标签、筛选标签、预览指令与参考文本并多选。输入栏标签显示名称、固定版本、本对话/仅本轮范围与移除按钮；选择随下一条消息提交，不覆盖编辑器正文。已有版本落后时，选择器提供显式「更新到 vN」。管理页保持原有 Color Pattern 卡片；聊天技能标签和加载详情使用中性表面与语义字号。

`SkillDetails` 折叠显示实际读取记录与每次模型请求状态/用量，限制内部高度和滚动。文档预览沿用安全 Markdown 管线，参考文件以纯文本展示。编辑器新增参考文件路径和正文表单；保存产生新版本，版本冲突保留草稿并提示重新打开。

## 上下文抽屉与交接

每轮助手回复的「上下文」入口打开 `features/context-manager/drawer.tsx` 的 `ContextDrawer`；仅在插件启用时展示。它使用公共 `Modal` 的原生 dialog 与可选 `className`，局部 CSS 将其定位为右侧抽屉，不新建全局弹层系统。保留 Escape、外侧关闭和焦点返回，抽屉内部滚动；手机按视口排列历史与详情，长正文、路径和链接不得撑破宽度。关闭抽屉只释放查看订阅和正在生成的 hand-off，不停止聊天。

历史列表以提交记录形式展示节点、简短 ID、提问、模型、时间、状态和修订关系；配置轨迹摘要后使用模型标题并显示用户意图，详情分别展示标题、意图和回答摘要，原文继续可查看；选中项使用 `aria-current`。带记忆元数据的新快照展示 System prompt、长期记忆、分组记忆、Session 记忆、当前 prompt 五部分；旧快照兼容原四部分，各自统计 UTF-16 字符数、UTF-8 文本字节数和图片数量。未注入的分区显示为空；请求数为 0 表示尚未发送，其他轮次展示最近一次回答模型请求的组成。原始输入与工具内容作为纯文本查看，不执行其 HTML；图片只列名称和文件大小。「本轮回复」折叠展示安全 Markdown，便于回看已被修订的回复。供应商 Token 单独显示，缺失保留「未上报」，不从字符统计换算。

`character-composition.tsx` 在分区正文前展示「上下文字符分布」。`character-grid.ts` 按各分类字符数向上取整分配整格，默认每格最多 64 字符，按 System、长期记忆、分组记忆、Session、当前 prompt 的顺序从左到右、逐行填充；不同分类不共用方格，未填格保留灰色。全图固定 224 格，桌面 32 列 × 7 行，手机 16 列 × 14 行；如果各部分所需格数之和超出 224，每格字符数从 64 逐次翻倍直到全部容纳，不截断数据。图下必须显示实际刻度及末格取整口径。灰格只是展示留白，不代表模型上下文容量或缓存统计；整格取整后的面积用于概览，精确数量以图例为准。

各个分区通过 `usePatternColors()` 和稳定标识配色。图例用紧凑横排的色块、分类名和字符数呈现，空间不足自然换行，手机触控目标至少 44px。空分区保留 0，没有文本时全图为灰色。图例支持鼠标悬停、键盘聚焦、点击固定高亮，按钮使用 `aria-pressed`；可访问名称保留精确数量、比例及未注入 / 暂无历史等说明，方格不单独进入 Tab 顺序。

图表直接复用所选快照的字符统计，切换轮次时随详情一起更新，不增加独立计算或加载流程。范围说明明确包含空格、换行，图片不计入；UTF-16 计量与详情保持一致，只比较当前快照的文本组成，不换算为 Token。计算边界以 [context-manager 接口](FEATURES.md#对话-context-manager) 为准。

Hand-off 位于所选快照详情，模型列表沿用当前账户可用的 LLM，默认偏好来自插件设置。正在生成的聊天轮次不能生成交接；主动点击才调用模型，忙碌和失败状态明确显示。结果通过安全 `Markdown` 展示，复制使用公共 `copyText`，下载使用 Markdown 文件；两者均复用已有结果，不再次调用模型。结果仅保留在当前抽屉，切换轮次或关闭后不保存为服务器文档。设置、请求与迟到响应按账户隔离。

样式位于 `context-manager.css` 与 `character-composition.css`，统一使用 `context-manager-*` 命名空间、灰度表面和语义字号；图表装饰色来自 Color Pattern，完成 / 失败沿用独立绿色 / 红色并保留文字，静态区域不新增阴影。验收针对抽屉的桌面 / 手机、明暗、长内容、关闭焦点、占比图例与轮次切换、复制 / 下载路径即可。

## 记忆管理与策略设置

工作区新增「记忆」入口，使用 feature registry 的 workspace placement，保留同一插件的 `settingsComponent`，不在 Shell 硬编码业务导航。`#/memory` 管理记忆，`#/memory/pending` 聚合待纳入草稿和长期候选；`#/settings/memory` 配置模型、写入与策略。页面提供三种作用域记忆、待确认候选、索引 / 操作状态，未配置 PostgreSQL 时说明未就绪原因。管理员在原模型管理接入 embedding 并授权；个人设置只选择可用的 embedding、检索 LLM、抽取 LLM，原模型停用或撤销授权时保留失效提示并要求重新选择。

策略下拉按 id / settingsKey / configVersion 匹配编译期客户端面板，缺少面板的策略显示原因且不能从设置启用。记忆设置使用紧凑分区；宽屏将基础设置与策略设置并排，窄屏堆叠。顶部聚合实际启用状态、开关、保存与错误；开关立即保存，等待期间显示保存状态，失败回退并保留错误。其他基础配置显式保存，Prompt 微调默认折叠；写入与保留按三个作用域聚合，策略内部设置另行保存；切换策略保留其已有配置。各策略必须提供专属设置 UI，处理 disabled、加载失败和版本冲突；统一配置容器负责 API 保存，面板不触发隐式模型调用。default 面板提供候选 / 相似度 / 近期窗口、三个作用域额度、总条数 / 字节 / 超时 / 降级，以及可恢复默认的检索与抽取 Prompt。

记忆工作区以紧凑工具栏聚合作用域、状态、分组和正文 / 标签检索，列表展示范围、分类、状态、时间和来源入口；提供新增、编辑、置顶、删除与长期纳入 / 撤出。管理文本检索包含待纳入条目，不冒充向量召回。工作区「策略设置」标签与个人设置页复用同一 `MemorySettings` 面板和持久化偏好，不能另建一套策略配置。

长期 pending 显示「待纳入」，明确说明不会参与其他对话；只有用户点击「纳入长期」或批准长期候选才生效，并显示 admittedAt。旧 active 的 null 时间显示历史纳入时间未记录，不能用 createdAt 或本次升级时间代替。修改长期正文后明确提示重新待纳入；撤出保留内容并停止召回。轻量聊天候选预览的长期按钮引导到管理页，不在回复旁进行含糊的「确认」纳入；完整管理页批准按钮明确写出长期纳入行为。

已完成助手回复的工具栏提供 Remember it，沿用聊天已有操作与手机触控布局。点击后先显示生成状态，再在原生 Modal 内展示可编辑摘要、当前回复的原文证据和分组 / 长期选择；未分组时禁用分组选项并说明原因。保存长期明确写出「保存为待纳入」，分组写出「保存到分组」，不把预览成功当作写入成功。错误留在弹窗内，可重新生成；关闭恢复焦点，取消不保存记忆。来源查看同样使用 Modal，显示本人证据和原对话入口，来源变更 / 不可访问保留文字状态且不显示修改后的正文。

Remember it 弹窗在桌面最大宽度为 880px，窄屏保留两侧各 16px 的空间，摘要与证据仍按顺序纵向展示。宽度由局部 `.modal.memory-remember` 样式控制，避免被后导入的通用 Modal 宽度覆盖；不修改其他弹窗的尺寸。

来源入口通过 `#/chat/:conversationId/:messageId` 直接定位原消息；对话加载后复用 `useChatNavigation().jumpTo`，并给目标消息显示「来源消息」文字标识，不新增滚动控制器或以 Shell 装饰色代替来源说明。

记忆编辑复用原生 Modal，展示范围、分类、正文、标签、到期与置顶；候选确认 / 拒绝提供明确文字。索引面板显示当前空间模型、维度、状态和数量，重建属于显式操作，不能把保存模型选择描述为索引已完成。操作记录与 context 快照区分准备结果和实际注入；抽取发生在回答之后，不计入本轮字符图。记忆块可查看 ID、版本、范围和理由；删除或撤出后的快照正文清理为不可用状态。

局部样式使用 `memory-*` 命名空间和公共 token、语义字号，正文长内容自动换行，列表在窄屏堆叠；静态区域不加阴影。成功 / 失败保留文字与独立语义色，键盘焦点、明暗、手机触控和大字号遵循现有组件规范。

上下文设置将自动压缩、轨迹摘要与交接模型聚合为紧凑分区，统一显示未保存 / 保存结果与错误。自动功能默认关闭，模型选择与数值字段保持标签和字符计量说明。抽屉显示压缩前后数量、实际摘要与辅助模型信息，轨迹摘要 pending 自动刷新，失败可显式重试；交互契约见 [上下文管理](CONTEXT_MANAGER.md)。

## 产物空间

`llm-production` 在工作区注册「产物空间」统一管理入口，并通过 settingsComponent 提供生成开关、3–7 天临时保留、图片模型和实际存储用量。聊天通过 ClientFeature.topbarComponent 在固定顶栏右侧提供当前空间入口；Shell 只渲染注册组件，不硬编码业务导航。未建立聊天时按钮禁用并说明原因。

产物管理首页使用「标题与搜索 / 类型筛选 / 排序 → 分组空间 → 对话卡片」布局，保留 Shell 侧栏。有产物的对话各显示一张卡片，封面使用 lucide 文件类型图标（图片、网页 / 代码、文档、表格、演示或混合文件），不读取文件缩略图；下方仅显示对话名、产物数和最近生成日期。卡片支持网格 / 列表切换；搜索同时匹配对话名与文件名，类型筛选匹配包含该类型产物的对话。分组入口使用原分组 ID / colorSlot，卡片使用稳定对话 ID，经 `usePatternColors()` 分配背景、边框与图标色；正文保持灰度，静态卡片无阴影。宽屏通常四列，窄屏自适应，手机单列；长名称截断并保留 title，大字号不撑破视口。

点击卡片在同页管理该来源对话的全部产物，提供返回、打开对话和预览 / 下载 / 确认删除。分组对话默认只筛选自身来源，可进入「查看分组全部产物」；选中分组后也可直接「管理分组产物」，不改变服务器的分组共享契约。返回保留筛选并恢复卡片焦点。已删除来源的保留文件仍有管理入口，按所在分组归集。产物抽屉复用原生 Modal，支持 Escape、外侧关闭和焦点恢复；聊天抽屉继续展示整个共享空间。分组明确显示共享与默认不过期，临时文件显示到期时间。文件列表可搜索名称，展示类型 / 大小 / 时间、预览、下载与确认删除。消息卡片使用同一下载方式；下载只访问私有鉴权接口，不隐式调用模型。

聊天中的 PNG / JPEG / WebP 产物直接显示可点击的缩略图，其他文件保留紧凑卡片。消息卡片、产物抽屉与管理页共用 `ProductionPreview` 原生 Modal：图片按比例放大，Markdown 沿用安全 `Markdown`，其他文本展示可滚动源码，长内容明确提示预览截断；PDF / Office 等暂不支持排版预览的文件说明可下载。原始 HTML / SVG 不执行，预览不加载外部资源。窗口提供文件信息和原下载入口，支持加载、失败重试、Escape 与焦点返回；窄屏及大字号内容不撑破视口。读取通过私有 `/content` 接口并检查响应类型，关闭、切换账户及删除时取消读取并释放 object URL。

聊天[加号菜单](#聊天输入)中使用原生「产物输出」选择器，默认「自动」，由主聊天模型判断是否调用产物工具；「必须产物」先建立结构化交付清单并逐项检查，需求不足时可以先澄清。选择按当前账户和聊天隔离，只保留在当前页面的草稿状态，不设置新的账户默认偏好。生成中禁用控件；未启用工具调用的模型不能选择「必须产物」，保留文字说明；已有必须模式切换到不支持的模型后禁用发送，用户可以改为自动或选择其他模型。最后一问编辑载入原消息的模式，取消编辑恢复原草稿模式，失败回复重试沿用原提问模式。

助手消息的交付计划用原生 details / summary 展示，默认折叠并显示完成项数 / 总数；展开清单显示名称、类型、需求说明和待生成 / 已生成 / 失败 / 停止状态，失败与完成采用独立红绿语义色并保留文字。澄清问题直接以纯文本展示，模型产生的名称、内容和错误均不执行 HTML。简单未声明计划的生成继续展示原下载卡片；部分失败保留已成功生成的下载入口。清单内部限制高度并可键盘聚焦滚动，SSE 增量更新产物和清单，重连 snapshot 替换当前状态，切换账户或聊天忽略迟到事件。

设置保存、失败、无可用图片模型和存储上限均有文字反馈；关闭生成不影响已有文件管理。账户 / 对话切换忽略旧请求。局部 CSS 使用 llm-production-* 与语义 token；桌面、手机、明暗、大字号不发生横向溢出。空间生命周期见 [产物契约](LLM_PRODUCTION.md)。
