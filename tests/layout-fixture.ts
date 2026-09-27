export const layoutConversation = (device: string) =>
  device === 'desktop'
    ? '00000000-0000-4000-8000-000000000101'
    : '00000000-0000-4000-8000-000000000102';
export const layoutReply =
  '## 保持清晰的阅读层级\n\n这是长对话的正文段落，用来检查大字号、换行与滚动定位。我们可以向上阅读，再回到最新一条。\n\n| 项目 | 说明 |\n| --- | --- |\n| 字体大小 | 每个档位保持文字层级，内容自然换行。 |\n| 较长标识 | a_very_long_identifier_that_should_stay_inside_its_scrollable_table |\n\n```typescript\nconst veryLongMessage = "代码保持等宽字体，并在自己的容器内横向滚动，不撑开页面";\n```\n\n公式：$E=mc^2$\n\n$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$\n\n这里是这条回复的最后一段。';
