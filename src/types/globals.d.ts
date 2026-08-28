/**
 * 全局声明
 */

// Vite 静态资源导入
declare module '*.scss' {
  const content: string;
  export default content;
}

declare module '*.css' {
  const content: string;
  export default content;
}

// Toast 全局工具
declare const Toast: {
  show(message: string, duration?: number): void;
};

// pywebview 窗口控制桥（无边框自绘标题栏；由后端 InfiniteCanvasAPI 提供）
// 顶栏拖动（B1）：自实现拖动调 win_move_relative(dx,dy) 相对移动（CSS px，后端按 DPI 换算物理像素）；
// 最大化状态下前端锁定 + 后端拒绝。不再使用 pywebview 官方 drag-region。
// win_toggle_maximize / win_is_maximized 返回 {maximized}（兼容可能被包一层 result，见共享知识 5）
interface Window {
  pywebview: {
    api: {
      win_minimize(): Promise<void>;
      win_toggle_maximize(): Promise<{ maximized?: boolean; result?: { maximized?: boolean } }>;
      win_is_maximized(): Promise<{ maximized?: boolean; result?: { maximized?: boolean } }>;
      win_move_relative(dx: number, dy: number): Promise<{ ok?: boolean }>;
      win_close(): Promise<void>;
    };
  };
}
