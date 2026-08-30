// src/director/engine/character.ts
// 导演台人物管理：原创占位白模（character-builder）、动作预设、姿态存储、最小可用 IK。
// 人物对象在 scene 中 kind==='character'；本模块负责姿势预设/存储/IK 求解。
// 无人物对象时 UI 降级（不报错）：characterManager.hasCharacter() 返回 false。

import * as THREE from 'three';
import { DirectorCharacterState, vec3 } from '../types';
import { sceneManager } from './scene';
import { solveTwoBoneIK, updateIkTargetPositions } from '../assets/character-builder';

export type PosePresetName = 'tpose' | 'apose' | 'idle' | 'walk' | 'wave' | 'sit';

export interface PosePreset {
  name: PosePresetName;
  label: string;
  /** 关节本地欧拉角（度）；未列出的关节保持当前值 */
  joints: Partial<Record<string, Vec3Like>>;
}

interface Vec3Like { x: number; y: number; z: number; }

/**
 * 原创动作预设（仅白模占位用途；不复制任何参考项目的动作文件）。
 * 关节命名见 character-builder：shoulder/upperArm(肘)/forearm(腕)/hip/thigh(膝)/calf(踝)。
 */
export const POSE_PRESETS: PosePreset[] = [
  {
    name: 'tpose', label: 'T-Pose',
    joints: {
      shoulderL: { x: 0, y: 0, z: 90 }, shoulderR: { x: 0, y: 0, z: -90 },
      upperArmL: { x: 0, y: 0, z: 0 }, upperArmR: { x: 0, y: 0, z: 0 },
    },
  },
  {
    name: 'apose', label: 'A-Pose',
    joints: {
      shoulderL: { x: 0, y: 0, z: 45 }, shoulderR: { x: 0, y: 0, z: -45 },
      upperArmL: { x: 0, y: 0, z: 0 }, upperArmR: { x: 0, y: 0, z: 0 },
    },
  },
  {
    name: 'idle', label: '站立',
    joints: {
      shoulderL: { x: 0, y: 0, z: 8 }, shoulderR: { x: 0, y: 0, z: -8 },
      upperArmL: { x: 0, y: 0, z: 12 }, upperArmR: { x: 0, y: 0, z: -12 },
    },
  },
  {
    name: 'walk', label: '行走',
    joints: {
      shoulderL: { x: 0, y: 0, z: 25 }, shoulderR: { x: 0, y: 0, z: -25 },
      upperArmL: { x: 0, y: 0, z: -18 }, upperArmR: { x: 0, y: 0, z: 18 },
      thighL: { x: 0, y: 0, z: 18 }, thighR: { x: 0, y: 0, z: -14 },
      calfL: { x: 0, y: 0, z: -24 }, calfR: { x: 0, y: 0, z: 0 },
    },
  },
  {
    name: 'wave', label: '挥手',
    joints: {
      shoulderL: { x: 0, y: 0, z: 90 }, shoulderR: { x: 0, y: 0, z: 150 },
      upperArmL: { x: 0, y: 0, z: 10 }, upperArmR: { x: 0, y: 0, z: -35 },
    },
  },
  {
    name: 'sit', label: '坐姿',
    joints: {
      shoulderL: { x: 0, y: 0, z: 18 }, shoulderR: { x: 0, y: 0, z: -18 },
      upperArmL: { x: 0, y: 0, z: 30 }, upperArmR: { x: 0, y: 0, z: -30 },
      thighL: { x: 0, y: 0, z: -70 }, thighR: { x: 0, y: 0, z: -70 },
      calfL: { x: 0, y: 0, z: 95 }, calfR: { x: 0, y: 0, z: 95 },
    },
  },
];

export function getPosePreset(name: string): PosePreset | undefined {
  return POSE_PRESETS.find(p => p.name === name);
}

export class CharacterManager {
  /** 当前 IK 模式是否开启 */
  ikMode = false;
  /** 正在拖拽的 IK 目标名 */
  draggingTarget: string | null = null;

  hasCharacter(): boolean {
    for (const handle of sceneManager.handles.values()) {
      if (handle.data.kind === 'character') return true;
    }
    return false;
  }

  /** 查找场景中的人物对象 id（取第一个） */
  firstCharacterId(): string | null {
    for (const [id, handle] of sceneManager.handles) {
      if (handle.data.kind === 'character') return id;
    }
    return null;
  }

  /** 应用姿势预设到人物对象 */
  applyPreset(objectId: string, presetName: string): boolean {
    const handle = sceneManager.getHandle(objectId);
    if (!handle || handle.data.kind !== 'character' || !handle.joints) return false;
    const preset = getPosePreset(presetName);
    if (!preset) return false;
    for (const [jointName, angles] of Object.entries(preset.joints)) {
      const joint = handle.joints.get(jointName);
      if (!joint || !angles) continue;
      joint.rotation.set(
        THREE.MathUtils.degToRad(angles.x),
        THREE.MathUtils.degToRad(angles.y),
        THREE.MathUtils.degToRad(angles.z),
      );
    }
    if (handle.data.character) {
      handle.data.character.poseName = presetName;
    }
    sceneManager.readCharacterPose(handle.data, handle.joints);
    return true;
  }

  /** 把当前关节姿态存入工程数据（保存姿势） */
  storePose(objectId: string): boolean {
    const handle = sceneManager.getHandle(objectId);
    if (!handle || handle.data.kind !== 'character' || !handle.joints) return false;
    sceneManager.readCharacterPose(handle.data, handle.joints);
    return true;
  }

  /** 应用已存储姿态（打开工程/撤销恢复/关键帧时调用） */
  applyStoredPose(objectId: string, state: DirectorCharacterState): boolean {
    const handle = sceneManager.getHandle(objectId);
    if (!handle || handle.data.kind !== 'character' || !handle.joints) return false;
    handle.data.character = {
      rootPosition: { ...state.rootPosition },
      rootRotation: { ...state.rootRotation },
      poseName: state.poseName || 'tpose',
      joints: {},
    };
    for (const [name, angles] of Object.entries(state.joints || {})) {
      handle.data.character.joints[name] = { ...angles };
      const joint = handle.joints.get(name);
      if (joint) {
        joint.rotation.set(
          THREE.MathUtils.degToRad(angles.x),
          THREE.MathUtils.degToRad(angles.y),
          THREE.MathUtils.degToRad(angles.z),
        );
      }
    }
    return true;
  }

  /** 应用姿势关键帧到人物 */
  applyPoseKeyframe(objectId: string, state: DirectorCharacterState): boolean {
    return this.applyStoredPose(objectId, state);
  }

  /** IK 模式：把末端目标拖拽求解到四肢 */
  solveIkForTarget(objectId: string, targetName: string): boolean {
    const handle = sceneManager.getHandle(objectId);
    if (!handle || handle.data.kind !== 'character' || !handle.joints || !handle.ikTargets) return false;
    const target = handle.ikTargets.get(targetName);
    if (!target) return false;
    const targetWorld = target.getWorldPosition(new THREE.Vector3());
    switch (targetName) {
      case 'handL':
        return this.solveArm(handle.joints, 'L', targetWorld);
      case 'handR':
        return this.solveArm(handle.joints, 'R', targetWorld);
      case 'footL':
        return this.solveLeg(handle.joints, 'L', targetWorld);
      case 'footR':
        return this.solveLeg(handle.joints, 'R', targetWorld);
      default:
        return false;
    }
  }

  private solveArm(joints: Map<string, THREE.Object3D>, side: 'L' | 'R', target: THREE.Vector3): boolean {
    const shoulder = joints.get(`shoulder${side}`);
    const elbow = joints.get(`upperArm${side}`);
    const wrist = joints.get(`forearm${side}`);
    if (!shoulder || !elbow || !wrist) return false;
    solveTwoBoneIK(shoulder, elbow, wrist, target);
    return true;
  }

  private solveLeg(joints: Map<string, THREE.Object3D>, side: 'L' | 'R', target: THREE.Vector3): boolean {
    const hip = joints.get(`hip${side}`);
    const knee = joints.get(`thigh${side}`);
    const ankle = joints.get(`calf${side}`);
    if (!hip || !knee || !ankle) return false;
    // 腿的弯曲轴与手臂相反（膝盖向后弯）；用 -Z 轴
    solveTwoBoneIK(hip, knee, ankle, target, new THREE.Vector3(0, 0, -1));
    return true;
  }

  /** 保存姿态后更新 IK 目标球位置 */
  syncIkTargets(objectId: string): void {
    const handle = sceneManager.getHandle(objectId);
    if (!handle || handle.data.kind !== 'character' || !handle.joints || !handle.ikTargets) return;
    updateIkTargetPositions(handle.ikTargets, handle.joints);
  }

  /** 从场景数据读取姿势（用于关键帧记录） */
  collectPose(objectId: string): DirectorCharacterState | null {
    const handle = sceneManager.getHandle(objectId);
    if (!handle || handle.data.kind !== 'character') return null;
    if (handle.joints) sceneManager.readCharacterPose(handle.data, handle.joints);
    return handle.data.character ? {
      rootPosition: vec3(handle.data.character.rootPosition.x, handle.data.character.rootPosition.y, handle.data.character.rootPosition.z),
      rootRotation: vec3(handle.data.character.rootRotation.x, handle.data.character.rootRotation.y, handle.data.character.rootRotation.z),
      poseName: handle.data.character.poseName,
      joints: handle.data.character.joints ? JSON.parse(JSON.stringify(handle.data.character.joints)) : {},
    } : null;
  }
}

export const characterManager = new CharacterManager();
