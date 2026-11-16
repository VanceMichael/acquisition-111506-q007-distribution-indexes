# 镜像目录收件服务

这个服务保存包索引条目的人工收件、历史版本和原始依据。重复提交相同业务内容与依据返回原收件；内容变化形成历史版本，原始字节用内容摘要回查。合作来源运行在本机，具体交互见 `docs/source-contract.md`。自动采集从调用方已核准的发行描述出发，见下文「自动采集」。

## 运行环境

需要 Node.js 22.22.1 至 22.x，使用内置模块，没有第三方依赖。依赖锁文件随代码保存；`npm ci --offline --ignore-scripts --no-audit --no-fund` 不会下载包。数据目录默认是 `var`，可用 `DATA_DIR` 指定；不可让两个进程同时写同一目录。来源和收件服务默认只监听回环地址，不使用真实机构账号或外网数据。

## 开发与运行

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run demo
```

`npm start` 启动收件服务，默认端口4310；另一终端用 `npm run source` 启动来源端，默认端口4311。可分别通过 `PORT`、`SOURCE_PORT` 修改端口。测试和演示使用系统分配的端口，结束时关闭服务并删除临时收件数据，不需要固定等待时间。

## 已有收件接口

`GET /health` 查看状态；`POST /api/manual` 接收 `record` 和 `evidence`。业务内容需要 `packageId, package, version, architecture`，其中 `packageId` 是已有人工收件标识。每份依据包含来源 `source`、原始字节 `bytesBase64`，可选 `mediaType` 和需要核对的 `sha256`。`GET /api/records` 返回当前版本，`GET /api/history?key=...` 返回单个业务标识的历史，`GET /api/evidence/摘要` 返回原始字节。人工入口不推断自动采集是否完整；新增来源接入可以扩展领域状态，但应保留这些已用接口。

`fixtures/manual.json` 是可用的人工收件样例。`npm run demo` 实际启动本地服务，执行人工提交、重复收件、原始依据回查，以及从核准发行描述出发的自动采集、过期与篡改拒绝、by-hash 回退；全程本地，不用外部网络。

## 自动采集

`POST /api/collect` 从已核准的发行描述出发采集索引元数据，请求体：

```json
{
  "release": { "source": "approval:ops-2026-11-16", "bytesBase64": "<Release原文>", "sha256": "可选核准摘要" },
  "indexBase": "http://127.0.0.1:4311/dists/demo"
}
```

信任边界：发行描述的获取与验签由调用方在既有审批边界内完成，服务不获取发行描述、不接受密钥、不把未核验的Release当作可信发行；`source` 是该次核准的来源标识，`sha256` 可钉住核准的字节。服务只从发行描述出发，按其中的 SHA256+大小声明逐条验证索引：优先 `by-hash/SHA256/<摘要>` 固定路径，暂时缺失时回退普通路径或发行声明的其他压缩表示（当前支持 gzip 与未压缩），回退拿到的字节仍必须命中发行声明，否则整个发行被拒绝。过期（Valid-Until）或任何校验失败的发行不进入正式结果——全部组件×架构取齐并验证通过后才一次性入库，不产生半个发行的混合目录。

每条包记录绑定发行描述（Suite、Codename、Date、发行摘要）、组件和架构，并保留可追溯的索引原文（发行描述、索引原始字节与解压文本都作为依据，经 `GET /api/evidence/摘要` 回查）。包身份是组件+包名+版本+架构：同名多版本、不同架构并存；`Architecture: all` 只保留一条记录，与具体架构的适用关系记在 `appliesTo`。另有一条 `collection:<发行摘要>` 完整性记录汇总本次采集的口径。相同发行重复采集幂等；发行更新形成历史版本。只采索引元数据，不下载或安装 `Filename` 指向的软件包。

## 容器

```sh
docker build -t distribution-indexes-intake .
docker run --rm --network none distribution-indexes-intake npm test
docker run --rm --network none distribution-indexes-intake npm run demo
```

镜像内容由 Dockerfile 的 SHA256 摘要固定；Node.js 22 主版本标签与 package.json 的 >=22.22.1 <23 兼容范围对应，验证环境可使用该范围内的补丁版本。构建需要本地已有该基础镜像；正式运行、测试和演示不安装系统包、不下载模型或数据。服务默认数据放在容器内临时目录，持久运行时可挂载单独卷。演示完整输出可在90秒内展示，不播放预先保存的日志。
