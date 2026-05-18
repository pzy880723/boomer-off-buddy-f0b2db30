## 替换登录页 logo

1. 把上传的白色 logo 复制到 `src/assets/logo-boomeroff-white.png`
2. 修改 `src/routes/login.tsx`：
   - 顶部 import 换成新的白色 logo
   - 左侧品牌栏的 `<img>` 去掉 `brightness-0 invert opacity-90`（新图本身就是白色透明底），保留 `h-20 w-auto`，可加 `opacity-95` 让它更柔和一些
   - 右侧移动端顶部小 logo 保持用原彩色 logo（在白底上更清晰），不改

不动其他文件、不改业务逻辑。