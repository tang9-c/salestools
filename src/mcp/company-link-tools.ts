import type { McpServer } from '@modelcontextprotocol/server';
import type { CompanyLinkService } from '../companies/company-link.js';
import { CompanyLinkSchema, LinkCompanyInputSchema } from '../contracts/company-context.js';
export function registerCompanyLinkTools(server:McpServer,links:Pick<CompanyLinkService,'change'>):void {
  server.registerTool('link_company',{
    description:'确认或解除组织与已有企业画像的关联；需要版本、审核说明和稳定操作 ID。',
    inputSchema:LinkCompanyInputSchema,outputSchema:CompanyLinkSchema,
  },async(input,context)=>{
    const actor=context.http?.authInfo?.clientId;
    if(!actor)throw new Error('Authenticated client is required');
    const result=CompanyLinkSchema.parse(await links.change(input,actor));
    return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
  });
}
