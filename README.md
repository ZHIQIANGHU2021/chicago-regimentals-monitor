# Chicago Regimentals 无可动实枪上新监控

[![Monitor](https://github.com/ZHIQIANGHU2021/chicago-regimentals-monitor/actions/workflows/monitor.yml/badge.svg)](https://github.com/ZHIQIANGHU2021/chicago-regimentals-monitor/actions/workflows/monitor.yml)

监控日本 Chicago Regimentals 官方网站「商品一覧 → 無可動実銃」，按「発売日」倒序检查。仅用于已永久去除发射功能的收藏装饰品信息；不监控附登记证的可作动古式枪、模型或配件。

## 运行与通知

- 独立 Public 仓库，标准 `ubuntu-slim` GitHub 托管运行器。
- 全天每5分钟计划一次：UTC（日本时间分钟相同）每小时02、07、12、17、22、27、32、37、42、47、52、57分。
- GitHub 调度可能延迟或跳过，属于定时检查，不保证严格五分钟内送达。
- 首次扫描分类的全部分页，保存静默基线，不把现有商品当新品推送。之后每轮读前3页，针对新候选读取商品详情。
- 新品必须有独立商品编号、官方商品链接、含税日元价格、分店、发布日期及无可动分类证据。比基线最大编号更高、发布日期在最近14天内、首次出现的合格商品才自动通知。
- 低编号新出现条目、缺少资料或无法确认的商品进入 `needs_review`，保持静默。这种保守规则可能漏报，不能代表库存、进货量或销量。
- 每个确认新品由 `github-actions[bot]` 创建一条 Issue 并提及仓库所有者，通过 GitHub 的通知邮件投递到账号配置的 Gmail。无需 Gmail 密码、SMTP 密钥、Telegram 或额外发信服务。
- 部署测试使用明确标注的测试 Issue，不能当作实际新品。
- 无新品不发报告；异常显示为 Actions 失败，不作为“没有上新”。

## 免费范围

GitHub 标准托管运行器在 Public 仓库中免费，不扣 Private 仓库计算额度。仅上传本监控代码和公开商品去重状态，不上传邮箱地址、凭据、个人研究文件或广告数据库。不要添加大型构建产物、付费运行器或持续增长的 Actions artifacts。

官方说明（核对日期：2026-11-03）：

- [GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [运行器价格](https://docs.github.com/en/billing/reference/actions-runner-pricing)
- [计划任务限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub 邮件通知设置](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)

若以后改成 Private，应重新核算账户额度。当前 GitHub Free 每月包含 $12 共享计算额度，`ubuntu-slim` $0.002/计费分钟，各作业向上取整；全天5分钟不能保证免费。Public 仓库60天无活动时，GitHub可能停用定时任务；本程序每6小时保存真实成功检查心跳，但仍应留意 Actions 失败通知。

## 数据与可靠性

`state.json` 保存基线、已见编号、待审核候选、通知待发队列、已通知编号和最近成功检查时间。先把待发队列提交到仓库，再创建通知 Issue；即使通知后状态提交失败，下次会按 Issue 的固定标记查重，包括已关闭 Issue。

**不要删除、回退或手工重新初始化 state.json；不要删除通知 Issue。** 这会削弱永久去重。程序遇到状态丢失或损坏会报错停止，避免悄悄重建基线漏报。官网不可达、解析错误和分页不完整也会报错停止，不保存部分扫描结果。

状态及 Issue 是公开的；邮箱和账户安全设置不在仓库中。代码不会下单、预约或操作店铺账户。历史广告分析数据库不参与实时上新判断。

## 验证与维护

```console
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python watcher.py --dry-run
```

`--dry-run` 不写状态、不发通知。首次正式运行应在 Actions 日志看到 `Silent baseline:`，并有成功的状态提交。测试邮件是否送达须在 Gmail 中独立验证；单看 Issue 创建成功不能证明邮件已投递。

网站结构变动需要修订解析器。通知渠道依赖 GitHub 提及通知启用 Email，以及 GitHub 账号通知邮箱正确；禁用这些通知会停止邮件。未来如需更换频率、运行时段或邮件渠道，应修改工作流和相应设置。
