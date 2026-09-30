# 数据中心变更窗口与回滚方案审阅平台

面向机房运维、系统、安全和业务负责人的生产变更审阅工作台。工程使用 Angular CLI 独立构建，所有变更记录会写入浏览器 `localStorage`，首次运行通过 `HttpClient` 加载 `public/mock/change-requests.json`。

## 技术栈

- Angular 22 + Angular CLI + TypeScript
- Clarity Angular 18 + Clarity UI
- NgRx Store + Effects
- Angular Router + HttpClient
- RxJS

## 功能

- 变更列表搜索，以及按状态、资源类型和风险等级筛选
- 新建变更方案，维护资源、依赖、执行步骤、回滚步骤、值守人员和窗口
- 依赖关系图与共享资源窗口甘特图
- 依赖遗漏、窗口冲突、回滚不可执行、关键服务观察窗口不足校验
- 网络、系统、安全、业务负责人顺序会签
- 执行步骤勾选、实时日志入口、执行偏离记录、完成或回滚判定
- 可接续的执行检查点账本：
  - 开始执行时冻结方案、顺序会签和回滚步骤，执行中禁止编辑方案
  - 步骤、偏离和终态以同一检查点（幂等 token）追加，重复上报只记一次
  - 回滚先到后晚到的完成提交留「终态冲突」并说明原因，不覆盖先到终态
  - 整包快照先写暂存键再提升为主键；写入失败保留最后完整检查点，未确认条目进入待重做队列（独立存储，刷新可恢复），工作台与详情页提示重做
  - 工作台与执行页提供「模拟写入故障」开关，便于演示中断恢复
- 审批冻结、审计轨迹和复盘 Markdown 导出
- 基于 NgRx 的状态流转与 localStorage 持久化

## 运行

```bash
npm install
npm start
```

默认开发地址为 `http://localhost:18469`。

生产构建：

```bash
npm run build
```

构建输出位于 `dist/pair-wise-gsb-69/browser`。

## 目录

```text
src/app/
  components/             依赖图、甘特图、校验、审计组件
  models/                 领域模型和校验规则
  pages/                  列表、新建、详情工作区
  services/               HttpClient 数据加载、localStorage、复盘导出
  store/                  NgRx actions、reducer、effects、selectors
```
