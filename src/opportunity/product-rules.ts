import type { ProductKey } from '../contracts/index.js';

export type ProductRule = Readonly<{
  product: ProductKey;
  displayName: string;
  positiveKeywords: readonly string[];
  engineeringMethods: readonly string[];
  competitorKeywords: readonly string[];
  blockerKeywords: readonly string[];
}>;

export const PRODUCT_RULES: readonly ProductRule[] = [
  {
    product: 'windchill', displayName: 'PTC Windchill',
    positiveKeywords: ['ptc windchill', 'windchill', 'plm'],
    engineeringMethods: ['bom', 'ebom', 'mbom', '变更管理', '配置管理', '产品生命周期', 'plm/erp'],
    competitorKeywords: ['teamcenter', 'enovia', 'ar・as innovator', 'aras innovator'],
    blockerKeywords: ['集团统一 plm', '长期许可锁定'],
  },
  {
    product: 'feigenbaum_qms', displayName: 'Feigenbaum QMS',
    positiveKeywords: ['feigenbaum qms', 'feigenbaum', 'qms', '质量管理系统'],
    engineeringMethods: ['capa', '质量追溯', '供应商质量', '质量审计', 'iatf 16949', 'as9100', 'iso 13485'],
    competitorKeywords: ['sap qm', 'mastercontrol', 'etq reliance', 'iqs qms'],
    blockerKeywords: ['集团统一 qms', '长期许可锁定'],
  },
  {
    product: 'creo', displayName: 'PTC Creo',
    positiveKeywords: ['ptc creo', 'creo', 'pro/e', 'proe'],
    engineeringMethods: ['参数化建模', '参数化机械设计', '复杂零部件', '工程变更'],
    competitorKeywords: ['siemens nx', 'ug nx', 'solid edge'],
    blockerKeywords: ['集团统一 cad', '长期许可锁定'],
  },
  {
    product: 'catia', displayName: 'Dassault Systèmes CATIA',
    positiveKeywords: ['dassault systèmes catia', 'catia', '3dexperience'],
    engineeringMethods: ['复杂曲面', '大型装配', '整车建模', '航空建模'],
    competitorKeywords: ['siemens nx', 'ug nx', 'solid edge'],
    blockerKeywords: ['集团统一 cad', '长期许可锁定'],
  },
  {
    product: 'abaqus', displayName: 'Dassault Systèmes Abaqus',
    positiveKeywords: ['dassault systèmes abaqus', 'abaqus'],
    engineeringMethods: ['有限元', '非线性分析', '碰撞仿真', '疲劳仿真', '材料仿真', '多物理场'],
    competitorKeywords: ['ansys', 'ls-dyna', 'nastran', 'comsol'],
    blockerKeywords: ['集团统一 cae', '长期许可锁定'],
  },
  {
    product: 'cst', displayName: 'CST Studio Suite',
    positiveKeywords: ['cst studio suite', 'cst studio', 'cst'],
    engineeringMethods: ['电磁仿真', '射频', '天线', '雷达', '微波', 'emc', 'emi'],
    competitorKeywords: ['hfss', 'altair feko', 'keysight ads'],
    blockerKeywords: ['集团统一电磁仿真', '长期许可锁定'],
  },
  {
    product: 'solidworks', displayName: 'Dassault Systèmes SolidWorks',
    positiveKeywords: ['dassault systèmes solidworks', 'solidworks', 'solid works'],
    engineeringMethods: ['通用机械设计', '设备设计', '三维建模', 'pdm'],
    competitorKeywords: ['autodesk inventor', 'inventor', 'solid edge'],
    blockerKeywords: ['集团统一 cad', '长期许可锁定'],
  },
] as const;

export const REPLACEMENT_KEYWORDS = [
  '替换', '替代', '迁移', '重新选型', '换型', '升级改造', '招标', '采购',
] as const;

export const GENERAL_BLOCKER_KEYWORDS = [
  '无预算', '预算冻结', '暂停采购', '无独立决策权', '集团统一采购',
  '经营困难', '资不抵债', '长期合同锁定', '长期许可锁定',
] as const;

export const CRITICAL_CONFLICT_KEYWORDS = [
  '法定主体', '主体归属', '同名企业', '统一社会信用代码', '关键来源冲突', '行业分类冲突',
] as const;
