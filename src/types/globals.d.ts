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
