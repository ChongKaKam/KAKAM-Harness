export const syntaxConversation = '00000000-0000-4000-8000-000000000103';
export const syntaxCode = `# Count reachable cells
def dfs_grid(grid, r, c):
    rows = len(grid)
    visited = set()
    if r < 0 or r >= rows or grid[r][c] == "0":
        return False
    visited.add((r, c))
    return visited`;
export const syntaxReply = `## 网格 DFS\n\n同一段代码在明暗主题中保留完整语义高亮。\n\n\`\`\`python\n${syntaxCode}\n\`\`\``;
