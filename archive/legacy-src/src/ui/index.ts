/**
 * UI 组件库入口
 * 
 * 用法：
 *   import { Dialog, FormInput, FormSwitch, ListItem, Button, Toast } from '@/ui';
 *   
 *   // 创建弹窗
 *   Dialog({ title: '提示', content: '确定吗？' });
 *   
 *   // 创建表单
 *   const nameInput = FormInput({ label: '名称', placeholder: '请输入' });
 *   const enableSwitch = FormSwitch({ label: '启用', value: true });
 *   
 *   // 创建列表项
 *   const item = ListItem({ icon: 'fa-solid fa-server', title: '供应商' });
 *   
 *   // 创建按钮
 *   const btn = Button({ text: '保存', type: 'primary' });
 *   
 *   // 显示提示
 *   Toast.success('保存成功');
 */

// 组件导出
export { Dialog } from './dialog';
export type { DialogOptions, DialogInstance } from './dialog';

export { FormInput } from './form-input';
export type { FormInputOptions, FormInputInstance } from './form-input';

export { FormSwitch } from './form-switch';
export type { FormSwitchOptions, FormSwitchInstance } from './form-switch';

export { Select } from './select';
export type { SelectOptions, SelectOption, SelectGroup, SelectInstance } from './select';

export { Textarea } from './textarea';
export type { TextareaOptions, TextareaInstance } from './textarea';

export { ListItem } from './list-item';
export type { ListItemOptions, ListItemInstance, ListItemBadge, ListItemAction } from './list-item';

export { Button } from './button';
export type { ButtonOptions, ButtonInstance } from './button';

export { Toast } from './toast';
export type { ToastType, ToastOptions } from './toast';
