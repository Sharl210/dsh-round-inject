# dsh-round-inject

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 提供的**周期性提示词注入**插件。

每 N 次**模型调用**(对话轮与工具调用轮各计一次)注入一次用户配置的提示词,作为模型可见、带来源标记的用户消息进入上下文;**每次对话开始默认注入一次**。

| | |
| --- | --- |
| Host | `agent/pre-step` 瀑布(统计每个真正进入的 step,并把注入消息追加到该 step 的请求) |
| Client | 设置面板:输入框 + 触发轮次(默认 **80**) |
| 配置 | `round-inject` 设置命名空间,由 DSH 设置提供方持久化 |

## 功能

- **轮次统计** —— 每次模型调用计 1 次,包括工具结果触发的下一步(工具调用后模型会再次被调用 = 又一个 step)。计数器按 agent 隔离(主会话与子代理互不影响)。
- **周期注入** —— 计数达到配置的轮次(默认 80)时,把配置的提示词追加到该步消息中。注入消息携带 `source: { kind: 'plugin', plugin: 'round-inject' }`,写入会话日志,模型可见。
- **对话开始注入** —— 每次新对话立即注入一次(不计入轮次),随后重新开始计数。
- **设置界面** —— 设置 → **提示词注入**:启用开关、触发轮次(数字输入,默认 80)、注入提示词(多行输入框)、对话开始时注入开关。写入通过标准 `settingsScope` 服务落到 `round-inject` 命名空间(持久化到 DSH 设置文档)。
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
    interval: 80         # 两次注入之间的模型调用次数
    prompt: ''           # 注入的提示词文本(为空则不注入)
    injectOnStart: true  # 每次对话开始注入一次
```

所有值都可以在 设置 → 提示词注入 中实时修改,无需重启。

## 工作原理

插件监听 `agent/pre-step` 瀑布(每个拟议 step = 一次模型调用)。在 `next()` 返回 loop 自身决策后:

1. 忽略 `reject` 决策与空消息 step(这些不会调用模型);
2. 从 `round-inject` 命名空间读取最新配置;
3. 计数:对话第一步在 `injectOnStart` 开启时注入一次;之后每个进入的 step 计数,达到 `interval` 时触发;
4. 触发时向该步消息追加 `createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'round-inject' } })`。

注入消息成为该步持久化用户消息的一部分,因此模型可见、会话日志可审计,并适用于任何模型路由。

### KV cache 说明

注入会改变注入 step 的请求内容,因此从该请求起 provider KV/prefix cache 会失效一个回合的若干 step。默认 80 轮时影响可忽略;调小轮次会增加失效频率。

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
