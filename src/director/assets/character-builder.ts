// src/director/assets/character-builder.ts
// 原创占位人物白模：由基础几何体（球/圆柱/盒）程序化拼装的人形。
// 不含任何参考项目角色资产/骨骼/动作文件；骨骼为简单 Object3D 关节层级，
// 支持「最小可用 IK（四肢末端优先）」。

import * as THREE from 'three';

export interface CharacterBuild {
  group: THREE.Group;
  /** 关节表：键 = 关节名（pose 持久化使用同一命名） */
  joints: Map<string, THREE.Object3D>;
  /** IK 末端目标（世界小球）：handL/handR/footL/footR */
  ikTargets: Map<string, THREE.Object3D>;
}

export const JOINT_NAMES = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'forearmL', 'handL',
  'shoulderR', 'upperArmR', 'forearmR', 'handR',
  'hipL', 'thighL', 'calfL', 'footL',
  'hipR', 'thighR', 'calfR', 'footR',
] as const;

const ARM_LEN = 0.34;
const FOREARM_LEN = 0.3;
const HAND_LEN = 0.12;
const THIGH_LEN = 0.42;
const CALF_LEN = 0.4;
const FOOT_H = 0.12;

/** 新建一个关节节点（空 Object3D，作为旋转中心） */
function joint(name: string): THREE.Object3D {
  const j = new THREE.Object3D();
  j.name = name;
  j.userData.jointName = name;
  return j;
}

/** 在父关节下挂一段白模肢体（从父关节沿 -Y 延伸到子关节） */
function limbMesh(
  parent: THREE.Object3D,
  length: number,
  radius: number,
  color: THREE.Color,
): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radius, radius, length, 12);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -length / 2;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function sphereMesh(parent: THREE.Object3D, radius: number, color: THREE.Color, y = 0): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.02 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), mat);
  mesh.position.y = y;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * 构建原创占位人物白模。
 * 层级：
 *   root
 *    └ pelvis
 *       ├ spine ─ chest ─ neck ─ head
 *       │         ├ shoulderL ─ upperArmL(肘) ─ forearmL(腕) ─ handL
 *       │         └ shoulderR ─ upperArmR(肘) ─ forearmR(腕) ─ handR
 *       ├ hipL ─ thighL(膝) ─ calfL(踝) ─ footL
 *       └ hipR ─ thighR(膝) ─ calfR(踝) ─ footR
 * 四肢静止时沿 -Y（下垂）；T-Pose 等预设由 character.ts 施加关节旋转。
 */
export function buildCharacterMesh(colorHex = '#e6e2d8'): CharacterBuild {
  const color = new THREE.Color(colorHex);
  const group = new THREE.Group();
  const joints = new Map<string, THREE.Object3D>();
  const ikTargets = new Map<string, THREE.Object3D>();

  const pelvis = joint('pelvis');
  const spine = joint('spine');
  const chest = joint('chest');
  const neck = joint('neck');
  const head = joint('head');

  // 躯干
  const pelvisMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.2, 0.22),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02 }),
  );
  pelvisMesh.castShadow = true;
  pelvis.add(pelvisMesh);

  const chestMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.46, 0.26),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02 }),
  );
  chestMesh.position.y = 0.33;
  chestMesh.castShadow = true;
  chest.add(chestMesh);

  sphereMesh(head, 0.15, color, 0.16);

  spine.position.y = 0.18;
  chest.position.y = 0.3;
  neck.position.y = 0.48;
  head.position.y = 0.16;

  // 手臂
  const shoulderL = joint('shoulderL');
  const upperArmL = joint('upperArmL');   // 肘
  const forearmL = joint('forearmL');     // 腕
  const handL = joint('handL');
  shoulderL.position.set(-0.26, 0.42, 0);
  upperArmL.position.y = -ARM_LEN;
  forearmL.position.y = -FOREARM_LEN;
  handL.position.y = -HAND_LEN;
  limbMesh(shoulderL, ARM_LEN, 0.055, color);       // 上臂：肩→肘
  limbMesh(upperArmL, FOREARM_LEN, 0.045, color);   // 前臂：肘→腕
  sphereMesh(forearmL, 0.05, color, -HAND_LEN / 2); // 手

  const shoulderR = joint('shoulderR');
  const upperArmR = joint('upperArmR');
  const forearmR = joint('forearmR');
  const handR = joint('handR');
  shoulderR.position.set(0.26, 0.42, 0);
  upperArmR.position.y = -ARM_LEN;
  forearmR.position.y = -FOREARM_LEN;
  handR.position.y = -HAND_LEN;
  limbMesh(shoulderR, ARM_LEN, 0.055, color);
  limbMesh(upperArmR, FOREARM_LEN, 0.045, color);
  sphereMesh(forearmR, 0.05, color, -HAND_LEN / 2);

  // 腿
  const hipL = joint('hipL');
  const thighL = joint('thighL');   // 膝
  const calfL = joint('calfL');     // 踝
  const footL = joint('footL');
  hipL.position.set(-0.11, 0.02, 0);
  thighL.position.y = -THIGH_LEN;
  calfL.position.y = -CALF_LEN;
  footL.position.y = -FOOT_H;
  limbMesh(hipL, THIGH_LEN, 0.07, color);      // 大腿：髋→膝
  limbMesh(thighL, CALF_LEN, 0.055, color);    // 小腿：膝→踝
  const footMeshL = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.05, 0.16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02 }),
  );
  footMeshL.position.set(0, -FOOT_H / 2, 0.06);
  footL.add(footMeshL);

  const hipR = joint('hipR');
  const thighR = joint('thighR');
  const calfR = joint('calfR');
  const footR = joint('footR');
  hipR.position.set(0.11, 0.02, 0);
  thighR.position.y = -THIGH_LEN;
  calfR.position.y = -CALF_LEN;
  footR.position.y = -FOOT_H;
  limbMesh(hipR, THIGH_LEN, 0.07, color);
  limbMesh(thighR, CALF_LEN, 0.055, color);
  const footMeshR = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.05, 0.16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02 }),
  );
  footMeshR.position.set(0, -FOOT_H / 2, 0.06);
  footR.add(footMeshR);

  // 组装层级
  chest.add(neck, shoulderL, shoulderR);
  spine.add(chest);
  pelvis.add(spine, hipL, hipR);
  shoulderL.add(upperArmL);
  upperArmL.add(forearmL);
  forearmL.add(handL);
  shoulderR.add(upperArmR);
  upperArmR.add(forearmR);
  forearmR.add(handR);
  hipL.add(thighL);
  thighL.add(calfL);
  calfL.add(footL);
  hipR.add(thighR);
  thighR.add(calfR);
  calfR.add(footR);
  group.add(pelvis);

  // 注册关节表
  for (const name of JOINT_NAMES) {
    const found = group.getObjectByName(name);
    if (found) joints.set(name, found);
  }

  // IK 末端目标小球（世界空间，IK 模式拖拽用）
  const makeTarget = (name: string, worldPos: THREE.Vector3): THREE.Object3D => {
    const t = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    t.name = `ik-${name}`;
    t.userData.ikTarget = name;
    t.position.copy(worldPos);
    group.add(t);
    return t;
  };

  const handLWorld = handL.getWorldPosition(new THREE.Vector3());
  const handRWorld = handR.getWorldPosition(new THREE.Vector3());
  const footLWorld = footL.getWorldPosition(new THREE.Vector3());
  const footRWorld = footR.getWorldPosition(new THREE.Vector3());
  ikTargets.set('handL', makeTarget('handL', handLWorld));
  ikTargets.set('handR', makeTarget('handR', handRWorld));
  ikTargets.set('footL', makeTarget('footL', footLWorld));
  ikTargets.set('footR', makeTarget('footR', footRWorld));

  // 默认 T-Pose（肩外展），保证新建人物可见
  const shoulderLJ = joints.get('shoulderL');
  const shoulderRJ = joints.get('shoulderR');
  if (shoulderLJ) shoulderLJ.rotation.z = THREE.MathUtils.degToRad(90);
  if (shoulderRJ) shoulderRJ.rotation.z = THREE.MathUtils.degToRad(-90);

  return { group, joints, ikTargets };
}

/**
 * 最小可用两骨骼 IK（四肢末端优先）：把 base→mid→end 三段链指向 worldTarget。
 * 通过解析几何（余弦定理）解出 mid 处弯曲角，再用四元数把链对准目标方向。
 * @param base 根部关节（如 shoulderL）
 * @param mid  中间关节（如 upperArmL/肘）
 * @param end  末端关节（如 forearmL/腕）
 * @param target 世界坐标目标
 * @param bendAxisLocal mid 关节局部弯曲轴（手臂/腿默认绕局部 Z 前弯）
 */
export function solveTwoBoneIK(
  base: THREE.Object3D,
  mid: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  bendAxisLocal = new THREE.Vector3(0, 0, 1),
): void {
  const l1 = mid.position.length();
  const l2 = end.position.length();
  if (l1 < 1e-4 || l2 < 1e-4) return;

  const baseWorld = base.getWorldPosition(new THREE.Vector3());
  const dist = target.distanceTo(baseWorld);
  const d = Math.min(dist, l1 + l2 - 1e-3);

  // 1) 把 base 对准目标方向（在 base 局部坐标系求旋转）
  const dirWorld = target.clone().sub(baseWorld).normalize();
  const basePos = base.getWorldPosition(new THREE.Vector3());
  const dirInBaseLocal = base.worldToLocal(dirWorld.clone().add(basePos)).sub(base.position).normalize();
  const restDir = mid.position.clone().normalize();
  const qAim = new THREE.Quaternion().setFromUnitVectors(restDir, dirInBaseLocal);
  base.quaternion.copy(qAim);

  // 2) mid 处弯曲角（余弦定理）
  const cosBeta = (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2);
  const beta = Math.acos(Math.min(1, Math.max(-1, cosBeta)));
  const bendAxis = bendAxisLocal.clone().normalize();
  mid.quaternion.setFromAxisAngle(bendAxis, beta);
}

/** 更新 IK 目标球位置（IK 模式拖拽后同步到末端关节当前位置） */
export function updateIkTargetPositions(ikTargets: Map<string, THREE.Object3D>, joints: Map<string, THREE.Object3D>): void {
  const map: Array<[string, string]> = [
    ['handL', 'forearmL'], ['handR', 'forearmR'], ['footL', 'calfL'], ['footR', 'calfR'],
  ];
  for (const [targetName, jointName] of map) {
    const target = ikTargets.get(targetName);
    const j = joints.get(jointName);
    if (target && j) {
      target.position.copy(j.getWorldPosition(new THREE.Vector3()));
    }
  }
}
