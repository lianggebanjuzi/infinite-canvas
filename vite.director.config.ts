// vite.director.config.ts
// 导演台独立构建配置：与主应用（vite.config.ts）完全分离，互不干扰。
// 产物输出到 gui/dist/director.html + gui/dist/assets/director-*.js，
// 供 main.py 打开独立 pywebview 窗口（file:// 加载，使用相对路径 + 普通 script，避开 module MIME 问题）。

import { defineConfig } from 'vite';
import { resolve } from 'path';
import type { Plugin } from 'vite';

// 与主配置一致的插件：移除 type="module"，改为普通 script 并移到 </body> 前
// （pywebview 的 Bottle 服务器不给 .js 设置正确的 module MIME 类型）
function removeModuleAttribute(): Plugin {
  return {
    name: 'remove-module-attribute-director',
    transformIndexHtml(html) {
      const scriptMatch = html.match(/<script\s+type="module"\s+crossorigin\s+src="([^"]+)"><\/script>/);
      if (!scriptMatch) return html;
      const scriptTag = `<script src="${scriptMatch[1]}"></script>`;
      let result = html.replace(/<script\s+type="module"\s+crossorigin\s+src="[^"]+"><\/script>\s*\n?/, '');
      result = result.replace('</body>', `  ${scriptTag}\n</body>`);
      return result;
    },
  };
}

export default defineConfig({
  base: './',
  root: 'src/director',
  plugins: [removeModuleAttribute()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: '../../gui/dist',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/director/director.html'),
      output: {
        format: 'iife',
        entryFileNames: 'assets/director-[name].js',
        chunkFileNames: 'assets/director-[name].js',
        assetFileNames: 'assets/director-[name].[ext]',
      },
    },
    sourcemap: false,
    minify: false,
  },
  server: {
    port: 5174,
    strictPort: true,
    open: false,
  },
});
