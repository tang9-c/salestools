from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4
from pypdf import PdfReader
import hashlib,json
fonts=[('Heiti','/System/Library/Fonts/STHeiti Medium.ttc'),('Songti','/System/Library/Fonts/Supplemental/Songti.ttc'),('ArialUnicode','/System/Library/Fonts/Supplemental/Arial Unicode.ttf')]
for name,path in fonts: pdfmetrics.registerFont(TTFont(name,path,subfontIndex=0))
pages=[('个人简介与教育背景',[
('陈明远｜高级平台工程师','本简历仅用于系统测试。人物、学校、雇主和项目均为虚构。电子邮箱：mingyuan.chen@example.com。所在地：示例市。'),
('职业概述','具有八年平台工程与系统运维经验，负责内部开发平台建设、Linux 服务运行维护及基础设施自动化。工作重点包括发布可靠性、监控告警、数据库维护与故障恢复。'),
('专业技能','Linux、Python、Bash、Git、Docker、Kubernetes、Terraform、Ansible、PostgreSQL、MySQL、Redis、Nginx、Prometheus、Grafana、Jenkins、持续集成与自动化部署。'),
('教育经历','示例理工大学，计算机科学与技术专业，本科学历。就读时间：2012年9月至2016年6月。主要课程：操作系统、计算机网络、数据库原理、软件工程。'),
('工作方法','维护应急操作手册和服务依赖文档，与应用团队共同评审基础设施变更。依据实际容量数据安排升级，在正式发布前验证备份恢复及回滚流程。')]),
('工作经历',[
('高级平台工程师｜示例北方科技有限公司','2023年1月至2026年9月。建设内部服务部署模板，维护 Kubernetes 集群及监控系统。组织故障复盘，完善恢复文档，与开发团队共同制定发布检查清单。'),
('可靠性工程师｜示例西部实验室有限公司','2020年7月至2022年12月。使用 Ansible 自动化配置 Linux 主机，管理 PostgreSQL 备份并定期执行恢复演练。开发 Python 服务检查工具。'),
('系统工程师｜示例东方软件有限公司','2018年7月至2020年6月。维护容器化应用，建设持续集成流程与发布审批机制。利用指标和日志分析应用延迟，跟踪故障处理结果。'),
('初级运维工程师｜示例南方服务有限公司','2016年7月至2018年6月。维护 Linux 主机和 Nginx 配置，协助数据库维护及故障响应，将常见操作整理为可重复执行的文档。')]),
('项目经历：平台建设',[]),('项目经历：可靠性提升',[]),('项目经历：自动化与文档',[])]
projects=[('内部部署平台','示例北方科技有限公司','使用 Kubernetes、Docker 和 Git 建设可复用的部署模板和发布检查机制，协助应用接入，编写回滚操作说明。'),('统一监控平台','示例北方科技有限公司','配置 Prometheus 指标采集规则及 Grafana 仪表盘，制定可操作的告警规则，在故障复盘后调整告警。'),('数据库恢复演练','示例西部实验室有限公司','自动化 PostgreSQL 备份和周期性恢复测试，记录恢复耗时，核对数据完整性与应用访问结果。'),('主机配置管理','示例西部实验室有限公司','编写 Ansible 配置角色，通过代码评审与分批发布减少环境配置差异，记录变更影响范围。'),('应用容器迁移','示例东方软件有限公司','将内部服务迁移到 Docker 容器，记录资源需求，验证网络访问及持久化数据行为。'),('持续交付流水线','示例东方软件有限公司','使用 Jenkins 实现测试、产物管理及发布审批，为开发人员提供清晰的失败报告。'),('服务健康检查','示例南方服务有限公司','编写 Python 端点检查脚本和定期运维报告，设置明确的超时时间及有限重试次数。'),('日志分析工具','示例南方服务有限公司','编写 Bash 工具汇总运维日志，整理故障排查流程，不保留敏感应用数据。'),('服务容量评估','示例北方科技有限公司','测量代表性工作负载的 CPU 和内存使用情况，编写容量报告，在受控负载下验证运行行为。'),('开发者使用文档','示例北方科技有限公司','为内部平台用户编写接入指南和示例，与新成员共同试用并修正含糊的操作步骤。')]
for i,(name,org,body) in enumerate(projects):pages[2+min(i//4,2)][1].append((name,f'所属公司：{org}。职责：实施与运行维护。{body}'))
w,h=A4;out='output/pdf/synthetic-chinese-multifont-resume-five-pages.pdf';c=canvas.Canvas(out,pagesize=A4);c.setTitle('中文多字体合成简历 - 陈明远')
def lines(text,font,size,width):
 result=[];line=''
 for ch in text:
  if pdfmetrics.stringWidth(line+ch,font,size)>width:result.append(line);line=ch
  else:line+=ch
 if line:result.append(line)
 return result
for n,(title,sections) in enumerate(pages,1):
 c.setFillColorRGB(.1,.2,.32);c.setFont('Heiti',21);c.drawString(48,h-55,title)
 c.setFont('ArialUnicode',10);c.drawString(48,h-78,'陈明远 / 中文多字体合成简历 / 黑体、宋体、Arial Unicode')
 y=h-115
 for i,(heading,body) in enumerate(sections):
  c.setFillColorRGB(.1,.2,.32);c.setFont('Heiti',12)
  for line in lines(heading,'Heiti',12,w-96):c.drawString(48,y,line);y-=18
  font=['Songti','ArialUnicode','Heiti'][i%3];c.setFillColorRGB(.18,.18,.18);c.setFont(font,11)
  for line in lines(body,font,11,w-96):c.drawString(48,y,line);y-=18
  y-=23
 assert y>60,(n,y)
 c.setStrokeColorRGB(.8,.83,.86);c.line(48,48,w-48,48);c.setFont('ArialUnicode',9);c.drawString(48,32,'虚构测试数据，不代表真实求职者');c.drawRightString(w-48,32,f'{n} / 5');c.showPage()
c.save();r=PdfReader(out);assert len(r.pages)==5
texts=[p.extract_text() for p in r.pages];assert all('虚构测试数据' in t for t in texts);assert '陈明远' in texts[0]
print(json.dumps({'pages':len(r.pages),'characters':[len(t) for t in texts],'sha256':hashlib.sha256(open(out,'rb').read()).hexdigest()}))
