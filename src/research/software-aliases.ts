import type { ProductKey } from './contracts.js';
export const SOFTWARE_ALIASES_VERSION = 'software-aliases@1';
export const SOFTWARE_ALIASES: ReadonlyArray<{ product: ProductKey; name: string; category: 'CAD' | 'CAE' | 'PLM' | 'QMS'; aliases: readonly string[] }> = [
  { product: 'windchill', name: 'Windchill', category: 'PLM', aliases: ['PTC Windchill', 'Windchill', '温彻尔'] },
  { product: 'feigenbaum_qms', name: 'Feigenbaum QMS', category: 'QMS', aliases: ['Feigenbaum QMS', '菲根鲍姆', '费根堡', '费根鲍姆'] },
  { product: 'creo', name: 'Creo', category: 'CAD', aliases: ['PTC Creo', 'Creo', 'Pro/ENGINEER', 'Pro/E', 'ProE'] },
  { product: 'catia', name: 'CATIA', category: 'CAD', aliases: ['CATIA', '卡提亚'] },
  { product: 'abaqus', name: 'Abaqus', category: 'CAE', aliases: ['SIMULIA Abaqus', 'Abaqus', '阿巴克斯'] },
  { product: 'cst', name: 'CST Studio Suite', category: 'CAE', aliases: ['CST Studio Suite', 'CST', 'CST工作室套件'] },
  { product: 'solidworks', name: 'SolidWorks', category: 'CAD', aliases: ['SOLIDWORKS', 'Solid Works', '索利德沃克斯'] },
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Candidate names only: aliases do not establish equivalence, ownership or actual use. */
export function findSoftwareAliases(text: string) {
  return SOFTWARE_ALIASES.flatMap(entry => {
    const alias = entry.aliases.find(value => new RegExp(`(?<![A-Za-z0-9_])${escape(value)}(?![A-Za-z0-9_])`, 'iu').test(text));
    return alias ? [{ product: entry.product, name: entry.name, category: entry.category, matched_alias: alias }] : [];
  });
}
