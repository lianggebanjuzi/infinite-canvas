// src/director/engine/transform.ts
// 导演台变换工具函数：吸附、贴地、数值规整。

import { Vec3, vec3, vec3Equals } from '../types';

/** 按步长吸附数值（四舍五入到最近步长倍数） */
export function snapValue(value: number, step: number): number {
  if (!step || step <= 0 || !Number.isFinite(step)) return value;
  return Math.round(value / step) * step;
}

/** 向量吸附 */
export function snapVec3(v: Vec3, step: number): Vec3 {
  if (!step || step <= 0) return { ...v };
  return vec3(snapValue(v.x, step), snapValue(v.y, step), snapValue(v.z, step));
}

/** 贴地：返回 y=0（保留 x/z） */
export function groundVec3(v: Vec3, groundY = 0): Vec3 {
  return vec3(v.x, groundY, v.z);
}

/** 把欧拉角（度）规整到 [-180, 180] */
export function normalizeDegrees(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** 判断一个值是否是可用的有限数 */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 安全除法（避免 0 除数） */
export function safeDivide(a: number, b: number, fallback = 0): number {
  if (!Number.isFinite(b) || b === 0) return fallback;
  return a / b;
}

/** 深比较两个向量是否相同（用于判断是否有实际变化） */
export function sameVec(a: Vec3 | undefined, b: Vec3 | undefined): boolean {
  if (!a || !b) return a === b;
  return vec3Equals(a, b);
}
