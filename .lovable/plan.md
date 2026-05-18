## 替换侧边栏 Logo + 收起态只显示 "B"

### 改动

1. **新增 Logo 资源**
   - 把 `user-uploads://boomeroff_logo_group_left_画板_1-2.png` 拷贝到 `src/assets/logo-boomeroff-wide.png`（横版完整 logo，含文字）
   - 旧的 `src/assets/logo-boomeroff.png` 保留不动（用于登录页等其它位置）

2. **`src/components/app-sidebar.tsx` — `SidebarHeader` 区域**
   - 展开态（`!collapsed`）：直接渲染新的横版 logo 图片，占满 header 宽度，移除右侧那段 `BOOMER·OFF / vintage group` 文字块（图本身已经包含这些字）
   - 收起态（`collapsed`）：渲染一个方形容器，里面只显示一个大写 **"B"**（用与品牌一致的字重和颜色，例如白底/深色 `B`，或深底白字 `B`，跟 sidebar 主题协调）
   - 整体仍然包在 `<Link to="/dashboard">` 里，hover/preload 行为保持不变

### 不动的部分

- 不改登录页、不改 favicon
- 不改账号管理功能或其它菜单项
- 不调整 sidebar 宽度变量

### 视觉确认

实施后让你在展开和收起两种状态各看一眼，确认 logo 比例和 "B" 的样式 OK。
