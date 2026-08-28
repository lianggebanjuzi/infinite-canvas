import { defineConfig } from 'vite';
import { resolve } from 'path';
import type { Plugin } from 'vite';

// 自定义插件：移除 <script type="module">，改为普通 <script>，并移到 </body> 前
// 原因：pywebview 的 Bottle 服务器不给 .js 设置正确的 module MIME 类型
function removeModuleAttribute(): Plugin {
  return {
    name: 'remove-module-attribute',
    transformIndexHtml(html) {
      // 提取 script 标签（去掉 type="module" crossorigin）
      const scriptMatch = html.match(/<script\s+type="module"\s+crossorigin\s+src="([^"]+)"><\/script>/);
      if (!scriptMatch) return html;
      const scriptTag = `<script src="${scriptMatch[1]}"></script>`;
      // 从原位置删除
      let result = html.replace(/<script\s+type="module"\s+crossorigin\s+src="[^"]+"><\/script>\s*\n?/, '');
      // 插入到 </body> 之前
      result = result.replace('</body>', `  ${scriptTag}\n</body>`);
      return result;
    },
  };
}

export default defineConfig({
  // 关键：pywebview 用 file:// 加载构建产物，必须相对路径
  base: './',

  // 以 src/ 为根目录，使输出路径为 gui/dist/index.html（而非 gui/dist/src/index.html）
  root: 'src',

  plugins: [removeModuleAttribute()],

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },

  build: {
    outDir: '../gui/dist',
    emptyOutDir: false,
    // 单入口，不拆分 chunk，简化 pywebview 加载
    rollupOptions: {
      input: resolve(__dirname, 'src/index.html'),
      // IIFE：把 bundle 顶层变量封闭进函数作用域，与 window 全局完全隔离，
      // 根治「顶层 var 撞 window 内置属性（history/name/status/top/location 等）静默失败」类问题
      output: {
        format: 'iife',
      },
    },
    // 生产环境 sourcemap（调试用，发布时关闭）
    sourcemap: false,
    // 不压缩（terser/esbuild 为可选依赖，开发阶段跳过）
    minify: false,
  },

  server: {
    port: 5173,
    strictPort: true,
    open: false,  // pywebview 控制窗口加载
  },

  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
});
