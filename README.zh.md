# dsh-round-inject

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 提供的**周期性提示词注入**插件。

每 N 次**模型调用**(对话轮与工具调用轮各计一次)注入一次用户配置的提示词,作为模型可见、带来源标记的用户消息进入上下文;**每次对话开始默认注入一次**。

| | |
| --- | --- |
| Host | `agent/pre-step` 瀑布(统计每个真正进入的 step,并把注入消息追加到该 step 的请求) |
| Client | 设置面板:两个输入框 + 触发轮次(默认 **50**) |
| 配置 | `round-inject` 设置命名空间,由 DSH 设置提供方持久化 |

## 功能

- **轮次统计** —— 每次模型调用计 1 次,包括工具结果触发的下一步(工具调用后模型会再次被调用 = 又一个 step)。计数器按 agent 隔离(主会话与子代理互不影响)。
- **周期注入** —— 距上次注入恰好满 `interval` 个已完成模型调用后,把配置的提示词追加到那一步的消息中(默认 **50**):开启开始注入时,注入发生在会话的第 1、1+interval、1+2·interval… 次调用;关闭时发生在第 interval、2·interval、3·interval… 次调用。注入消息携带 `source: { kind: 'plugin', plugin: 'round-inject' }`,写入会话日志,模型可见。
- **对话开始注入** —— 开启且填了开始提示词时,会话的**第一次**模型调用即携带开始提示词,周期计数随后从这次调用重新起算。
- **设置界面** —— 设置 → **提示词注入**:启用开关、触发轮次(数字输入,默认 50)、注入提示词(多行输入框)、对话开始时注入开关。写入通过标准 `settingsScope` 服务落到 `round-inject` 命名空间(持久化到 DSH 设置文档)。
- **默认安全** —— 提示词为空 ⇒ 不注入;关闭 ⇒ 不计数也不注入;不真正调用模型的 step 不会被计数。

## 安装

本包是发布到 npm 的 DSH 插件。在 DSH profile 目录执行:

```sh
dsh plugin --profile web add dsh-round-inject
```

或手动把依赖加入 profile 的 `package.json`,并把 `"dsh-round-inject"` 追加到 `dsh.profile.bundles`,然后重启 profile。

### 配置

组合行(同时也是设置命名空间的 base 层):

```yaml
- id: round-inject
  name: 'dsh-round-inject'
  config:
    enabled: true        # 总开关
    interval: 50         # 两次注入之间的模型调用次数
    prompt: ''           # 注入的提示词文本(为空则不注入)
    injectOnStart: true  # 每次对话开始注入一次
```

所有值都可以在 设置 → 提示词注入 中实时修改,无需重启。

## 工作原理

宿主在 `sessionProjections` 接缝上注册**一个**纯 fold,并在 `agent/pre-step` 瀑布上执行注入:

1. **计数与书签共用一个 fold** —— `round-inject` 投影是对会话事件流的纯折叠,只消费内置事件、从不追加自定义事件类型,因此恢复会话永远不会因本插件的词汇失败:
   - 每个 `step/end`(一次完成的模型调用,与内置 "N 轮 · M 步" 统计同一事件)推进 `totalSteps`,并在会话注入过之后推进 `sinceInject`(距上次注入消息已完成的调用数);
   - 一条由本插件追加的 `user/message`(以其 `source: { kind: 'plugin', plugin: 'round-inject' }` 识别)记录 `lastInjectSeq` 并把 `sinceInject` 归零。
   注册表把状态检查点到 `<root>/session_projcache/`,因此计数与书签都扛得住压缩、翻页、会话恢复与宿主重启。书签放在这份**派生状态**里(而不是 0.1.11 会跨会话泄漏的设置命名空间,也不是 0.1.13 中不存在的 `session.events` —— 后者让每一步都崩溃),使间隔**精确**:每个事件 O(1) 折叠,绝不每步全量扫描日志。
2. **注入(副作用)** —— 监听 `agent/pre-step` 瀑布(每个拟议 step 一次)。在 `next()` 返回 loop 自身决策后:
   - 忽略 `reject` 决策与空消息 step(这些不会调用模型);
   - 从 `round-inject` 命名空间读取最新配置;
   - 读取投影状态(`totalSteps` / `sinceInject` / `lastInjectSeq`)并判定:
     - 本会话从未注入且开启开始注入 → 把开始提示词追加到**第一次**模型调用;
     - 从未注入且无开始提示词 → 把周期提示词追加到会话第 `interval` 次调用;
     - 否则当 `sinceInject >= interval` → 把周期提示词追加到下一次模型调用 —— 正好在上次注入之后 `interval` 步;
   - 整个判定有防护:任何意外错误只记 warning 并放行该步(不注入),插件永远无法拖垮一轮 agent 运行。
   注入消息作为 `createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'round-inject' } })` 追加,成为该步持久化用户消息的一部分 —— 模型可见、会话日志可审计,并适用于任何模型路由。

### KV cache 说明

注入会改变注入 step 的请求内容,因此从该请求起 provider KV/prefix cache 会失效一个回合的若干 step。默认 50 轮时影响可忽略;调小轮次会增加失效频率。

## 更新历史

- **0.1.14** —— 修复 "session.events is not iterable"(每轮运行失败):书签扫描误用了 `session.events`(会话对象上不存在的属性,公共接口是 `session.snapshotEvents()`)。书签现移入投影状态(派生、每事件 O(1)、可持久化),判定全程有防护,内部错误不再拖垮整轮。注入时机精确:开启开始注入时,注入发生在会话第 1、1+interval、1+2·interval… 次调用;关闭时在第 interval、2·interval、3·interval… 次调用(不再 ±1 漂移)。默认触发轮次从 80 调整为 50。

## 故障排查

### DSH 共享宿主包声明为 peerDependencies(0.1.6)

插件把全部 DSH 提供的运行时包(`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`)声明为 `peerDependencies`,**而非** `dependencies`。DSH 通过共享宿主包目录(`~/.dsh/profiles/node_modules/@deepseek-ai/`)以符号链接指向宿主精确版本,插件必须经宿主解析这些包,不能自装副本。

0.1.6 之前插件把 `dsh-llm` 放在 `dependencies`,导致 pnpm 把独立的 `dsh-llm@0.1.0-rc.8` 提升到 profile 根目录。Node 解析会优先命中这份副本而非宿主的共享符号链接,于是插件与宿主跑在**不同的 `dsh-llm` 实例**上(宿主为 `0.1.1-rc.2`)。两个版本的 `createUserMessage` 签名恰好一致所以能跑,但任何 API 漂移都会静默出错。判断方法:在 profile 下执行 `require.resolve('@deepseek-ai/dsh-llm/package.json')`,若解析到 `profiles/web/node_modules/...` 而非宿主安装路径即为被遮蔽。更新到 0.1.6 后在 profile 里重装以清理旧副本:

```sh
cd ~/.dsh/profiles/web
pnpm add "dsh-round-inject@0.1.6"   # 清理旧的提升副本
node -p "require.resolve('@deepseek-ai/dsh-llm/package.json')"  # 应指向宿主路径,而非 profiles/web/node_modules
```

### "设置服务不可用" / 设置项不可编辑 / 命名空间缺失

## 开发

```
├── index.js       # Host 半端(ESM;设置注册 + session-start 重置 + pre-step 计数/注入)
├── client.js      # 浏览器半端(设置页面;__ModuleLoader__.load 工厂,无构建步骤)
├── cordis.patch.yml
└── package.json
```

无需构建 —— 两个半端均为手写 ESM / 浏览器工厂(与 `dsh-strata` 同模式)。发布:

```sh
npm publish
```

## License

MIT
