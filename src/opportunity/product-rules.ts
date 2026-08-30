import type { ProductKey } from '../contracts/index.js';

export type ProductRule = Readonly<{
  product: ProductKey;
  displayName: string;
  positiveKeywords: readonly string[];
  strongTargetKeywords: readonly string[];
  engineeringMethods: readonly string[];
  competitorKeywords: readonly string[];
  blockerKeywords: readonly string[];
}>;

export const PRODUCT_RULES: readonly ProductRule[] = [
  {
    product: 'windchill', displayName: 'PTC Windchill',
    positiveKeywords: ['ptc windchill', 'windchill', 'plm'],
    strongTargetKeywords: ['ptc windchill', 'windchill'],
    engineeringMethods: ['bom 变更和配置管理', 'bom', 'ebom', 'mbom', '变更管理', '配置管理', '产品生命周期', 'plm/erp'],
    competitorKeywords: ['teamcenter', 'enovia', 'ar・as innovator', 'aras innovator'],
    blockerKeywords: ['集团统一 plm', '长期许可锁定'],
  },
  {
    product: 'feigenbaum_qms', displayName: 'Feigenbaum QMS',
    positiveKeywords: ['feigenbaum qms', 'feigenbaum', 'qms', '质量管理系统'],
    strongTargetKeywords: ['feigenbaum qms', 'feigenbaum'],
    engineeringMethods: ['capa 与质量追溯', 'capa', '质量追溯', '供应商质量', '质量审计', 'iatf 16949', 'as9100', 'iso 13485'],
    competitorKeywords: ['sap qm', 'mastercontrol', 'etq reliance', 'iqs qms'],
    blockerKeywords: ['集团统一 qms', '长期许可锁定'],
  },
  {
    product: 'creo', displayName: 'PTC Creo',
    positiveKeywords: ['ptc creo', 'creo', 'pro/e', 'proe'],
    strongTargetKeywords: ['ptc creo', 'creo', 'pro/e', 'proe'],
    engineeringMethods: ['参数化建模', '参数化机械设计', '复杂零部件', '工程变更'],
    competitorKeywords: ['siemens nx', 'ug nx', 'nx', 'solid edge'],
    blockerKeywords: ['集团统一 cad', '长期许可锁定'],
  },
  {
    product: 'catia', displayName: 'Dassault Systèmes CATIA',
    positiveKeywords: ['dassault systèmes catia', 'catia', '3dexperience'],
    strongTargetKeywords: ['dassault systèmes catia', 'catia', '3dexperience'],
    engineeringMethods: ['复杂曲面与大型装配', '复杂曲面', '大型装配', '整车建模', '航空建模'],
    competitorKeywords: ['siemens nx', 'ug nx', 'nx', 'solid edge'],
    blockerKeywords: ['集团统一 cad', '长期许可锁定'],
  },
  {
    product: 'abaqus', displayName: 'Dassault Systèmes Abaqus',
    positiveKeywords: ['dassault systèmes abaqus', 'abaqus'],
    strongTargetKeywords: ['dassault systèmes abaqus', 'abaqus'],
    engineeringMethods: ['非线性有限元分析', '有限元', '非线性分析', '碰撞仿真', '疲劳仿真', '材料仿真', '多物理场'],
    competitorKeywords: ['ansys', 'ls-dyna', 'nastran', 'comsol'],
    blockerKeywords: ['集团统一 cae', '长期许可锁定'],
  },
  {
    product: 'cst', displayName: 'CST Studio Suite',
    positiveKeywords: ['cst studio suite', 'cst studio', 'cst'],
    strongTargetKeywords: ['cst studio suite', 'cst studio', 'cst'],
    engineeringMethods: ['射频天线 emc/emi 仿真', '电磁仿真', '射频', '天线', '雷达', '微波', 'emc', 'emi'],
    competitorKeywords: ['hfss', 'altair feko', 'keysight ads'],
    blockerKeywords: ['集团统一电磁仿真', '长期许可锁定'],
  },
  {
    product: 'solidworks', displayName: 'Dassault Systèmes SolidWorks',
    positiveKeywords: ['dassault systèmes solidworks', 'solidworks', 'solid works'],
    strongTargetKeywords: ['dassault systèmes solidworks', 'solidworks', 'solid works'],
    engineeringMethods: ['通用机械设计', '通用设备三维建模', '设备设计', '三维建模', 'pdm'],
    competitorKeywords: ['autodesk inventor', 'inventor', 'solid edge'],
    blockerKeywords: ['集团统一 cad', '长期许可锁定'],
  },
] as const;

export const REPLACEMENT_KEYWORDS = [
  '替换', '替代', '迁移', '切换', '改用', '迁入', '重新选型', '重选', '换型',
] as const;

export const NEGATIVE_PRODUCT_ACTION_BEFORE_PATTERN =
  /(?:不使用|未使用|无需|不需要|未开展|没有开展|暂不开展|暂不建设|不建设|未建设|尚未建设|停用|已停用|停止使用|不再使用)[\s：:]*(?:旧版|老版|原有|现有|当前)?[\s：:]*$/u;

export const NEGATIVE_PRODUCT_ACTION_AFTER_PATTERN =
  /^[\s，,：:]*(?:(?:停用|已停用|停止使用|不再使用)|(?:计划|后续|拟)(?:停用|停止使用|不再使用))(?:\s|$)/u;

export const POSITIVE_PRODUCT_ACTION_AFTER_PATTERN =
  /^[\s，,：:]*(?:已部署|已使用|正在使用|已实施)(?:\s|$)/u;

export const PRODUCT_ENUMERATION_CONNECTOR_PATTERN =
  /^(?:\s*(?:以及|和|及|或|、|，|,)\s*)+$/u;

export const NEGATIVE_BUDGET_PATTERN =
  /(?:(?:无|没有|并无|并非|不具备|不具有|缺少|暂无|未有|未获).{0,8}(?:预算|资金))|(?:(?:预算|资金).{0,6}(?:不足|不充足|未落实|未批准|冻结))/u;

export const BUDGET_NEGATION_CORRECTION_PATTERN =
  /(?:(?:并非|并不是)(?:没有|无)预算|没有预算问题|不存在预算问题)/gu;

export const NEGATIVE_DECISION_PATTERN =
  /(?:无|没有|并无|并非|并不|不具备|不具有|缺少|暂无|未有|未获).{0,12}(?:独立|自主)?.{0,8}(?:采购|决策|审批)(?:权)?/u;

export const COMPETITOR_TO_TARGET_REPLACEMENT_PATTERN =
  /^[\s，,：:、]*(?:(?:正在|计划|开始|启动|已)?(?:迁移(?:替换)?|切换|替换|替代)(?:为|到)|改用|迁入|切换到)[\s，,：:、]*$/u;

export const TARGET_REPLACEMENT_ACTION_BEFORE_PATTERN = /(?:用|以|采用|使用)[\s：:]*$/u;
export const TARGET_REPLACES_COMPETITOR_PATTERN = /^[\s，,：:、]*(?:替换|替代)[\s，,：:、]*$/u;
export const TARGET_ENTRY_ACTION_BEFORE_PATTERN = /(?:改用|切换到|迁入)[\s：:]*$/u;

export const DIRECTIONAL_POSITIVE_EXCEPTION_MARKER_PATTERN =
  /(?:不得不(?=.{0,24}(?:替换|替代|迁移|切换|改用|迁入|重新选型|重选|换型))|不久后(?=(?:计划|决定).{0,24}(?:替换|替代|迁移|切换|改用|迁入|重新选型|重选|换型))|未雨绸缪后(?=(?:计划|决定).{0,24}(?:替换|替代|迁移|切换|改用|迁入|重新选型|重选|换型)))/gu;

export const DIRECTIONAL_NEGATIVE_MARKER_PATTERN =
  /(?:拒绝|放弃|取消|暂停|停止|终止|否决|暂缓|尚未|仍未|还未|没有完成|[不未无])/u;

export const GENERAL_BLOCKER_KEYWORDS = [
  '无预算', '没有预算', '预算冻结', '暂停采购', '暂无采购计划', '无采购计划',
  '无独立决策权', '没有独立采购权', '不具备独立采购权', '集团统一采购',
  '经营困难', '资不抵债', '长期合同锁定', '长期许可锁定',
] as const;

export const CRITICAL_CONFLICT_KEYWORDS = [
  '法定主体', '主体归属', '同名企业', '统一社会信用代码', '关键来源冲突', '行业分类冲突',
] as const;
