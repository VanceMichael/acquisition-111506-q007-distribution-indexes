# 镜像目录收件服务：合作来源契约

唯一核准起点为`/repos/demo/InRelease`。此本地签名外壳的获取与验签由调用方已有审批提供，采集服务不得自行接受未知密钥、篡改或将未核验Release作为可信发行。Release的Suite、Codename、Date、Architectures、Components和SHA256映射共同标识发行切面。夹具只有一个Gzip索引字节串，两个架构的索引路径声明相同字节是用于样例观察，不代表一般仓库都这样分发。

每个Packages.gz先按原始字节匹配Release中的摘要和大小，再gzip解压解析Deb822段落。多行Description使用续行表示；Package、Version、Architecture、Filename、Size、SHA256需作为原字段保留。包身份不是包名：同名多版本和Architecture不同必须并存；`Architecture: all`与具体架构的适用关系属于包元数据，不能把all记录复制成多个互相独立的源包。Release更新时不能合并旧Release声明和新路径响应。

索引存在`dists/demo/main/binary-amd64/Packages.gz`与arm64等路径，发行声明的by-hash格式是`.../by-hash/SHA256/<摘要>`。来源也提供不受哈希固定的Packages.gz和不可用Packages.xz，用于说明下载失败、表示回退的证据不能默认为同一已验内容。只收索引元数据；Filename不是要求去下载的软件包。文件缓冲为合成数据，无外网依赖。

## 来源与支持范围

格式参考：`https://wiki.debian.org/DebianRepository/Format`。这里运行的是只含虚构资料的本地合作端，不是公网生产服务；只需支持本文明确给出的范围。来源实现和样例可以阅读，自动接入应使用声明的交互入口，不把服务内部对象或预先写好的采集结论当作数据来源。原始依据、结构化内容和完整性状态应能在收件端回查；新增自动接口的名称与内部设计由开发者决定。
