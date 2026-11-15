# MultiChain Swap Desktop

适用于 Ethereum、BNB Smart Chain 和 Base 的 Electron 兑换桌面端。 当前版本 0.7.5。

默认部署重写版多交易所执行器和报价合约。应用校验执行器字节码、网络及交易所配置；历史执行器可继续读取，也可通过独立的取回入口操作。

## 开发与构建

使用 Node.js 24、npm 和 Electron 44.5.1。

```powershell
npm ci
npm test
npm run smoke
npm run dist:win
```

源码位于 `src/` 和 `renderer/`。Windows x64 安装包生成在 `dist/`。启动检查使用独立的测试配置。

## 合约源码与兼容性

本工程包含对应执行器及报价合约的 Solidity 源码。运行 `npm run build:contracts` 可用 Solidity 0.8.36 重编译 `artifacts/Rebuilt*.json`。合约源码来自版本固定的独立仓库。 [合约提交 4161a3c](https://github.com/wwin57519-lgtm/multichain-desktop-contracts/tree/4161a3c70b059457596ffc35b2060808581d7a1b)

执行器重写版编号为 0.1.0。历史合约的 ABI 和字节码作为兼容性产物保留。新合约部署使用独立地址，已有合约可按其原身份加载。

## 许可

项目采用 [MIT 许可证](LICENSE)。第三方许可和归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
