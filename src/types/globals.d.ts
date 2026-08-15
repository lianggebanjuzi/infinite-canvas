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
// 窗口拖动不再走用户 js_api：由 pywebview 官方 drag-region 机制（pywebviewMoveWindow 内部桥接）接管
interface Window {
  pywebview: {
    api: {
      win_minimize(): Promise<void>;
      win_toggle_maximize(): Promise<void>;
      win_close(): Promise<void>;
    };
  };
}
